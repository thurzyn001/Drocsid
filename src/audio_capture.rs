//! Captura nativa de áudio do sistema (WASAPI Loopback no Windows) com reamostragem limpa via `rubato`
//! e codificação G.711 μ-law para entrega em tempo real junto ao Motor Nativo (`NativeHost`).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub const WASAPI_TARGET_SAMPLE_RATE: u32 = 24_000;
pub const WASAPI_CHUNK_SAMPLES: usize = 480; // 20 ms a 24 kHz

/// Converte amostra PCM linear normalizada (`-1.0..=1.0`) em G.711 μ-law (8 bits).
pub fn linear_to_mulaw(sample: f32) -> u8 {
    let clamped = sample.clamp(-1.0, 1.0);
    let mut pcm = (clamped * 32767.0) as i32;
    let sign = if pcm < 0 {
        pcm = -pcm;
        0x80u8
    } else {
        0x00u8
    };
    if pcm > 32635 {
        pcm = 32635;
    }
    pcm += 0x84;

    let mut exponent = 7i32;
    let mut exp_mask = 0x4000i32;
    while exponent > 0 && (pcm & exp_mask) == 0 {
        exponent -= 1;
        exp_mask >>= 1;
    }
    let mantissa = (pcm >> (exponent + 3)) & 0x0f;
    !(sign | ((exponent as u8) << 4) | (mantissa as u8))
}

/// Faz downmix de bytes PCM interleaved (`f32` ou `i16`) para mono `f32`.
pub fn downmix_interleaved_to_mono(
    bytes: &[u8],
    channels: usize,
    bits_per_sample: u16,
    is_float: bool,
) -> Vec<f32> {
    let ch = channels.max(1);
    if is_float && bits_per_sample == 32 {
        let frame_bytes = ch * 4;
        let frames = bytes.len() / frame_bytes;
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let base = f * frame_bytes;
            let mut sum = 0.0f32;
            for c in 0..ch {
                let off = base + c * 4;
                let s = f32::from_le_bytes([
                    bytes[off],
                    bytes[off + 1],
                    bytes[off + 2],
                    bytes[off + 3],
                ]);
                sum += s;
            }
            out.push((sum / ch as f32).clamp(-1.0, 1.0));
        }
        return out;
    }

    if !is_float && bits_per_sample == 16 {
        let frame_bytes = ch * 2;
        let frames = bytes.len() / frame_bytes;
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let base = f * frame_bytes;
            let mut sum = 0.0f32;
            for c in 0..ch {
                let off = base + c * 2;
                let s = i16::from_le_bytes([bytes[off], bytes[off + 1]]) as f32 / 32768.0;
                sum += s;
            }
            out.push((sum / ch as f32).clamp(-1.0, 1.0));
        }
        return out;
    }

    Vec::new()
}

/// Inicia uma thread dedicada para capturar áudio do dispositivo padrão de reprodução no Windows
/// (WASAPI Loopback), reamostrar para 24 kHz via `rubato` e despachar chunks μ-law de 20 ms.
#[cfg(windows)]
pub fn start_wasapi_loopback_thread(
    stop_flag: Arc<AtomicBool>,
    chunk_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        if let Err(err) = run_wasapi_loopback_loop(&stop_flag, &chunk_tx) {
            tracing::warn!("WASAPI Loopback encerrado: {err}");
        }
    })
}

#[cfg(not(windows))]
pub fn start_wasapi_loopback_thread(
    _stop_flag: Arc<AtomicBool>,
    _chunk_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(|| {})
}

