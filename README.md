# Drocsid — Alternativa Leve ao Discord em Rust (Chat, Voz & Go Live na Internet)

O **Drocsid** é uma recriação enxuta e auto-hospedável em **Rust** (`axum` + `tokio` + `Win32 GDI` + `WebRTC` + `Cloudflare/SSH Tunnel`), construída a partir da engenharia reversa da instalação local do **Discord (`app-1.0.9267`)** realizada com o **REA (`morluto/rea`)**.

Ele traz:
- **Compartilhamento de Tela ("Go Live")** em **720p, 1080p ou 1440p a até 60 FPS com áudio do sistema**, sem paywalls.
- **Conexão Direta pela Internet (Fora da Mesma Rede e Sem VPN)**: com 1 clique em **📡 Gerar Convite**, o Drocsid abre um túnel HTTPS/WSS criptografado, gera uma chave de sala exclusiva (`DROCSID-xxxx-xxxx`) e conecta seus amigos de qualquer cidade ou operadora.
- **Instalador Nativo para Windows (`dist\Drocsid-Setup.exe`)**: assistente gráfico de instalação que cria atalhos na Área de Trabalho e no Menu Iniciar, pronto para você enviar aos seus amigos.

---

## 1. Como Instalar e Usar com Seus Amigos (Em Redes Diferentes)

### Passo 1 — Instalar com o `Drocsid-Setup.exe`
1. Execute o instalador gerado em [`dist/Drocsid-Setup.exe`](dist/Drocsid-Setup.exe).
   > **Aviso do Windows SmartScreen:** como o executável não possui certificado comercial pago, o Windows Defender SmartScreen pode exibir *"O Windows protegeu o computador"*. Clique em **Mais informações** $\rightarrow$ **Executar assim mesmo**.
2. Clique em **Instalar Agora** — ele instalará o aplicativo em `%LOCALAPPDATA%\Programs\Drocsid` e criará o atalho **Drocsid** na sua Área de Trabalho e no Menu Iniciar.
3. Envie o arquivo `Drocsid-Setup.exe` para os seus amigos instalarem no PC deles (ou eles podem acessar diretamente pelo link HTTPS completo gerado no Passo 2).

### Passo 2 — Criar uma Sala na Internet (Quem vai Hospedar)
1. Abra o **Drocsid** pelo atalho da Área de Trabalho.
2. Na barra lateral esquerda, dentro do cartão **🌐 Conexão na Internet**, clique em **📡 Gerar Convite**.
3. Em poucos segundos, aparecerá o seu **Código de Convite** (ex.: `DROCSID-xxxx-xxxx`) e o link público HTTPS com a chave da sala (`#key=...`).
4. Clique em **📋 Copiar** e envie para seus amigos no WhatsApp/Telegram.

> **Dica de bandeja do sistema, links `drocsid://` e logs:** ao abrir o app, um ícone na bandeja do Windows permite reabrir a janela ou encerrar o Drocsid completamente (ou clique em **⏻ Encerrar App**). Convites `drocsid://` abrem direto no app instalado, e você pode girar a chave da sala a qualquer momento clicando em **🔑**. Os logs (com rotação automática acima de 5 MB) ficam salvos em `%LOCALAPPDATA%\Programs\Drocsid\drocsid.log`.

### Passo 3 — Entrar na Sala do Amigo (De Outra Rede / Cidade)
Seus amigos têm **duas opções**:
- **Opção A (Pelo App Instalado)**: abrem o **Drocsid** instalado no PC deles (ou clicam em um link `drocsid://...`), clicam em **🔗 Usar Código**, colam o código `DROCSID-xxxx-xxxx` ou o link HTTPS completo e clicam em **Conectar Agora**.
- **Opção B (Direto pelo Link)**: abrem o link `https://xxxx.trycloudflare.com/#key=...` diretamente no navegador.

> **Requisito de HTTPS (Importante):** microfone e compartilhamento de tela (`getUserMedia` / `getDisplayMedia`) exigem **Contexto Seguro** no navegador (`https://` pelo túnel ou `localhost`). Não utilize URLs `http://IP-da-LAN` para voz ou Go Live — se usar a rede local sem túnel, apenas o host em `127.0.0.1` terá contexto seguro no navegador.
>
> **Capacidade recomendada:** a chamada de voz e vídeo WebRTC usa topologia **P2P mesh**, funcionando melhor para grupos pequenos de **até 4 ou 5 participantes simultâneos** (limitado principalmente pela banda de upload de quem hospeda ou transmite).

---

## 2. Os 3 Motores de Compartilhamento de Tela ("Go Live") e Recursos (v0.3.0)

Ao clicar em **🖥️ Compartilhar Tela (Go Live)**, você pode escolher entre:

1. **⚡ Modo 1: WebRTC + STUN/TURN (Até 60 FPS + Áudio do Sistema)**
   - Usa `getDisplayMedia` + servidores STUN públicos para transmitir tela inteira, janela de jogo ou aba em **720p/1080p/1440p a 30 ou 60 FPS** com áudio do sistema (`soundshare_loopback`).
   - Você pode configurar um servidor **TURN próprio** (botão **⚙️ TURN** na barra lateral) para redes com NAT restrito. Se a conexão ICE WebRTC falhar para um amigo, o Drocsid alterna automaticamente para o **Modo 2 (Relay Universal)** para que a transmissão continue.
