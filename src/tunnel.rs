use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::RwLock,
};
use tracing::{info, warn};

use crate::invite::Invite;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub active: bool,
    pub provider: String,
    pub public_url: Option<String>,
    pub invite_code: Option<String>,
    pub invite_link: Option<String>,
    pub status_message: String,
}

impl Default for TunnelStatus {
    fn default() -> Self {
        Self {
            active: false,
            provider: "none".to_string(),
            public_url: None,
            invite_code: None,
            invite_link: None,
            status_message: "Modo Local (Clique em 'Gerar Link p/ Amigos na Internet' para abrir sala remota)".to_string(),
        }
    }
}

pub struct TunnelManager {
    pub status: RwLock<TunnelStatus>,
    pub child: RwLock<Option<Child>>,
    pub port: u16,
    pub room_key: RwLock<String>,
}

impl TunnelManager {
    pub fn new(port: u16, room_key: String) -> Arc<Self> {
        Arc::new(Self {
            status: RwLock::new(TunnelStatus::default()),
            child: RwLock::new(None),
            port,
            room_key: RwLock::new(room_key),
        })
    }

    pub async fn update_room_key(&self, new_key: String) -> TunnelStatus {
        *self.room_key.write().await = new_key.clone();
        let mut st = self.status.write().await;
        if st.active {
            if let Some(url) = st.public_url.as_ref() {
                let inv = Invite {
                    origin: url.trim_end_matches('/').to_string(),
                    key: new_key,
                };
                st.invite_code = Some(inv.code());
                st.invite_link = Some(inv.link());
            }
        }
        st.clone()
    }

    pub async fn get_status(&self) -> TunnelStatus {
        self.status.read().await.clone()
    }

    pub async fn stop_tunnel(&self) -> TunnelStatus {
        if let Some(mut child) = self.child.write().await.take() {
            let _ = child.kill().await;
        }
        let mut st = self.status.write().await;
        *st = TunnelStatus::default();
        st.clone()
    }

    /// Inicia um túnel público HTTPS/WSS automático (Cloudflare Quick Tunnel ou OpenSSH localhost.run)
    /// para que amigos em outras redes/cidades conectem sem precisar abrir portas no roteador nem usar VPN.
    pub async fn start_tunnel(self: Arc<Self>) -> TunnelStatus {
        {
            let st = self.status.read().await;
            if st.active && st.public_url.is_some() {
                return st.clone();
            }
        }

        self.stop_tunnel().await;

        {
            let mut st = self.status.write().await;
            st.active = true;
            st.provider = "starting".to_string();
            st.public_url = None;
            st.invite_code = None;
            st.invite_link = None;
            st.status_message =
                "Verificando/baixando motor Cloudflare (~35 MB na 1ª vez)...".to_string();
        }

        let manager = self.clone();
        tokio::spawn(async move {
            // Tenta primeiro o Cloudflare Quick Tunnel (baixa o binário oficial se necessário)
            if let Some(cf_path) = ensure_cloudflared_binary().await {
                if manager.launch_cloudflared(cf_path).await.is_ok() {
                    return;
                }
            }

            // Fallback automático: OpenSSH nativo do Windows (localhost.run)
            if let Err(err) = manager.launch_ssh_localhost_run().await {
                let mut st = manager.status.write().await;
                st.active = false;
                st.provider = "error".to_string();
                st.status_message = format!("Não foi possível iniciar o túnel automático: {err}");
            }
        });

        self.get_status().await
    }

    async fn launch_cloudflared(self: &Arc<Self>, bin_path: PathBuf) -> Result<(), String> {
        info!("Iniciando Cloudflare Quick Tunnel usando {:?}", bin_path);
        {
            let mut st = self.status.write().await;
            st.provider = "Cloudflare Quick Tunnel".to_string();
            st.status_message = "Negociando rota pública via Cloudflare Edge...".to_string();
        }

        let mut cmd = Command::new(bin_path);
        cmd.args([
            "tunnel",
            "--url",
            &format!("http://127.0.0.1:{}", self.port),
            "--no-autoupdate",
        ])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Falha ao executar cloudflared: {e}"))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Sem stderr do cloudflared".to_string())?;

