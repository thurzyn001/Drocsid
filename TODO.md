# Drocsid — Roadmap & Todo de Melhorias (`v0.4+`)

Baseado na auditoria da base atual (`v0.3.0`) em [`ARCHITECTURE.md`](ARCHITECTURE.md), [`README.md`](README.md), [`Cargo.toml`](Cargo.toml), [`src/`](src) e [`installer/DrocsidSetup.cs`](installer/DrocsidSetup.cs).

> [!NOTE]
> Todas as propostas abaixo preservam os invariantes definidos em [`AGENTS.md`](AGENTS.md): binário único offline no Windows (`drocsid.exe`), compatibilidade dos protocolos existentes (`DVP\x01`/`DVF\x01`, `DAP\x01`/`DAF\x01`), segurança (`host_token`/`room_key`) e layout responsivo desktop + mobile (`<= 900px`).

---

## Baseline Atual Concluído (`v0.3.0`)

- [x] Chat em tempo real com histórico persistido (`chat_history.json`), envio de prints (`Ctrl+V`) e Markdown leve
- [x] Voz WebRTC P2P com *Perfect Negotiation* + Relay automático anti-CGNAT (`DAP\x01`/`DAF\x01` μ-law 16 kHz)
- [x] Go Live em 3 motores: WebRTC P2P/TURN, Relay Universal (`DVP\x01`/`DVF\x01`) e Motor Nativo Rust GDI (`GetScreenPreviews`)
- [x] Segurança (`host_token`, `room_key` persistidos em `secrets.json`, rotação de chave e validação antes do `/ws`)
- [x] Túnel público automático (`cloudflared.exe` / OpenSSH `localhost.run`), System Tray Win32, esquema `drocsid://` e instalador [`dist/Drocsid-Setup.exe`](dist/Drocsid-Setup.exe)

---

## Top 10 Melhorias Priorizadas

