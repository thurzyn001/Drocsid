use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use jpeg_encoder::{ColorType, Encoder};

use crate::protocol::DesktopSourcePreview;

#[derive(Debug, Clone)]
pub struct MonitorRect {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    pub type BOOL = i32;
    pub type UINT = u32;
    pub type DWORD = u32;
    pub type LONG = i32;
    pub type WORD = u16;
    pub type LPARAM = isize;
    pub type HDC = *mut c_void;
    pub type HMONITOR = *mut c_void;
    pub type HWND = *mut c_void;
    pub type HBITMAP = *mut c_void;
    pub type HGDIOBJ = *mut c_void;
    pub type HCURSOR = *mut c_void;
    pub type HICON = *mut c_void;

    pub const CURSOR_SHOWING: DWORD = 0x0000_0001;
    pub const DI_NORMAL: UINT = 0x0003;
    pub const PW_RENDERFULLCONTENT: UINT = 0x0000_0002;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct POINT {
        pub x: LONG,
        pub y: LONG,
    }

    #[repr(C)]
    pub struct CURSORINFO {
        pub cb_size: DWORD,
        pub flags: DWORD,
        pub h_cursor: HCURSOR,
        pub pt_screen_pos: POINT,
    }

    pub const SRCCOPY: DWORD = 0x00CC0020;
    pub const BI_RGB: DWORD = 0;
    pub const DIB_RGB_COLORS: UINT = 0;
    pub const MONITORINFOF_PRIMARY: DWORD = 0x00000001;
    pub const HALFTONE: i32 = 4;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct RECT {
        pub left: LONG,
        pub top: LONG,
        pub right: LONG,
        pub bottom: LONG,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct MONITORINFOEXW {
        pub cb_size: DWORD,
        pub rc_monitor: RECT,
        pub rc_work: RECT,
        pub dw_flags: DWORD,
        pub sz_device: [u16; 32],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct BITMAPINFOHEADER {
        pub bi_size: DWORD,
        pub bi_width: LONG,
        pub bi_height: LONG,
        pub bi_planes: WORD,
        pub bi_bit_count: WORD,
        pub bi_compression: DWORD,
        pub bi_size_image: DWORD,
        pub bi_x_pels_per_meter: LONG,
        pub bi_y_pels_per_meter: LONG,
        pub bi_clr_used: DWORD,
        pub bi_clr_important: DWORD,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct RGBQUAD {
        pub rgb_blue: u8,
        pub rgb_green: u8,
        pub rgb_red: u8,
        pub rgb_reserved: u8,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct BITMAPINFO {
        pub bmi_header: BITMAPINFOHEADER,
        pub bmi_colors: [RGBQUAD; 1],
    }

    pub type MonitorEnumProc =
        unsafe extern "system" fn(HMONITOR, HDC, *mut RECT, LPARAM) -> BOOL;
    pub type WndEnumProc = unsafe extern "system" fn(HWND, LPARAM) -> BOOL;

    #[link(name = "user32")]
    extern "system" {
        pub fn SetProcessDPIAware() -> BOOL;
        pub fn EnumDisplayMonitors(
            hdc: HDC,
            lprc_clip: *const RECT,
            lpfn_enum: MonitorEnumProc,
            dw_data: LPARAM,
        ) -> BOOL;
        pub fn GetMonitorInfoW(hmonitor: HMONITOR, lpmi: *mut MONITORINFOEXW) -> BOOL;
        pub fn GetDC(hwnd: HWND) -> HDC;
        pub fn GetWindowDC(hwnd: HWND) -> HDC;
        pub fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
        pub fn GetCursorInfo(pci: *mut CURSORINFO) -> BOOL;
        pub fn DrawIconEx(
            hdc: HDC,
            x_left: i32,
            y_top: i32,
            h_icon: HICON,
            cx_width: i32,
            cy_height: i32,
            istep_if_ani_cur: UINT,
            hbr_flicker_free_draw: *mut c_void,
            di_flags: UINT,
        ) -> BOOL;
        pub fn EnumWindows(lp_enum_func: WndEnumProc, l_param: LPARAM) -> BOOL;
        pub fn IsWindowVisible(hwnd: HWND) -> BOOL;
        pub fn IsIconic(hwnd: HWND) -> BOOL;
        pub fn GetForegroundWindow() -> HWND;
        pub fn GetWindowLongW(hwnd: HWND, n_index: i32) -> i32;
        pub fn GetWindowTextLengthW(hwnd: HWND) -> i32;
        pub fn GetWindowTextW(hwnd: HWND, lp_string: *mut u16, n_max_count: i32) -> i32;
        pub fn GetWindowRect(hwnd: HWND, lp_rect: *mut RECT) -> BOOL;
        pub fn PrintWindow(hwnd: HWND, hdc_blt: HDC, n_flags: UINT) -> BOOL;
    }

    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
        pub fn CreateCompatibleBitmap(hdc: HDC, cx: i32, cy: i32) -> HBITMAP;
        pub fn SelectObject(hdc: HDC, h: HGDIOBJ) -> HGDIOBJ;
        pub fn SetStretchBltMode(hdc: HDC, mode: i32) -> i32;
        pub fn SetBrushOrgEx(hdc: HDC, x: i32, y: i32, lpt: *mut POINT) -> BOOL;
        pub fn BitBlt(
            hdc: HDC,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            hdc_src: HDC,
            x1: i32,
            y1: i32,
            rop: DWORD,
        ) -> BOOL;
        pub fn StretchBlt(
            hdc_dest: HDC,
            x_dest: i32,
            y_dest: i32,
            w_dest: i32,
            h_dest: i32,
            hdc_src: HDC,
            x_src: i32,
            y_src: i32,
            w_src: i32,
            h_src: i32,
            rop: DWORD,
        ) -> BOOL;
        pub fn GetDIBits(
            hdc: HDC,
            hbm: HBITMAP,
            start: UINT,
            c_lines: UINT,
            lpv_bits: *mut c_void,
            lpbmi: *mut BITMAPINFO,
            usage: UINT,
        ) -> i32;
        pub fn DeleteObject(ho: HGDIOBJ) -> BOOL;
        pub fn DeleteDC(hdc: HDC) -> BOOL;
    }
}

/// Enumera todos os monitores conectados ao sistema.
/// Corresponde à descoberta de fontes usada por `GetScreenPreviews` (ordinal 121 em `discord_voice.node`).
#[cfg(windows)]
pub fn enumerate_monitors() -> Vec<MonitorRect> {
    use std::mem::size_of;
    use std::ptr::null;
    use std::sync::{Mutex, Once};
    use std::time::{Duration, Instant};
    use win32::*;

    static DPI_INIT: Once = Once::new();
    DPI_INIT.call_once(|| unsafe {
        SetProcessDPIAware();
    });

    static MONITOR_CACHE: Mutex<Option<(Instant, Vec<MonitorRect>)>> = Mutex::new(None);
    if let Ok(guard) = MONITOR_CACHE.lock() {
        if let Some((ts, cached)) = guard.as_ref() {
            if ts.elapsed() < Duration::from_secs(3) {
                return cached.clone();
            }
        }
    }

    unsafe extern "system" fn enum_proc(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _lprc: *mut RECT,
        dw_data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(dw_data as *mut Vec<MonitorRect>);
        let mut mi = MONITORINFOEXW {
            cb_size: size_of::<MONITORINFOEXW>() as DWORD,
            rc_monitor: RECT::default(),
            rc_work: RECT::default(),
            dw_flags: 0,
            sz_device: [0u16; 32],
        };

        if GetMonitorInfoW(hmonitor, &mut mi) != 0 {
            let width = (mi.rc_monitor.right - mi.rc_monitor.left).max(1) as u32;
            let height = (mi.rc_monitor.bottom - mi.rc_monitor.top).max(1) as u32;
            let is_primary = (mi.dw_flags & MONITORINFOF_PRIMARY) != 0;
            let idx = monitors.len();
            let raw_name = String::from_utf16_lossy(&mi.sz_device)
                .trim_end_matches('\0')
                .to_string();
            let display_name = if is_primary {
                format!("Tela {} (Principal - {}x{})", idx + 1, width, height)
            } else if !raw_name.is_empty() {
                format!("Tela {} ({} - {}x{})", idx + 1, raw_name, width, height)
            } else {
                format!("Tela {} ({}x{})", idx + 1, width, height)
            };

            monitors.push(MonitorRect {
                index: idx,
                name: display_name,
                x: mi.rc_monitor.left,
                y: mi.rc_monitor.top,
                width,
                height,
                is_primary,
            });
        }
        1
    }

    let mut monitors: Vec<MonitorRect> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
             std::ptr::null_mut(),
            null(),
            enum_proc,
            (&mut monitors as *mut Vec<MonitorRect>) as LPARAM,
        );
    }

    if monitors.is_empty() {
        monitors.push(MonitorRect {
            index: 0,
            name: "Tela 1 (Principal - 1920x1080)".to_string(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            is_primary: true,
        });
    }

    if let Ok(mut guard) = MONITOR_CACHE.lock() {
        *guard = Some((Instant::now(), monitors.clone()));
    }

    monitors
}

#[cfg(not(windows))]
pub fn enumerate_monitors() -> Vec<MonitorRect> {
    vec![MonitorRect {
        index: 0,
        name: "Tela 1 (Simulada - 1280x720)".to_string(),
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        is_primary: true,
    }]
}

/// Captura um quadro bruto BGRA de um monitor via Win32 GDI (`StretchBlt`/`BitBlt` + `GetDIBits`),
/// retornando `(width, height, jpeg_bytes)` com reuso de buffers (`thread_local!`).
#[cfg(windows)]
pub fn capture_monitor_jpeg_bytes(
    monitor_index: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, Vec<u8>), String> {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use win32::*;

    thread_local! {
        static BGRA_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::new());
        static RGB_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    }

    let monitors = enumerate_monitors();
    let monitor = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .ok_or_else(|| "Nenhum monitor encontrado".to_string())?;

    let src_w = monitor.width.max(1);
    let src_h = monitor.height.max(1);
    let target_w = max_width.clamp(160, src_w);
    let target_h = ((src_h as u64 * target_w as u64) / src_w as u64).max(90) as u32;

    unsafe {
        let screen_dc = GetDC(null_mut());
        if screen_dc.is_null() {
            return Err("Falha ao obter HDC da área de trabalho (GetDC)".to_string());
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(null_mut(), screen_dc);
            return Err("Falha ao criar HDC compatível (CreateCompatibleDC)".to_string());
        }

        let bmp = CreateCompatibleBitmap(screen_dc, target_w as i32, target_h as i32);
        if bmp.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(null_mut(), screen_dc);
            return Err("Falha ao criar HBITMAP (CreateCompatibleBitmap)".to_string());
        }

        let old_obj = SelectObject(mem_dc, bmp);
        let blt_ok = if target_w == src_w && target_h == src_h {
            BitBlt(
                mem_dc,
                0,
                0,
                src_w as i32,
                src_h as i32,
                screen_dc,
                monitor.x,
                monitor.y,
                SRCCOPY,
            )
        } else {
            SetStretchBltMode(mem_dc, HALFTONE);
            SetBrushOrgEx(mem_dc, 0, 0, null_mut());
            StretchBlt(
                mem_dc,
                0,
                0,
                target_w as i32,
                target_h as i32,
                screen_dc,
                monitor.x,
                monitor.y,
                src_w as i32,
                src_h as i32,
                SRCCOPY,
            )
        };

        if blt_ok == 0 {
            SelectObject(mem_dc, old_obj);
            DeleteObject(bmp);
            DeleteDC(mem_dc);
            ReleaseDC(null_mut(), screen_dc);
            return Err("Falha ao copiar pixels da tela (BitBlt/StretchBlt)".to_string());
        }

        // Desenha o cursor do mouse na captura (BitBlt/StretchBlt sozinho nao inclui o cursor)
        let mut cursor_info = CURSORINFO {
            cb_size: size_of::<CURSORINFO>() as DWORD,
            flags: 0,
            h_cursor: null_mut(),
            pt_screen_pos: POINT::default(),
        };
        if GetCursorInfo(&mut cursor_info) != 0
            && (cursor_info.flags & CURSOR_SHOWING) != 0
            && !cursor_info.h_cursor.is_null()
        {
            let rel_x = cursor_info.pt_screen_pos.x - monitor.x;
            let rel_y = cursor_info.pt_screen_pos.y - monitor.y;
            if rel_x >= -64 && rel_y >= -64 && rel_x < src_w as i32 + 64 && rel_y < src_h as i32 + 64 {
                let dst_cur_x = ((rel_x as i64) * (target_w as i64) / (src_w as i64)) as i32;
                let dst_cur_y = ((rel_y as i64) * (target_h as i64) / (src_h as i64)) as i32;
                let _ = DrawIconEx(
                    mem_dc,
                    dst_cur_x,
                    dst_cur_y,
                    cursor_info.h_cursor,
                    0,
                    0,
                    0,
                    null_mut(),
                    DI_NORMAL,
                );
            }
        }

        let mut bmi = BITMAPINFO::default();
        bmi.bmi_header.bi_size = size_of::<BITMAPINFOHEADER>() as DWORD;
        bmi.bmi_header.bi_width = target_w as LONG;
        bmi.bmi_header.bi_height = -(target_h as LONG);
        bmi.bmi_header.bi_planes = 1;
        bmi.bmi_header.bi_bit_count = 32;
        bmi.bmi_header.bi_compression = BI_RGB;

        let needed_bgra = (target_w as usize) * (target_h as usize) * 4;
        let lines = BGRA_BUF.with(|cell| {
            let mut buf = cell.borrow_mut();
            buf.resize(needed_bgra, 0);
            GetDIBits(
                mem_dc,
                bmp,
                0,
                target_h,
                buf.as_mut_ptr() as *mut c_void,
                &mut bmi,
                DIB_RGB_COLORS,
            )
        });

        SelectObject(mem_dc, old_obj);
        DeleteObject(bmp);
        DeleteDC(mem_dc);
        ReleaseDC(null_mut(), screen_dc);

        if lines == 0 {
            return Err("Falha ao extrair bits do bitmap (GetDIBits)".to_string());
        }

        let mut jpeg_bytes = Vec::with_capacity((target_w * target_h) as usize / 2);
        let encode_res = BGRA_BUF.with(|b_cell| {
            RGB_BUF.with(|r_cell| {
                let bgra = b_cell.borrow();
                let mut rgb = r_cell.borrow_mut();
                bgra_to_rgb_into(&bgra, &mut rgb);
                let encoder = Encoder::new(&mut jpeg_bytes, quality.clamp(20, 95));
                encoder.encode(&rgb, target_w as u16, target_h as u16, ColorType::Rgb)
            })
        });
        encode_res.map_err(|e| format!("Erro na codificação JPEG: {e}"))?;

        Ok((target_w, target_h, jpeg_bytes))
    }
}