2. **🌐 Modo 2: Relay Universal Internet (Anti-CGNAT com Frames Binários + Qualidade Adaptativa)**
   - Alternativa para redes com UDP bloqueado: transmite quadros JPEG em pacotes WebSocket binários (`DVP`/`DVF`) com ajuste automático de qualidade/largura conforme a fila da conexão, controle de **backpressure** (`SignalVideoOutputSinkReady`) e áudio do sistema via WebRTC quando disponível.
3. **🦀 Modo 3: Motor Nativo em Rust (`discord_voice.node` Style)**
   - Captura **monitores inteiros ou janelas específicas** diretamente do processo Rust do anfitrião no Windows (`EnumDisplayMonitors`/`BitBlt` e `PrintWindow` com `PW_RENDERFULLCONTENT` em [`src/capture.rs`](src/capture.rs)) e entrega quadros binários com o protocolo `SignalVideoOutputSinkReady`.

### Recursos Extras na v0.3.0
- **⊞ Grade Multi-Stream (até 4 telas)**, **🎭 Modo Teatro** e divisória palco/chat arrastável.
- **🎯 Ponteiro Laser compartilhado**, **📷 Webcam na chamada**, **🔊 Soundboard sintetizado** e **Ctrl+V** para enviar prints comprimidos no chat (além de `**negrito**`, `` `código` `` e atalhos `Ctrl+M` / `Ctrl+D`).
- **🔑 Rotação de chave de sala**, botão de expulsar participante (anfitrião) e desinstalador com opção de manter ou apagar dados.

---

## 3. Mapeamento Arquitetural: Discord (`app-1.0.9267`) $\rightarrow$ Drocsid (Rust)

| Subsistema no Discord (`app-1.0.9267`) | Evidência REA | Equivalente no Drocsid (Rust) |
| :--- | :--- | :--- |
| **Shell & Bootstrapper** (`Discord.exe` + `resources/app.asar`) | `ev_a456d6cd4f4db97e213f0bcc9f7b6d5169bac97057628dfeee65d205c69dcc90`, `ev_b9a994e3f3de7c81cbc2f9ccddcaacab69ea5cd563d9bf10c8eae1382b87e704` | [`src/main.rs`](src/main.rs) + [`installer/DrocsidSetup.cs`](installer/DrocsidSetup.cs) |
| **Ponte IPC Preload de Captura** (`core.asar` $\rightarrow$ `mainScreenPreload.js`, módulo webpack `9425`: `getDesktopCaptureSources`) | `ev_e27af894eb54719ec54b17c4ea6177d9a6de11745d50c0bccb6121830f37d23b`, `ev_9e643e01cbe70ae9b42848a9c72f353b71fb4a1444b93ebcb9e5aba4c07be372`, `ev_44f8f1cd6e56a807ad1ef51c3b3b8a7e5379b79d46184fbf2344e254253febeb` | `GET /api/screens` em [`src/server.rs`](src/server.rs) + `get_screen_previews()` em [`src/capture.rs`](src/capture.rs) |
| **Descoberta & Miniaturas de Telas** (`?GetScreenPreviews@Discord@@...` ordinal 121 em `discord_voice.node`) | `ev_99c3283860587c6dc542b10eca85cc04377062351db27f36a06b792ce1db598a` | `enumerate_monitors()` + `capture_monitor_jpeg()` em [`src/capture.rs`](src/capture.rs) |
| **Pipeline "Go Live" & Backpressure** (`?SetDesktopSource@...` ordinal 165, `?SetVideoOutputSink@...` ordinal 231, `?SignalVideoOutputSinkReady@...` ordinal 237 em `discord_voice.node`) | `ev_99c3283860587c6dc542b10eca85cc04377062351db27f36a06b792ce1db598a` | `relay_video_frame_with_backpressure()` em [`src/state.rs`](src/state.rs) + `SignalVideoOutputSinkReady` em [`src/protocol.rs`](src/protocol.rs) |
| **Túnel Público & Travessia de Rede** | Decisão de projeto para substituir a nuvem proprietária do Discord | [`src/tunnel.rs`](src/tunnel.rs) (Cloudflare Quick Tunnel + OpenSSH fallback + TURN configurável) |

---

## 4. Como Baixar ou Compilar pelo Repositório

Quem clonar o repositório (`git clone https://github.com/thurzyn001/Drocsid.git`) tem **duas formas** de usar:

### Opção A — Usar o instalador já pronto (Sem precisar compilar)
O instalador já vem pronto dentro da pasta `dist` do repositório:
1. Abra a pasta `dist` e execute [`dist/Drocsid-Setup.exe`](dist/Drocsid-Setup.exe) (ou baixe direto o arquivo `dist/Drocsid-Setup.exe` pela página do GitHub).

---

### Opção B — Compilar do código-fonte na sua máquina

#### 1. Pré-requisito (apenas na 1ª vez)
Ter o **Rust** instalado no Windows:
```powershell
winget install Rustlang.Rustup
```
*(Após instalar o Rust pela primeira vez, feche e reabra o terminal).*

#### 2. Gerar o instalador `dist\Drocsid-Setup.exe`
Dê dois cliques no arquivo **`compilar-instalador.bat`** na raiz do projeto, ou rode no terminal:
```powershell
.\compilar-instalador.bat
```
*(Se preferir chamar o script PowerShell diretamente sem bloqueio de política de execução do Windows)*:
```powershell
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
```

#### 3. Ou rodar o app direto pelo Cargo (sem instalador)
```powershell
cargo run --release
```

#### 4. Rodar os testes automatizados
```powershell
cargo test
```
Para incluir também os testes E2E com sockets WebSocket locais:
```powershell
cargo test -- --include-ignored
```