        *self.child.write().await = Some(child);

        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(url) = extract_https_url(&line, ".trycloudflare.com") {
                let current_key = self.room_key.read().await.clone();
                let inv = Invite {
                    origin: url.trim_end_matches('/').to_string(),
                    key: current_key,
                };
                let invite = inv.code();
                let invite_link = inv.link();
                info!("Túnel público ativo: {}", url);
                {
                    let mut st = self.status.write().await;
                    st.active = true;
                    st.provider = "Cloudflare Quick Tunnel".to_string();
                    st.public_url = Some(url.clone());
                    st.invite_code = Some(invite);
                    st.invite_link = Some(invite_link);
                    st.status_message = "Online na Internet! Envie o convite aos amigos.".to_string();
                }

                // B-2: continua drenando stderr para evitar Broken pipe e detectar queda do túnel
                let mgr = self.clone();
                let active_url = url;
                tokio::spawn(async move {
                    while let Ok(Some(_)) = reader.next_line().await {}
                    let mut st = mgr.status.write().await;
                    if st.active && st.public_url.as_deref() == Some(active_url.as_str()) {
                        warn!("Processo cloudflared encerrou inesperadamente.");
                        st.active = false;
                        st.provider = "error".to_string();
                        st.status_message =
                            "O túnel caiu inesperadamente. Clique em 'Gerar Convite' para reconectar."
                                .to_string();
                    }
                });
                return Ok(());
            }
        }

        Err("O processo cloudflared encerrou antes de emitir a URL".to_string())
    }

    async fn launch_ssh_localhost_run(&self) -> Result<(), String> {
        info!("Iniciando túnel via OpenSSH (localhost.run)...");
        {
            let mut st = self.status.write().await;
            st.provider = "OpenSSH Tunnel (localhost.run)".to_string();
            st.status_message = "Conectando túnel via OpenSSH nativo...".to_string();
        }

        let mut cmd = Command::new("ssh");
        cmd.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=30",
            "-R",
            &format!("80:127.0.0.1:{}", self.port),
            "nokey@localhost.run",
        ])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Falha ao iniciar ssh: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Sem stdout do ssh".to_string())?;

        *self.child.write().await = Some(child);

        let room_key = self.room_key.read().await.clone();
        let read_fut = async {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(url) = extract_https_url(&line, ".lhr.life") {
                    let inv = Invite {
                        origin: url.trim_end_matches('/').to_string(),
                        key: room_key,
                    };
                    let invite = inv.code();
                    let invite_link = inv.link();
                    info!("Túnel SSH ativo: {}", url);
                    let mut st = self.status.write().await;
                    st.active = true;
                    st.provider = "OpenSSH (localhost.run)".to_string();
                    st.public_url = Some(url);
                    st.invite_code = Some(invite);
                    st.invite_link = Some(invite_link);
                    st.status_message = "Online na Internet via SSH Tunnel!".to_string();
                    return Ok(());
                }
            }
            Err("Túnel SSH encerrou sem retornar URL".to_string())
        };

        match tokio::time::timeout(Duration::from_secs(15), read_fut).await {
            Ok(res) => res,
            Err(_) => {
                self.stop_tunnel().await;
                Err("Timeout (15s) ao aguardar URL do túnel OpenSSH".to_string())
            }
        }
    }
}

/// Verifica se o arquivo existe, tem tamanho plausível (> 5 MB) e assinatura PE ("MZ") no Windows.
fn is_valid_pe_binary(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() <= 5_000_000 {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 2];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    if cfg!(windows) {
        &magic == b"MZ"
    } else {
        true
    }
}

/// Procura ou baixa automaticamente o binário oficial `cloudflared.exe` no diretório de dados do app.
async fn ensure_cloudflared_binary() -> Option<PathBuf> {
    let local_dir = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Programs")
        .join("Drocsid");

    let _ = std::fs::create_dir_all(&local_dir);
    let target_bin = local_dir.join(if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    });

    if target_bin.exists() {
        if is_valid_pe_binary(&target_bin) {
            return Some(target_bin);
        }
        warn!("Binário cloudflared existente inválido/corrompido; removendo {:?}", target_bin);
        let _ = std::fs::remove_file(&target_bin);
    }

    // Verifica se já está instalado no PATH do sistema
    if let Ok(output) = Command::new("cloudflared").arg("--version").output().await {
        if output.status.success() {
            return Some(PathBuf::from("cloudflared"));
        }
    }

    #[cfg(windows)]
    {
        info!("Baixando cloudflared-windows-amd64.exe oficial para túnel P2P/Internet...");
        let url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
        let mut cmd = Command::new("curl.exe");
        cmd.args([
            "-L",
            "--silent",
            "--show-error",
            "--fail",
            "-o",
            &target_bin.to_string_lossy(),
            url,
        ]);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.status().await {
            Ok(status) if status.success() && is_valid_pe_binary(&target_bin) => {
                info!("cloudflared.exe baixado com sucesso em {:?}", target_bin);
                return Some(target_bin);
            }
            Ok(st) => {
                warn!("curl retornou status {} ou binário inválido ao baixar cloudflared", st);
                let _ = std::fs::remove_file(&target_bin);
            }
            Err(e) => {
                warn!("Erro ao executar curl para baixar cloudflared: {e}");
                let _ = std::fs::remove_file(&target_bin);
            }
        }
    }

    None
}

fn extract_https_url(line: &str, domain_suffix: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let trimmed = token.trim_matches(|c: char| c == '"' || c == '\'' || c == '|' || c == ',');
        if trimmed.starts_with("https://") && trimmed.contains(domain_suffix) {
            return Some(trimmed.to_string());
        }
    }
    None
}