/// Versão Base64 de `capture_monitor_jpeg_bytes` (para miniaturas HTTP).
#[cfg(windows)]
pub fn capture_monitor_jpeg(
    monitor_index: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, String), String> {
    let (w, h, bytes) = capture_monitor_jpeg_bytes(monitor_index, max_width, quality)?;
    Ok((w, h, BASE64.encode(&bytes)))
}

#[cfg(not(windows))]
pub fn capture_monitor_jpeg_bytes(
    _monitor_index: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, Vec<u8>), String> {
    let target_w = max_width.clamp(160, 1280);
    let target_h = (target_w * 9) / 16;
    let mut rgb_buf = vec![0u8; (target_w * target_h * 3) as usize];
    for y in 0..target_h {
        for x in 0..target_w {
            let idx = ((y * target_w + x) * 3) as usize;
            rgb_buf[idx] = ((x * 255) / target_w) as u8;
            rgb_buf[idx + 1] = ((y * 255) / target_h) as u8;
            rgb_buf[idx + 2] = 88;
        }
    }
    let mut jpeg_bytes = Vec::new();
    let encoder = Encoder::new(&mut jpeg_bytes, quality.clamp(20, 95));
    encoder
        .encode(&rgb_buf, target_w as u16, target_h as u16, ColorType::Rgb)
        .map_err(|e| format!("Erro na codificação JPEG: {e}"))?;
    Ok((target_w, target_h, jpeg_bytes))
}