### 1. [Áudio / Streaming] Migrar Relay de Voz de `ScriptProcessorNode` + μ-law para `AudioWorklet` + Opus (`WebCodecs` / WASM)
- **Prioridade:** Alta
- **Diagnóstico atual:** O relay de voz em [`src/ui.html`](src/ui.html#L2773-L2825) usa `createScriptProcessor(2048, 1, 1)` (API depreciada que roda na *main thread*) e comprime em G.711 μ-law a 16 kHz (`~128 kbps`), enquanto [`handleBinaryAudioFrame`](src/ui.html#L1623-L1688) usa janela fixa de *jitter buffer* (`0.055s`–`0.35s`).
- **Bibliotecas / APIs sugeridas:** Web API **`AudioWorkletNode`** + **`WebCodecs` (`AudioEncoder`/`AudioDecoder` Opus 48 kHz)** com fallback WASM offline (`opus-recorder` / `libopus` WASM embutido), mantendo `DAP\x01`/`DAF\x01` para compatibilidade e adicionando `DAP\x02`/`DAF\x02` em [`src/protocol.rs`](src/protocol.rs).
- [x] Substituir `createScriptProcessor` por `AudioWorkletProcessor` dedicado (embutido offline)
- [x] Negociar e transmitir áudio Opus (24–48 kbps @ 48 kHz) via `DAP\x02`/`DAF\x02`, mantendo fallback `DAP\x01`/`DAF\x01`
- [x] Implementar *jitter buffer* adaptativo por peer para evitar cortes e acúmulo de latência em redes instáveis

### 2. [Streaming / Vídeo] Codec Moderno no Relay Universal (`WebCodecs` VP8/H.264) e `createImageBitmap` no Fallback MJPEG
- **Prioridade:** Alta
- **Diagnóstico atual:** [`startUniversalRelayCaptureLoop`](src/ui.html#L3126-L3196) envia cada quadro como JPEG inteiro (`offCanvas.toBlob`), e [`drawRelayFrame`](src/ui.html#L3284-L3329) aloca `Blob` + `URL.createObjectURL` + `new Image()` a cada quadro, elevando uso de banda no túnel e pressão de GC.
- **Bibliotecas / APIs sugeridas:** **`WebCodecs` (`VideoEncoder` / `VideoDecoder`)** com perfil baixa latência (`latencyMode: "realtime"`, VP8/H.264) para o Modo 2 (`UniversalRelay`), além de **`createImageBitmap` + `OffscreenCanvas`** no caminho MJPEG legado (`DVP\x01`/`DVF\x01`).
- [x] Adicionar transporte de chunks de vídeo codificados via WebCodecs (`DVP\x02`/`DVF\x02`) com keyframe periódico e sob demanda
- [x] Manter fallback automático para MJPEG (`DVP\x01`/`DVF\x01`) quando `VideoEncoder`/`VideoDecoder` não estiver disponível
- [x] Trocar `new Blob` + `new Image()` em `drawRelayFrame` por `createImageBitmap()` com descarte explícito (`bitmap.close()`)

### 3. [Backend Rust / Captura Nativa] Motor `NativeHost` em DXGI Desktop Duplication / WGC + Buffers Reutilizados
- **Prioridade:** Alta
- **Diagnóstico atual:** [`src/capture.rs`](src/capture.rs#L307-L686) usa `BitBlt`/`StretchBlt` GDI e `jpeg-encoder` puro em CPU, limitando [`start_native_capture_loop`](src/state.rs#L302) a 30 FPS e sofrendo em jogos *fullscreen*/D3D12/Vulkan. Além disso, [`capture_window_jpeg_bytes`](src/capture.rs#L650-L677) ainda aloca `bgra_buf` e `rgb_buf` a cada quadro e [`enumerate_capturable_windows`](src/capture.rs#L561) trunca em 8 janelas.
- **Bibliotecas Rust sugeridas:** **`windows`** (com bindings para `IDXGIOutputDuplication` / `Windows.Graphics.Capture` compatíveis com `x86_64-pc-windows-gnu` e `msvc`) + **`zune-jpeg`** / **`image`** / **`turbojpeg`** (ou codificação acelerada).
- [x] Reutilizar `thread_local!` buffers em `capture_window_jpeg_bytes` e melhorar filtro/ordenação de janelas capturáveis
- [x] Adicionar backend primário DXGI / Windows Graphics Capture para `NativeHost` a até 60 FPS reais, mantendo GDI como fallback
- [x] Otimizar codificação JPEG / detecção de quadros estáticos para reduzir CPU e banda quando a tela não muda

### 4. [Funcionalidade / Áudio] Captura de Áudio do Sistema via WASAPI Loopback no Motor Nativo (`NativeHost`)
- **Prioridade:** Alta
- **Diagnóstico atual:** No Modo 3 (`native_host`), [`src/ui.html`](src/ui.html#L3104) envia `has_audio: false` porque o backend Rust em [`src/capture.rs`](src/capture.rs) não captura áudio do sistema (ao contrário dos Modos 1 e 2 via `getDisplayMedia`).
- **Bibliotecas Rust sugeridas:** Crate **`wasapi`** (loopback do dispositivo de saída padrão no Windows) + **`rubato`** (reamostragem de alta qualidade para 16/48 kHz) despachando pacotes pelo canal binário de áudio.
- [x] Capturar áudio do sistema no host via WASAPI Loopback quando `has_audio: true` no modo `native_host`
- [x] Habilitar na UI do Go Live (Modo 3) a opção de transmitir áudio do sistema com controle independente de volume no palco
- [x] Adicionar reamostragem limpa (ex.: 44.1/48/96 kHz → taxa alvo) evitando estalos ou drift de buffer

### 5. [Áudio / UX] Cancelamento de Ruído por IA (`RNNoise`), VU Meter, Teste de Mic e Push-to-Talk Configurável/Global
- **Prioridade:** Alta
- **Diagnóstico atual:** [`captureMicStream`](src/ui.html#L2546-L2564) depende apenas do DSP padrão do navegador, [`openAudioSettingsModal`](src/ui.html#L2566-L2591) não tem medidor de nível nem retorno de teste, o limiar de VAD é fixo (`avg > 18` e `rms > 0.0035`) e o PTT (`src/ui.html#L2661-L2684`) só aceita `Space` ou `V` com foco na janela.
- **Bibliotecas sugeridas:** **`@sapphi-red/web-noise-suppressor`** (RNNoise WASM em `AudioWorklet`) + `DynamicsCompressorNode` na saída; no Windows host, Win32 **`RegisterHotKey`** / listener leve em Rust para PTT global enquanto joga.
- [x] Integrar filtro de ruído neural (RNNoise WASM) opcional no pipeline de captura do microfone
- [x] Adicionar no modal `🎛️ Áudio / PTT`: barra de VU meter em tempo real, slider de sensibilidade do Gate (VAD), ganho de entrada e botão **"Testar Microfone"**
- [x] Permitir escolher qualquer tecla ou botão do mouse para PTT + suporte a atalho global no app desktop Windows

### 6. [UI/UX] Eliminar `alert`/`confirm`/`prompt`, Adicionar Lightbox/Upload, Ícones SVG, Reações e Estado Rico nas Salas
- **Prioridade:** Média-Alta
- **Diagnóstico atual:** Existem **14 chamadas** bloqueantes de `alert()`, `confirm()` e `prompt()` em [`src/ui.html`](src/ui.html), imagens no chat abrem via `<a target="_blank">` com `data:` URL (frequentemente bloqueado), e a lista de salas (`renderRooms`) não mostra prévia de quem está conectado em voz/Go Live em cada sala.
- **Bibliotecas sugeridas:** **`lucide`** (ícones SVG leves inline), **`marked` + `dompurify`** (Markdown rico seguro), e sistema próprio de **Toasts + Modais de confirmação** sem dependências pesadas.
- [x] Substituir os 14 `alert`/`confirm`/`prompt` por Toasts não-bloqueantes e Modais próprios (confirmação e criação de sala)
- [x] Adicionar *lightbox* em modal para imagens no chat + botão de anexo e *drag-and-drop* (além de `Ctrl+V`)
- [x] Evoluir o chat com agrupamento de mensagens consecutivas, resposta (*reply*), reações rápidas (👍 😂 ❤️ 🔥), edição/exclusão própria e indicador *"digitando..."*
- [x] Mostrar prévia dos participantes e selo `AO VIVO` por sala na barra lateral, além de opções de tema/densidade

### 7. [Segurança / Persistência / Moderação] Separar Mídia do `chat_history.json`, Ban por Sessão, Mute pelo Host e Gerenciamento de Salas
- **Prioridade:** Média-Alta
- **Diagnóstico atual:** Imagens coladas no chat (`[drocsid-img]data:image/...`, até 200.000 chars em [`src/server.rs`](src/server.rs#L388-L411)) são gravadas integralmente dentro de `chat_history.json` e regravadas a cada mensagem ([`save_persisted_chat`](src/state.rs#L412-L429)). Além disso, [`KickPeer`](src/server.rs#L662-L689) apenas desconecta o peer atual sem impedir reconexão imediata com a mesma `room_key`.
- **Bibliotecas sugeridas:** **`axum` (`extract::Multipart` / `Body`)** + armazenamento local em `%LOCALAPPDATA%\Programs\Drocsid\media\` com política de retenção/limite.
- [x] Criar `POST /api/upload` e `GET /api/media/:id` (autenticados por `room_key`) para armazenar imagens/anexos pequenos fora de `chat_history.json`, com persistência assíncrona com debounce
- [x] Adicionar **Ban de Sessão/IP** (impede reconexão do expulso sem quebrar o convite dos amigos), **Server Mute** pelo anfitrião e **Sala Trancada / Aprovação**
- [x] Permitir ao anfitrião excluir salas customizadas ou limpar histórico da sala

### 8. [Rede / Conectividade] QR Code para Celular, Alerta de Versão (`Welcome.version`), Botão Parar Túnel e Saúde do Fallback SSH
- **Prioridade:** Média
- **Diagnóstico atual:** `ServerMessage::Welcome` já envia `version` ([`src/protocol.rs`](src/protocol.rs#L185)), mas [`src/ui.html`](src/ui.html#L2049-L2057) ignora o campo; a rota `POST /api/tunnel/stop` existe em [`src/server.rs`](src/server.rs#L40) sem botão correspondente na UI; e em [`src/tunnel.rs`](src/tunnel.rs#L210-L286), `launch_ssh_localhost_run` não drena `stdout` continuamente nem detecta queda do túnel SSH.
- **Bibliotecas sugeridas:** Crate **`qrcode`** (SVG inline leve no backend ou QR gerado no cliente via **`qrcode-generator`**).
- [x] Gerar **QR Code** no cartão de convite para conectar pelo celular com 1 scan
- [x] Exibir badge/alerta discreto quando `Welcome.version` divergir entre servidor e interface
- [x] Expor botão **Parar / Reiniciar Túnel** na sidebar consumindo `POST /api/tunnel/stop` e drenar/monitorar queda do processo `ssh` em `launch_ssh_localhost_run`
- [x] Permitir ao host repassar configuração TURN opcional para peers autenticados da sala

### 9. [Palco / Desktop Windows] Corrigir PiP no Canvas (`Modo 2` e `Modo 3`), Reconciliação da Grade 2x2 e Tray + Auto-Update
- **Prioridade:** Média
- **Diagnóstico atual:** [`togglePiP`](src/ui.html#L3716-L3727) só funciona quando `#stageVideo` está ativo (falhando no Modo 2 e Modo 3, que renderizam em `#stageCanvas`); [`updateStageView`](src/ui.html#L3435-L3474) faz `gridEl.innerHTML = ""` a cada `peer_updated`, reiniciando tiles na Grade 2x2; e [`src/tray.rs`](src/tray.rs#L211-L224) tem apenas `Abrir Drocsid` e `Encerrar Drocsid`.
- **Bibliotecas / APIs sugeridas:** `canvas.captureStream()` / **`documentPictureInPicture`** API; checagem de versão via GitHub Releases no app/instalador.
- [x] Suportar **PiP em `#stageCanvas`** (via `captureStream()` / `documentPictureInPicture`) em todos os 3 modos de Go Live
- [x] Refatorar `updateStageView()` no modo Grade 2x2 para reconciliar tiles sem destruir `<video>`/`<canvas>` em `peer_updated`, com opção de fixar tile principal (layout 1+N)
- [x] Enriquecer o menu do System Tray em `src/tray.rs` (`Copiar Convite`, status do túnel, `Iniciar/Parar Túnel`) e adicionar checagem opcional de atualização

### 10. [Arquitetura / DX] Modularizar Front-end (`src/ui.html` de 4.096 linhas) Mantendo Binário Único Offline + Testes Automatizados de UI
- **Prioridade:** Alta (fundação para incorporar WASM/bibliotecas sem regressão)
- **Diagnóstico atual:** [`src/ui.html`](src/ui.html) concentra 4.096 linhas (CSS + HTML + JS global) em um arquivo único embutido por `include_str!("ui.html")`, sem tipagem estática nem suíte de testes automatizados de front-end.
- **Bibliotecas / Ferramentas sugeridas:** **`esbuild`** (ou **`vite` + `vite-plugin-singlefile`**) compilando módulos de `web/` para um `src/ui.html` determinístico e 100% offline (preservando `cargo build --release` sem exigir Node em runtime), **`vitest`** para testes unitários JS e checagem de sintaxe/tipos (`tsc --noEmit` / ESLint).
- [x] Modularizar `src/ui.html` em `web/` (`styles/`, `audio/`, `webrtc/`, `relay/`, `chat/`, `ui/`) gerando bundle single-file offline para `src/ui.html`
- [x] Adicionar checagem de tipos/lint e testes unitários JS (`vitest`) para parser de convite, áudio μ-law/Opus, estado de sala e regressões desktop/mobile
- [x] Integrar a geração e validação do front-end no fluxo de build ([`build-installer.ps1`](build-installer.ps1))

---

## Ordem de Execução Planejada

1. **[Concluída] Etapa 1 — Fundação Front-end (Item 10):** Modularizar [`src/ui.html`](src/ui.html) com bundler offline (`esbuild`) + `vitest` para evitar regressões nas demais entregas.
2. **[Concluída] Etapa 2 — Quick Wins de Palco, Rede e UX (Itens 9, 8 e 6):** Corrigir PiP no Canvas e flicker da Grade 2x2; adicionar botão Parar Túnel, QR Code, alerta de `Welcome.version`, monitoramento SSH e Tray rico; substituir `alert`/`confirm`/`prompt` por Toasts/Modais, *lightbox*, reações e preview de salas.
3. **[Concluída] Etapa 3 — Pipeline de Áudio e Vídeo de Nova Geração (Itens 5, 1 e 2):** RNNoise + VU meter + teste de mic + PTT configurável/global; `AudioWorklet` + Opus no Relay de voz; `WebCodecs` + `createImageBitmap` no Relay de vídeo.
4. **[Concluída] Etapa 4 — Motor Nativo Windows & Moderação/Mídia (Itens 3, 4 e 7):** DXGI Desktop Duplication + fallback GDI + reuso de buffers; WASAPI Loopback (`src/audio_capture.rs`); upload de mídia fora de `chat_history.json`, ban de sessão/IP, server mute e gerenciamento/trancamento de salas.
