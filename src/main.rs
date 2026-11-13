#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tray;

use std::{
    fs::OpenOptions,
    io::{self, ErrorKind},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Mutex,
};

use drocsid::{build_router, security::Secrets, AppState};
use tracing::{info, warn};

fn data_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Programs")
        .join("Drocsid")
}

fn session_url_path() -> Option<PathBuf> {
    Some(data_dir().join("session.url"))
}

fn init_logging() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "drocsid=info".into());

    let log_dir = data_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("drocsid.log");

    // B-5: rotaciona log se ultrapassar 5 MB
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > 5 * 1024 * 1024 {
            let old_path = log_dir.join("drocsid.old.log");
            let _ = std::fs::rename(&log_path, &old_path);
        }
    }

    if let Ok(file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let writer = Mutex::new(file);
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_ansi(false)
            .with_writer(writer)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_writer(io::stderr)
            .init();
    }
}

#[tokio::main]
async fn main() {
    init_logging();

    let args: Vec<String> = std::env::args().collect();
    let headless = args.iter().any(|a| a == "--headless" || a == "--server");
    let auto_tunnel = args.iter().any(|a| a == "--tunnel");
    // P0-3: por padrão só escuta em 127.0.0.1 (o túnel conecta por aí). `--lan` expõe na rede local.
    let lan = args.iter().any(|a| a == "--lan");
    // I-3: suporte ao protocolo drocsid://DROCSID-...
    let protocol_invite: Option<String> = args
        .iter()
        .find(|a| a.to_ascii_lowercase().starts_with("drocsid://"))
        .map(|a| {
            a[10..]
                .trim_matches('/')
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty());

    let port: u16 = std::env::var("DROCSID_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            args.iter()
                .skip_while(|a| *a != "--port" && *a != "-p")
                .nth(1)
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(3000);

    let bind_ip = if lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let addr = SocketAddr::new(bind_ip, port);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(err) => {
            if err.kind() == ErrorKind::AddrInUse {
                warn!("Porta {port} já está em uso ({err}). Tentando reabrir janela da instância ativa.");
                if !headless {
                    if let Some(sess_path) = session_url_path() {
                        if let Ok(saved_url) = std::fs::read_to_string(&sess_path) {
                            let mut target_url = saved_url.trim().to_string();
                            if !target_url.is_empty() {
                                if let Some(ref inv) = protocol_invite {
                                    target_url.push_str(&format!("&invite={inv}"));
                                }
                                open_desktop_window(&target_url);
                            }
                        }
                    }
                }
            } else {
                warn!("Não foi possível abrir a porta {port}: {err}");
            }
            return;
        }
    };

    let secrets = Secrets::load_or_generate(data_dir().join("secrets.json"));
    let host_url = format!("http://127.0.0.1:{port}/#host={}", secrets.host_token);
    if let Some(sess_path) = session_url_path() {
        let _ = std::fs::write(&sess_path, &host_url);
    }
    let launch_url = match protocol_invite {
        Some(ref inv) => format!("{host_url}&invite={inv}"),
        None => host_url.clone(),
    };
    let state = AppState::new(port, secrets);
    state.load_persisted_chat().await;

    if auto_tunnel {
        let tm = state.tunnel.clone();
        tokio::spawn(async move {
            tm.start_tunnel().await;
        });
    }

    info!("Drocsid v{} ouvindo em {addr}", drocsid::VERSION);
    if lan {
        info!(
            "Modo LAN: convidados usam http://<seu-ip>:{port}/#key={} (sem HTTPS, mic/tela não funcionam para eles)",
            state.secrets.current_room_key()
        );
    }
    if headless {
        info!("Modo headless. Janela do anfitrião: {host_url}");
    } else {
        tray::spawn_system_tray(
            host_url.clone(),
            state.clone(),
            tokio::runtime::Handle::current(),
            session_url_path(),
        );
        let url = launch_url;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            open_desktop_window(&url);
        });
    }

    axum::serve(listener, build_router(state))
        .await
        .expect("Erro na execução do servidor HTTP/WS");
}

/// Abre o Drocsid numa janela de aplicativo (Edge/Chrome `--app`), sem barras de navegador.
pub(crate) fn open_desktop_window(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];

        for bin in candidates {
            if std::path::Path::new(bin).exists() {
                let mut args = vec![
                    format!("--app={url}"),
                    "--window-size=1280,800".to_string(),
                    "--autoplay-policy=no-user-gesture-required".to_string(),
                ];
                if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                    let profile_dir = std::path::PathBuf::from(local_app_data)
                        .join("Programs")
                        .join("Drocsid")
                        .join("WebProfile");
                    let _ = std::fs::create_dir_all(&profile_dir);
                    args.push(format!("--user-data-dir={}", profile_dir.display()));
                }
                let _ = std::process::Command::new(bin)
                    .args(&args)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
                return;
            }
        }

        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}