#[cfg(not(windows))]
pub fn capture_monitor_jpeg(
    monitor_index: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, String), String> {
    let (w, h, bytes) = capture_monitor_jpeg_bytes(monitor_index, max_width, quality)?;
    Ok((w, h, BASE64.encode(&bytes)))
}

/// Enumera janelas visíveis capturáveis (T-3 + Etapa 4: filtra tool windows, prioriza foco/área).
#[cfg(windows)]
pub fn enumerate_capturable_windows() -> Vec<(usize, String, u32, u32)> {
    use win32::*;

    unsafe extern "system" fn enum_wnd(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if (ex_style & WS_EX_TOOLWINDOW) != 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if copied <= 0 {
            return 1;
        }
        let title = String::from_utf16_lossy(&buf[..copied as usize]).trim().to_string();
        if title.is_empty()
            || title == "Program Manager"
            || title == "Windows Input Experience"
            || title == "Microsoft Text Input Application"
            || title == "NVIDIA GeForce Overlay"
        {
            return 1;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        let w = (rect.right - rect.left).max(0) as u32;
        let h = (rect.bottom - rect.top).max(0) as u32;
        if w < 240 || h < 160 {
            return 1;
        }
        let list = &mut *(lparam as *mut Vec<(usize, String, u32, u32)>);
        list.push((hwnd as usize, title, w, h));
        1
    }

    let mut windows: Vec<(usize, String, u32, u32)> = Vec::new();
    let fg_hwnd = unsafe {
        EnumWindows(
            enum_wnd,
            (&mut windows as *mut Vec<(usize, String, u32, u32)>) as LPARAM,
        );
        GetForegroundWindow() as usize
    };
    windows.sort_by(|a, b| {
        let a_fg = a.0 == fg_hwnd;
        let b_fg = b.0 == fg_hwnd;
        b_fg.cmp(&a_fg)
            .then_with(|| ((b.2 as u64) * (b.3 as u64)).cmp(&((a.2 as u64) * (a.3 as u64))))
    });
    windows.truncate(16);
    windows
}

/// Captura uma janela específica usando `PrintWindow(..., PW_RENDERFULLCONTENT)` (com fallback `BitBlt`)
/// e reuso de buffers `thread_local!` para reduzir alocações por quadro.
#[cfg(windows)]
pub fn capture_window_jpeg_bytes(
    hwnd_val: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, Vec<u8>), String> {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null_mut;
    use win32::*;

    thread_local! {
        static WIN_BGRA_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::new());
        static WIN_RGB_BUF: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    }

    let hwnd = hwnd_val as HWND;
    unsafe {
        if IsWindowVisible(hwnd) == 0 {
            return Err("Janela não está mais visível".to_string());
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("Falha ao obter dimensões da janela".to_string());
        }
        let src_w = (rect.right - rect.left).max(1) as u32;
        let src_h = (rect.bottom - rect.top).max(1) as u32;
        let target_w = max_width.clamp(160, src_w);
        let target_h = ((src_h as u64 * target_w as u64) / src_w as u64).max(90) as u32;

        let win_dc = GetWindowDC(hwnd);
        let ref_dc = if win_dc.is_null() { GetDC(null_mut()) } else { win_dc };
        if ref_dc.is_null() {
            return Err("Falha ao obter HDC da janela".to_string());
        }

        let full_dc = CreateCompatibleDC(ref_dc);
        let full_bmp = CreateCompatibleBitmap(ref_dc, src_w as i32, src_h as i32);
        let scaled_dc = CreateCompatibleDC(ref_dc);
        let scaled_bmp = CreateCompatibleBitmap(ref_dc, target_w as i32, target_h as i32);
        if full_dc.is_null() || full_bmp.is_null() || scaled_dc.is_null() || scaled_bmp.is_null() {
            if !full_bmp.is_null() { DeleteObject(full_bmp); }
            if !full_dc.is_null() { DeleteDC(full_dc); }
            if !scaled_bmp.is_null() { DeleteObject(scaled_bmp); }
            if !scaled_dc.is_null() { DeleteDC(scaled_dc); }
            ReleaseDC(if win_dc.is_null() { null_mut() } else { hwnd }, ref_dc);
            return Err("Falha ao alocar bitmaps de janela".to_string());
        }

        let old_full = SelectObject(full_dc, full_bmp);
        let mut ok = PrintWindow(hwnd, full_dc, PW_RENDERFULLCONTENT);
        if ok == 0 {
            ok = BitBlt(full_dc, 0, 0, src_w as i32, src_h as i32, ref_dc, 0, 0, SRCCOPY);
        }
        if ok == 0 {
            SelectObject(full_dc, old_full);
            DeleteObject(full_bmp);
            DeleteDC(full_dc);
            DeleteObject(scaled_bmp);
            DeleteDC(scaled_dc);
            ReleaseDC(if win_dc.is_null() { null_mut() } else { hwnd }, ref_dc);
            return Err("Falha ao capturar conteúdo da janela".to_string());
        }

        let old_scaled = SelectObject(scaled_dc, scaled_bmp);
        SetStretchBltMode(scaled_dc, HALFTONE);
        SetBrushOrgEx(scaled_dc, 0, 0, null_mut());
        let st_ok = StretchBlt(
            scaled_dc,
            0,
            0,
            target_w as i32,
            target_h as i32,
            full_dc,
            0,
            0,
            src_w as i32,
            src_h as i32,
            SRCCOPY,
        );

        let mut bmi = BITMAPINFO::default();
        bmi.bmi_header.bi_size = size_of::<BITMAPINFOHEADER>() as DWORD;
        bmi.bmi_header.bi_width = target_w as LONG;
        bmi.bmi_header.bi_height = -(target_h as LONG);
        bmi.bmi_header.bi_planes = 1;
        bmi.bmi_header.bi_bit_count = 32;
        bmi.bmi_header.bi_compression = BI_RGB;

        let needed_bgra = (target_w as usize) * (target_h as usize) * 4;
        let lines = WIN_BGRA_BUF.with(|cell| {
            let mut buf = cell.borrow_mut();
            buf.resize(needed_bgra, 0);
            if st_ok != 0 {
                GetDIBits(
                    scaled_dc,
                    scaled_bmp,
                    0,
                    target_h,
                    buf.as_mut_ptr() as *mut c_void,
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            }
        });

        SelectObject(scaled_dc, old_scaled);
        DeleteObject(scaled_bmp);
        DeleteDC(scaled_dc);
        SelectObject(full_dc, old_full);
        DeleteObject(full_bmp);
        DeleteDC(full_dc);
        ReleaseDC(if win_dc.is_null() { null_mut() } else { hwnd }, ref_dc);

        if lines == 0 {
            return Err("Falha ao extrair bits da janela".to_string());
        }

        let mut jpeg_bytes = Vec::with_capacity((target_w * target_h) as usize / 2);
        let encode_res = WIN_BGRA_BUF.with(|b_cell| {
            WIN_RGB_BUF.with(|r_cell| {
                let bgra = b_cell.borrow();
                let mut rgb = r_cell.borrow_mut();
                bgra_to_rgb_into(&bgra, &mut rgb);
                let encoder = Encoder::new(&mut jpeg_bytes, quality.clamp(20, 95));
                encoder.encode(&rgb, target_w as u16, target_h as u16, ColorType::Rgb)
            })
        });
        encode_res.map_err(|e| format!("Erro na codificação JPEG da janela: {e}"))?;

        Ok((target_w, target_h, jpeg_bytes))
    }
}

#[cfg(not(windows))]
pub fn capture_window_jpeg_bytes(
    _hwnd_val: usize,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, Vec<u8>), String> {
    capture_monitor_jpeg_bytes(0, max_width, quality)
}

/// Captura monitor (`screen:<idx>:0`) ou janela (`window:<hwnd>:0`) em bytes JPEG brutos.
pub fn capture_source_jpeg_bytes(
    source_id: &str,
    max_width: u32,
    quality: u8,
) -> Result<(u32, u32, Vec<u8>), String> {
    if let Some(rest) = source_id.strip_prefix("window:") {
        if let Some(hwnd_val) = rest.split(':').next().and_then(|s| s.parse::<usize>().ok()) {
            return capture_window_jpeg_bytes(hwnd_val, max_width, quality);
        }
    }
    let monitor_index = source_id
        .split(':')
        .nth(1)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    capture_monitor_jpeg_bytes(monitor_index, max_width, quality)
}

/// Converte um buffer BGRA (32-bit do GDI) direto para RGB (24-bit) reutilizando o vetor de saída.
#[cfg(windows)]
fn bgra_to_rgb_into(src_bgra: &[u8], dst_rgb: &mut Vec<u8>) {
    let pixel_count = src_bgra.len() / 4;
    dst_rgb.clear();
    dst_rgb.reserve(pixel_count * 3);
    for px in src_bgra.chunks_exact(4) {
        dst_rgb.push(px[2]); // R
        dst_rgb.push(px[1]); // G
        dst_rgb.push(px[0]); // B
    }
}

/// Converte um buffer BGRA (32-bit do GDI) para RGB (24-bit) com amostragem rápida.
#[allow(dead_code)]
fn bgra_to_scaled_rgb(
    src_bgra: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    let mut dst_rgb = vec![0u8; (dst_w as usize) * (dst_h as usize) * 3];
    let src_w_usize = src_w as usize;
    let dst_w_usize = dst_w as usize;

    for dy in 0..dst_h as usize {
        let sy = (dy * src_h as usize) / dst_h as usize;
        let src_row_offset = sy * src_w_usize * 4;
        let dst_row_offset = dy * dst_w_usize * 3;

        for dx in 0..dst_w_usize {
            let sx = (dx * src_w_usize) / dst_w_usize;
            let s_idx = src_row_offset + sx * 4;
            let d_idx = dst_row_offset + dx * 3;

            dst_rgb[d_idx] = src_bgra[s_idx + 2]; // R
            dst_rgb[d_idx + 1] = src_bgra[s_idx + 1]; // G
            dst_rgb[d_idx + 2] = src_bgra[s_idx]; // B
        }
    }

    dst_rgb
}

/// Gera a lista de telas e janelas visíveis com miniaturas em tempo real.
/// Equivale a `?GetScreenPreviews@Discord@@QEAAX...` (ordinal 121 em `discord_voice.node`)
/// e `getDesktopCaptureSources` (módulo `9425` em `core.asar`).
pub fn get_screen_previews(thumb_width: u32) -> Vec<DesktopSourcePreview> {
    let monitors = enumerate_monitors();
    let mut previews: Vec<DesktopSourcePreview> = monitors
        .into_iter()
        .map(|m| {
            let thumbnail_data_url = match capture_monitor_jpeg(m.index, thumb_width, 65) {
                Ok((_, _, b64)) => format!("data:image/jpeg;base64,{b64}"),
                Err(_) => String::new(),
            };
            DesktopSourcePreview {
                id: format!("screen:{}:0", m.index),
                monitor_index: m.index,
                name: m.name,
                width: m.width,
                height: m.height,
                x: m.x,
                y: m.y,
                is_primary: m.is_primary,
                thumbnail_data_url,
            }
        })
        .collect();

    #[cfg(windows)]
    {
        for (idx, (hwnd_val, title, w, h)) in enumerate_capturable_windows().into_iter().enumerate() {
            let thumbnail_data_url = match capture_window_jpeg_bytes(hwnd_val, thumb_width, 60) {
                Ok((_, _, bytes)) => format!("data:image/jpeg;base64,{}", BASE64.encode(&bytes)),
                Err(_) => String::new(),
            };
            previews.push(DesktopSourcePreview {
                id: format!("window:{hwnd_val}:0"),
                monitor_index: 100 + idx,
                name: format!("🪟 {title}"),
                width: w,
                height: h,
                x: 0,
                y: 0,
                is_primary: false,
                thumbnail_data_url,
            });
        }
    }

    previews
}

/// Resultado de um tick de captura nativa contínua (`NativeCaptureSession`).
pub enum NativeCaptureTick {
    Frame {
        width: u32,
        height: u32,
        jpeg_bytes: Vec<u8>,
    },
    Unchanged,
}

/// Hash FNV-1a amostrado ultra-rápido para detectar quadros estáticos sem gastar CPU/banda.
pub fn sample_bytes_signature(data: &[u8], tag: u64) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64 ^ tag;
    if data.is_empty() {
        return hash;
    }
    let step = (data.len() / 2048).max(1);
    let mut i = 0usize;
    while i < data.len() {
        hash ^= data[i] as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
        i += step;
    }
    hash ^= data.len() as u64;
    hash
}

