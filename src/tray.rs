//! Ícone nativo na Bandeja do Sistema (System Tray) do Windows via FFI (`shell32` + `user32`),
//! sem dependências externas (I-1). Permite reabrir a janela ou encerrar o Drocsid em 2º plano.

#[cfg(windows)]
pub fn spawn_system_tray(
    host_url: String,
    state: std::sync::Arc<drocsid::AppState>,
    runtime: tokio::runtime::Handle,
    session_file: Option<std::path::PathBuf>,
) {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::{null, null_mut};
    use std::sync::OnceLock;

    type HWND = *mut c_void;
    type HINSTANCE = *mut c_void;
    type HICON = *mut c_void;
    type HCURSOR = *mut c_void;
    type HBRUSH = *mut c_void;
    type HMENU = *mut c_void;
    type BOOL = i32;
    type UINT = u32;
    type DWORD = u32;
    type LRESULT = isize;
    type WPARAM = usize;
    type LPARAM = isize;
    type WndProc = unsafe extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT;

    const WM_DESTROY: UINT = 0x0002;
    const WM_COMMAND: UINT = 0x0111;
    const WM_APP: UINT = 0x8000;
    const WM_TRAY: UINT = WM_APP + 1;
    const WM_LBUTTONUP: LPARAM = 0x0202;
    const WM_LBUTTONDBLCLK: LPARAM = 0x0203;
    const WM_RBUTTONUP: LPARAM = 0x0205;

    const NIM_ADD: DWORD = 0;
    const NIM_DELETE: DWORD = 2;
    const NIF_MESSAGE: UINT = 0x01;
    const NIF_ICON: UINT = 0x02;
    const NIF_TIP: UINT = 0x04;

    const MF_STRING: UINT = 0x0000;
    const TPM_RIGHTBUTTON: UINT = 0x0002;
    const IDI_APPLICATION: *const u16 = 32512usize as *const u16;
    const IMAGE_ICON: UINT = 1;
    const LR_LOADFROMFILE: UINT = 0x0010;
    const LR_DEFAULTSIZE: UINT = 0x0040;

    const CMD_OPEN: usize = 1001;
    const CMD_EXIT: usize = 1002;

    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct MSG {
        hwnd: HWND,
        message: UINT,
        w_param: WPARAM,
        l_param: LPARAM,
        time: DWORD,
        pt: POINT,
        l_private: DWORD,
    }

    #[repr(C)]
    struct WNDCLASSW {
        style: UINT,
        lpfn_wnd_proc: WndProc,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: HINSTANCE,
        h_icon: HICON,
        h_cursor: HCURSOR,
        hbr_background: HBRUSH,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
    }

    #[repr(C)]
    struct NOTIFYICONDATAW {
        cb_size: DWORD,
        h_wnd: HWND,
        u_id: UINT,
        u_flags: UINT,
        u_callback_message: UINT,
        h_icon: HICON,
        sz_tip: [u16; 128],
        dw_state: DWORD,
        dw_state_mask: DWORD,
        sz_info: [u16; 256],
        u_timeout_or_version: UINT,
        sz_info_title: [u16; 64],
        dw_info_flags: DWORD,
        guid_item: [u8; 16],
        h_balloon_icon: HICON,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(lp_module_name: *const u16) -> HINSTANCE;
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(lp_wnd_class: *const WNDCLASSW) -> u16;
        fn CreateWindowExW(
            dw_ex_style: DWORD,
            lp_class_name: *const u16,
            lp_window_name: *const u16,
            dw_style: DWORD,
            x: i32,
            y: i32,
            n_width: i32,
            n_height: i32,
            h_wnd_parent: HWND,
            h_menu: HMENU,
            h_instance: HINSTANCE,
            lp_param: *mut c_void,
        ) -> HWND;
        fn DefWindowProcW(h_wnd: HWND, msg: UINT, w_param: WPARAM, l_param: LPARAM) -> LRESULT;
        fn GetMessageW(lp_msg: *mut MSG, h_wnd: HWND, w_msg_filter_min: UINT, w_msg_filter_max: UINT) -> BOOL;
        fn TranslateMessage(lp_msg: *const MSG) -> BOOL;
        fn DispatchMessageW(lp_msg: *const MSG) -> LRESULT;
        fn PostQuitMessage(n_exit_code: i32);
        fn LoadIconW(h_instance: HINSTANCE, lp_icon_name: *const u16) -> HICON;
        fn LoadImageW(
            h_inst: HINSTANCE,
            name: *const u16,
            u_type: UINT,
            cx: i32,
            cy: i32,
            fu_load: UINT,
        ) -> *mut c_void;
        fn CreatePopupMenu() -> HMENU;
        fn AppendMenuW(h_menu: HMENU, u_flags: UINT, u_id_new_item: usize, lp_new_item: *const u16) -> BOOL;
        fn TrackPopupMenu(
            h_menu: HMENU,
            u_flags: UINT,
            x: i32,
            y: i32,
            n_reserved: i32,
            h_wnd: HWND,
            prc_rect: *const c_void,
        ) -> BOOL;
        fn DestroyMenu(h_menu: HMENU) -> BOOL;
        fn GetCursorPos(lp_point: *mut POINT) -> BOOL;
        fn SetForegroundWindow(h_wnd: HWND) -> BOOL;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn Shell_NotifyIconW(dw_message: DWORD, lp_data: *const NOTIFYICONDATAW) -> BOOL;
    }

    struct TrayCtx {
        host_url: String,
        state: std::sync::Arc<drocsid::AppState>,
        runtime: tokio::runtime::Handle,
        session_file: Option<std::path::PathBuf>,
    }

    static TRAY_CTX: OnceLock<TrayCtx> = OnceLock::new();
    let _ = TRAY_CTX.set(TrayCtx {
        host_url,
        state,
        runtime,
        session_file,
    });

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn shutdown_app(hwnd: HWND) {
        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cb_size = size_of::<NOTIFYICONDATAW>() as DWORD;
        nid.h_wnd = hwnd;
        nid.u_id = 1;
        Shell_NotifyIconW(NIM_DELETE, &nid);
        if let Some(ctx) = TRAY_CTX.get() {
            if let Some(ref p) = ctx.session_file {
                let _ = std::fs::remove_file(p);
            }
            let st = ctx.state.clone();
            ctx.runtime.block_on(async move {
                st.tunnel.stop_tunnel().await;
            });
        }
        PostQuitMessage(0);
        std::process::exit(0);
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: UINT,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_TRAY => {
                if l_param == WM_LBUTTONUP || l_param == WM_LBUTTONDBLCLK {
                    if let Some(ctx) = TRAY_CTX.get() {
                        crate::open_desktop_window(&ctx.host_url);
                    }
                } else if l_param == WM_RBUTTONUP {
                    let menu = CreatePopupMenu();
                    if !menu.is_null() {
                        let open_txt = to_wide("Abrir Drocsid");
                        let exit_txt = to_wide("Encerrar Drocsid");
                        AppendMenuW(menu, MF_STRING, CMD_OPEN, open_txt.as_ptr());
                        AppendMenuW(menu, MF_STRING, CMD_EXIT, exit_txt.as_ptr());
                        let mut pt = POINT { x: 0, y: 0 };
                        GetCursorPos(&mut pt);
                        SetForegroundWindow(hwnd);
                        TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, null());
                        DestroyMenu(menu);
                    }
                }
                0
            }
            WM_COMMAND => {
                let cmd_id = w_param & 0xFFFF;
                if cmd_id == CMD_OPEN {
                    if let Some(ctx) = TRAY_CTX.get() {
                        crate::open_desktop_window(&ctx.host_url);
                    }
                } else if cmd_id == CMD_EXIT {
                    shutdown_app(hwnd);
                }
                0
            }
            WM_DESTROY => {
                shutdown_app(hwnd);
                0
            }
            _ => DefWindowProcW(hwnd, msg, w_param, l_param),
        }
    }

    std::thread::spawn(move || unsafe {
        let h_inst = GetModuleHandleW(null());
        let cls_name = to_wide("DrocsidTrayWndClass");
        let wc = WNDCLASSW {
            style: 0,
            lpfn_wnd_proc: wnd_proc,
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: h_inst,
            h_icon: null_mut(),
            h_cursor: null_mut(),
            hbr_background: null_mut(),
            lpsz_menu_name: null(),
            lpsz_class_name: cls_name.as_ptr(),
        };
        RegisterClassW(&wc);

        let wnd_title = to_wide("Drocsid Tray");
        let hwnd = CreateWindowExW(
            0,
            cls_name.as_ptr(),
            wnd_title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            h_inst,
            null_mut(),
        );
        if hwnd.is_null() {
            return;
        }

        let mut h_icon: HICON = null_mut();
        if let Some(local_dir) = std::env::var_os("LOCALAPPDATA") {
            let ico_path = std::path::PathBuf::from(local_dir)
                .join("Programs")
                .join("Drocsid")
                .join("drocsid.ico");
            if ico_path.exists() {
                let wpath = to_wide(&ico_path.to_string_lossy());
                h_icon = LoadImageW(
                    null_mut(),
                    wpath.as_ptr(),
                    IMAGE_ICON,
                    0,
                    0,
                    LR_LOADFROMFILE | LR_DEFAULTSIZE,
                );
            }
        }
        if h_icon.is_null() {
            h_icon = LoadIconW(null_mut(), IDI_APPLICATION);
        }

        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cb_size = size_of::<NOTIFYICONDATAW>() as DWORD;
        nid.h_wnd = hwnd;
        nid.u_id = 1;
        nid.u_flags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        nid.u_callback_message = WM_TRAY;
        nid.h_icon = h_icon;
        let tip = "Drocsid — Chat, Voz & Go Live";
        for (i, ch) in tip.encode_utf16().take(127).enumerate() {
            nid.sz_tip[i] = ch;
        }
        Shell_NotifyIconW(NIM_ADD, &nid);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(not(windows))]
pub fn spawn_system_tray(
    _host_url: String,
    _state: std::sync::Arc<drocsid::AppState>,
    _runtime: tokio::runtime::Handle,
    _session_file: Option<std::path::PathBuf>,
) {
}