#[cfg(windows)]
fn run_wasapi_loopback_loop(
    stop_flag: &AtomicBool,
    chunk_tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    use rubato::{FftFixedInOut, Resampler};
    use std::collections::VecDeque;
    use wasapi::{initialize_mta, Direction, SampleType, ShareMode, WaveFormat};

    if let Err(e) = initialize_mta().ok() {
        tracing::debug!("initialize_mta WASAPI: {e:?}");
    }

    let device = wasapi::get_default_device(&Direction::Render)
        .map_err(|e| format!("dispositivo de áudio padrão indisponível: {e:?}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("get_iaudioclient: {e:?}"))?;

    let mix_fmt = audio_client
        .get_mixformat()
        .map_err(|e| format!("get_mixformat: {e:?}"))?;
    let mix_rate = mix_fmt.get_samplespersec().max(8000);
    let (_def_period, min_period) = audio_client.get_periods().unwrap_or((100_000, 100_000));

    // Solicita mono float na taxa nativa do mixer com autoconversão do WASAPI, evitando mismatch multicanal (5.1/7.1)
    let desired_fmt = WaveFormat::new(32, 32, &SampleType::Float, mix_rate as usize, 1, None);
    let block_align = desired_fmt.get_blockalign() as usize;

    audio_client
        .initialize_client(
            &desired_fmt,
            min_period.max(100_000),
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        )
        .map_err(|e| format!("initialize_client loopback: {e:?}"))?;

    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("set_get_eventhandle: {e:?}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("get_audiocaptureclient: {e:?}"))?;

    let mut resampler = if mix_rate != WASAPI_TARGET_SAMPLE_RATE {
        Some(
            FftFixedInOut::<f32>::new(
                mix_rate as usize,
                WASAPI_TARGET_SAMPLE_RATE as usize,
                (mix_rate as usize / 50).max(256),
                1,
            )
            .map_err(|e| format!("rubato resampler init: {e:?}"))?,
        )
    } else {
        None
    };

    let mut raw_queue: VecDeque<u8> = VecDeque::with_capacity(block_align * 8192);
    let mut resampled_fifo: VecDeque<f32> = VecDeque::with_capacity(WASAPI_CHUNK_SAMPLES * 8);
    let mut out_fifo: VecDeque<f32> = VecDeque::with_capacity(WASAPI_CHUNK_SAMPLES * 4);
    let mut tmp_in: Vec<f32> = Vec::with_capacity(4096);

    audio_client
        .start_stream()
        .map_err(|e| format!("start_stream loopback: {e:?}"))?;

    while !stop_flag.load(Ordering::Relaxed) {
        // Loopback em Shared Mode não dispara evento durante silêncio absoluto; timeout curto mantém responsividade.
        let _ = h_event.wait_for_event(35);
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        if let Err(e) = capture_client.read_from_device_to_deque(&mut raw_queue) {
            let _ = audio_client.stop_stream();
            return Err(format!("read_from_device_to_deque: {e:?}"));
        }

        let avail_frames = raw_queue.len() / block_align;
        if avail_frames == 0 {
            continue;
        }

        let byte_count = avail_frames * block_align;
        let mut frame_bytes = Vec::with_capacity(byte_count);
        for _ in 0..byte_count {
            if let Some(b) = raw_queue.pop_front() {
                frame_bytes.push(b);
            }
        }
        let mono = downmix_interleaved_to_mono(&frame_bytes, 1, 32, true);

        if let Some(ref mut rs) = resampler {
            resampled_fifo.extend(mono);
            loop {
                let needed = rs.input_frames_next();
                if resampled_fifo.len() < needed {
                    break;
                }
                tmp_in.clear();
                for _ in 0..needed {
                    if let Some(s) = resampled_fifo.pop_front() {
                        tmp_in.push(s);
                    }
                }
                if let Ok(out) = rs.process(&[&tmp_in], None) {
                    if let Some(ch0) = out.first() {
                        emit_mulaw_chunks_from_deque(&mut out_fifo, ch0, chunk_tx);
                    }
                }
            }
        } else {
            emit_mulaw_chunks_from_deque(&mut out_fifo, &mono, chunk_tx);
        }

        // Evita crescimento ilimitado se houver burst atrasado
        if raw_queue.len() > block_align * mix_rate as usize {
            raw_queue.clear();
        }
        if resampled_fifo.len() > mix_rate as usize {
            resampled_fifo.clear();
        }
        if out_fifo.len() > WASAPI_TARGET_SAMPLE_RATE as usize {
            out_fifo.clear();
        }
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

#[cfg(windows)]
fn emit_mulaw_chunks_from_deque(
    fifo: &mut std::collections::VecDeque<f32>,
    samples: &[f32],
    chunk_tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
) {
    fifo.extend(samples.iter().copied());
    while fifo.len() >= WASAPI_CHUNK_SAMPLES {
        let mut sq = 0.0f32;
        let mut mulaw = Vec::with_capacity(WASAPI_CHUNK_SAMPLES);
        for _ in 0..WASAPI_CHUNK_SAMPLES {
            let s = fifo.pop_front().unwrap_or(0.0);
            sq += s * s;
            mulaw.push(linear_to_mulaw(s));
        }
        let rms = (sq / WASAPI_CHUNK_SAMPLES as f32).sqrt();
        if rms > 0.00025 {
            let _ = chunk_tx.try_send(mulaw);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulaw_silencio_e_pico() {
        let z = linear_to_mulaw(0.0);
        assert!(z == 0x7f || z == 0xff);
        assert_ne!(linear_to_mulaw(0.8), linear_to_mulaw(-0.8));
    }

    #[test]
    fn downmix_stereo_float_para_mono() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&0.5f32.to_le_bytes());
        raw.extend_from_slice(&(-0.5f32).to_le_bytes());
        raw.extend_from_slice(&0.8f32.to_le_bytes());
        raw.extend_from_slice(&0.4f32.to_le_bytes());
        let mono = downmix_interleaved_to_mono(&raw, 2, 32, true);
        assert_eq!(mono.len(), 2);
        assert!(mono[0].abs() < 1e-5);
        assert!((mono[1] - 0.6).abs() < 1e-5);
    }
}