#[cfg(windows)]
fn cursor_pos_on_monitor(mon: &MonitorRect) -> Option<(i32, i32)> {
    use std::mem::size_of;
    use std::ptr::null_mut;
    use win32::*;
    unsafe {
        let mut ci = CURSORINFO {
            cb_size: size_of::<CURSORINFO>() as DWORD,
            flags: 0,
            h_cursor: null_mut(),
            pt_screen_pos: POINT::default(),
        };
        if GetCursorInfo(&mut ci) == 0 || (ci.flags & CURSOR_SHOWING) == 0 {
            return None;
        }
        let rx = ci.pt_screen_pos.x - mon.x;
        let ry = ci.pt_screen_pos.y - mon.y;
        if rx >= 0 && ry >= 0 && rx < mon.width as i32 && ry < mon.height as i32 {
            Some((rx, ry))
        } else {
            None
        }
    }
}

/// Desenha um pequeno ponteiro vetorial de alto contraste diretamente no buffer RGB escalado.
fn draw_rgb_cursor_arrow(rgb: &mut [u8], w: u32, h: u32, cx: i32, cy: i32) {
    // Bitmap compacto 8x12: 0 transparente, 1 contorno preto, 2 preenchimento branco
    const ARROW: [[u8; 8]; 12] = [
        [1, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [1, 2, 1, 0, 0, 0, 0, 0],
        [1, 2, 2, 1, 0, 0, 0, 0],
        [1, 2, 2, 2, 1, 0, 0, 0],
        [1, 2, 2, 2, 2, 1, 0, 0],
        [1, 2, 2, 2, 2, 2, 1, 0],
        [1, 2, 2, 2, 2, 2, 2, 1],
        [1, 2, 2, 2, 1, 1, 1, 0],
        [1, 2, 1, 2, 1, 0, 0, 0],
        [1, 1, 0, 1, 2, 1, 0, 0],
        [0, 0, 0, 0, 1, 1, 0, 0],
    ];
    for (dy, row) in ARROW.iter().enumerate() {
        let py = cy + dy as i32;
        if py < 0 || py >= h as i32 {
            continue;
        }
        for (dx, &px_kind) in row.iter().enumerate() {
            if px_kind == 0 {
                continue;
            }
            let px = cx + dx as i32;
            if px < 0 || px >= w as i32 {
                continue;
            }
            let idx = ((py as usize) * (w as usize) + (px as usize)) * 3;
            if idx + 2 < rgb.len() {
                let c = if px_kind == 2 { 255u8 } else { 12u8 };
                rgb[idx] = c;
                rgb[idx + 1] = c;
                rgb[idx + 2] = c;
            }
        }
    }
}

#[cfg(windows)]
struct DxgiMonitorCapturer {
    monitor: MonitorRect,
    context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    staging: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    duplication: windows::Win32::Graphics::Dxgi::IDXGIOutputDuplication,
    src_w: u32,
    src_h: u32,
    rgb_buf: Vec<u8>,
}

#[cfg(windows)]
impl DxgiMonitorCapturer {
    fn new(monitor_index: usize) -> Result<Self, String> {
        use windows::core::Interface;
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
        use windows::Win32::Graphics::Direct3D11::*;
        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
        use windows::Win32::Graphics::Dxgi::*;

        let monitors = enumerate_monitors();
        let monitor = monitors
            .get(monitor_index)
            .or_else(|| monitors.first())
            .cloned()
            .ok_or_else(|| "Nenhum monitor disponível para DXGI".to_string())?;

        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;

            let mut adapter_idx = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(adapter_idx) {
                adapter_idx += 1;
                let mut out_idx = 0u32;
                while let Ok(output) = adapter.EnumOutputs(out_idx) {
                    out_idx += 1;
                    let Ok(desc) = output.GetDesc() else {
                        continue;
                    };
                    let coords = desc.DesktopCoordinates;
                    let matches = coords.left == monitor.x
                        && coords.top == monitor.y
                        && (coords.right - coords.left).unsigned_abs() == monitor.width;
                    if !matches && monitor_index != 0 {
                        continue;
                    }
                    if matches || (monitor_index == 0 && out_idx == 1 && adapter_idx == 1) {
                        let base_adapter: IDXGIAdapter = adapter
                            .cast()
                            .map_err(|e| format!("adapter cast: {e}"))?;
                        let mut device: Option<ID3D11Device> = None;
                        let mut context: Option<ID3D11DeviceContext> = None;
                        D3D11CreateDevice(
                            Some(&base_adapter),
                            D3D_DRIVER_TYPE_UNKNOWN,
                            windows::Win32::Foundation::HMODULE::default(),
                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            None,
                            D3D11_SDK_VERSION,
                            Some(&mut device),
                            None,
                            Some(&mut context),
                        )
                        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;

                        let device = device.ok_or("D3D11Device nulo")?;
                        let context = context.ok_or("D3D11DeviceContext nulo")?;
                        let output1: IDXGIOutput1 = output
                            .cast()
                            .map_err(|e| format!("IDXGIOutput1 cast: {e}"))?;
                        let duplication = output1
                            .DuplicateOutput(&device)
                            .map_err(|e| format!("DuplicateOutput: {e}"))?;

                        let src_w = (coords.right - coords.left).max(1) as u32;
                        let src_h = (coords.bottom - coords.top).max(1) as u32;
                        let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
                        tex_desc.Width = src_w;
                        tex_desc.Height = src_h;
                        tex_desc.MipLevels = 1;
                        tex_desc.ArraySize = 1;
                        tex_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                        tex_desc.SampleDesc.Count = 1;
                        tex_desc.Usage = D3D11_USAGE_STAGING;
                        tex_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;

                        let mut staging: Option<ID3D11Texture2D> = None;
                        device
                            .CreateTexture2D(&tex_desc, None, Some(&mut staging))
                            .map_err(|e| format!("CreateTexture2D staging: {e}"))?;
                        let staging = staging.ok_or("Textura staging nula")?;

                        return Ok(Self {
                            monitor,
                            context,
                            staging,
                            duplication,
                            src_w,
                            src_h,
                            rgb_buf: Vec::new(),
                        });
                    }
                }
            }
        }

        Err("Saída DXGI correspondente ao monitor não encontrada".to_string())
    }

    fn capture_if_changed(
        &mut self,
        max_width: u32,
        quality: u8,
        prev_sig: Option<u64>,
        force_keyframe: bool,
    ) -> Result<(NativeCaptureTick, Option<u64>), String> {
        use windows::core::Interface;
        use windows::Win32::Graphics::Direct3D11::*;
        use windows::Win32::Graphics::Dxgi::*;

        unsafe {
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            let acq = self
                .duplication
                .AcquireNextFrame(16, &mut frame_info, &mut resource);
            if let Err(err) = acq {
                if err.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    if !force_keyframe && prev_sig.is_some() {
                        return Ok((NativeCaptureTick::Unchanged, prev_sig));
                    }
                    // No primeiro frame/heartbeat sem novidade DXGI, cai para Err suave se ainda não há prev_sig
                    if prev_sig.is_some() {
                        return Ok((NativeCaptureTick::Unchanged, prev_sig));
                    }
                    return Err("DXGI aguardando primeiro quadro".to_string());
                }
                return Err(format!("AcquireNextFrame: {err}"));
            }

            let tex_res = resource
                .ok_or_else(|| "IDXGIResource vazio".to_string())
                .and_then(|r| r.cast::<ID3D11Texture2D>().map_err(|e| format!("{e}")));

            let target_w = max_width.clamp(160, self.src_w);
            let target_h = ((self.src_h as u64 * target_w as u64) / self.src_w as u64).max(90) as u32;

            let map_result = match tex_res {
                Ok(tex) => {
                    self.context.CopyResource(&self.staging, &tex);
                    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                    let m = self.context.Map(
                        &self.staging,
                        0,
                        D3D11_MAP_READ,
                        0,
                        Some(&mut mapped),
                    );
                    if let Err(e) = m {
                        Err(format!("ID3D11DeviceContext::Map: {e}"))
                    } else {
                        let row_pitch = mapped.RowPitch as usize;
                        let total_bytes = row_pitch * (self.src_h as usize);
                        let src_slice = std::slice::from_raw_parts(mapped.pData as *const u8, total_bytes);
                        let needed_rgb = (target_w as usize) * (target_h as usize) * 3;
                        self.rgb_buf.resize(needed_rgb, 0);

                        for dy in 0..target_h as usize {
                            let sy = (dy * self.src_h as usize) / target_h as usize;
                            let src_row = sy * row_pitch;
                            let dst_row = dy * (target_w as usize) * 3;
                            for dx in 0..target_w as usize {
                                let sx = (dx * self.src_w as usize) / target_w as usize;
                                let s_off = src_row + sx * 4;
                                let d_off = dst_row + dx * 3;
                                self.rgb_buf[d_off] = src_slice[s_off + 2];
                                self.rgb_buf[d_off + 1] = src_slice[s_off + 1];
                                self.rgb_buf[d_off + 2] = src_slice[s_off];
                            }
                        }

                        self.context.Unmap(&self.staging, 0);
                        Ok(())
                    }
                }
                Err(e) => Err(e),
            };

            let _ = self.duplication.ReleaseFrame();
            map_result?;

            if let Some((rx, ry)) = cursor_pos_on_monitor(&self.monitor) {
                let cx = ((rx as i64) * (target_w as i64) / (self.src_w as i64)) as i32;
                let cy = ((ry as i64) * (target_h as i64) / (self.src_h as i64)) as i32;
                draw_rgb_cursor_arrow(&mut self.rgb_buf, target_w, target_h, cx, cy);
            }

            let sig = sample_bytes_signature(
                &self.rgb_buf,
                ((target_w as u64) << 16) ^ (target_h as u64),
            );
            if !force_keyframe && prev_sig == Some(sig) {
                return Ok((NativeCaptureTick::Unchanged, prev_sig));
            }

            let mut jpeg_bytes = Vec::with_capacity((target_w * target_h) as usize / 2);
            let encoder = Encoder::new(&mut jpeg_bytes, quality.clamp(20, 95));
            encoder
                .encode(&self.rgb_buf, target_w as u16, target_h as u16, ColorType::Rgb)
                .map_err(|e| format!("JPEG encode DXGI: {e}"))?;

            Ok((
                NativeCaptureTick::Frame {
                    width: target_w,
                    height: target_h,
                    jpeg_bytes,
                },
                Some(sig),
            ))
        }
    }
}

/// Sessão persistente de captura nativa (DXGI primário para monitores + GDI fallback + janelas + detecção estática).
pub struct NativeCaptureSession {
    source_id: String,
    max_width: u32,
    quality: u8,
    last_sig: Option<u64>,
    last_sent_at: std::time::Instant,
    #[cfg(windows)]
    dxgi: Option<DxgiMonitorCapturer>,
    #[cfg(windows)]
    dxgi_cooldown_until: Option<std::time::Instant>,
}

impl NativeCaptureSession {
    pub fn new(source_id: String, max_width: u32, quality: u8) -> Self {
        #[cfg(windows)]
        let dxgi = if !source_id.starts_with("window:") {
            let mon_idx = source_id
                .split(':')
                .nth(1)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            DxgiMonitorCapturer::new(mon_idx).ok()
        } else {
            None
        };

        Self {
            source_id,
            max_width,
            quality,
            last_sig: None,
            last_sent_at: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(5))
                .unwrap_or_else(std::time::Instant::now),
            #[cfg(windows)]
            dxgi,
            #[cfg(windows)]
            dxgi_cooldown_until: None,
        }
    }

    pub fn next_tick(&mut self) -> Result<NativeCaptureTick, String> {
        let force_refresh = self.last_sent_at.elapsed() >= std::time::Duration::from_millis(1800);

        #[cfg(windows)]
        if !self.source_id.starts_with("window:") {
            if self.dxgi.is_none() {
                let can_retry = self
                    .dxgi_cooldown_until
                    .map(|t| std::time::Instant::now() >= t)
                    .unwrap_or(false);
                if can_retry {
                    let mon_idx = self
                        .source_id
                        .split(':')
                        .nth(1)
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0);
                    self.dxgi = DxgiMonitorCapturer::new(mon_idx).ok();
                    self.dxgi_cooldown_until = if self.dxgi.is_none() {
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(3))
                    } else {
                        None
                    };
                }
            }

            if let Some(ref mut dxgi) = self.dxgi {
                match dxgi.capture_if_changed(self.max_width, self.quality, self.last_sig, force_refresh) {
                    Ok((NativeCaptureTick::Unchanged, sig)) => {
                        self.last_sig = sig;
                        return Ok(NativeCaptureTick::Unchanged);
                    }
                    Ok((NativeCaptureTick::Frame { width, height, jpeg_bytes }, sig)) => {
                        self.last_sig = sig;
                        self.last_sent_at = std::time::Instant::now();
                        return Ok(NativeCaptureTick::Frame { width, height, jpeg_bytes });
                    }
                    Err(err) => {
                        tracing::debug!("DXGI fallback temporário para GDI: {err}");
                        self.dxgi = None;
                        self.dxgi_cooldown_until =
                            Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                    }
                }
            }
        }

        let (width, height, jpeg_bytes) =
            capture_source_jpeg_bytes(&self.source_id, self.max_width, self.quality)?;
        let sig = sample_bytes_signature(&jpeg_bytes, ((width as u64) << 16) ^ (height as u64));
        if !force_refresh && self.last_sig == Some(sig) {
            return Ok(NativeCaptureTick::Unchanged);
        }
        self.last_sig = Some(sig);
        self.last_sent_at = std::time::Instant::now();
        Ok(NativeCaptureTick::Frame {
            width,
            height,
            jpeg_bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_signature_detecta_alteracao() {
        let mut buf = vec![42u8; 4096];
        let s1 = sample_bytes_signature(&buf, 1);
        assert_eq!(s1, sample_bytes_signature(&buf, 1));
        buf[2048] = 99;
        let s2 = sample_bytes_signature(&buf, 1);
        assert_ne!(s1, s2);
    }
}
