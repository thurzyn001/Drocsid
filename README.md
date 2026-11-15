# Drocsid — Chat, Voz e Transmissão de Tela entre Amigos

O **Drocsid** é uma plataforma leve e auto-hospedável em **Rust** (`axum` + `tokio` + `DXGI/Win32 GDI` + `WASAPI Loopback` + `WebRTC/WebCodecs` + `Cloudflare/SSH Tunnel`), construída a partir da engenharia reversa da instalação local do **Discord (`app-1.0.9267`)** realizada com o **REA (`morluto/rea`)**.

Ele traz:
- **Transmissão de Tela** em **720p, 1080p ou 1440p a até 60 FPS com áudio do computador**, sem paywalls.
- **Conexão Direta pela Internet (Fora da Mesma Rede e Sem VPN)**: com 1 clique em **📡 Convidar**, o Drocsid abre um link público criptografado, gera um código exclusivo (`DROCSID-xxxx-xxxx`) e conecta seus amigos de qualquer cidade ou operadora.
- **Interface Limpa e Organizada ("Soft")**: controles essenciais à vista, preferências agrupadas em **Opções e Configurações** (com temas **Escuro**, **AMOLED** e **Claro**) e cartões **`? Como funciona`** sob demanda para explicar cada motor apenas se você quiser.
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
2. Na barra lateral esquerda, no cartão **🌐 Convites**, clique em **📡 Convidar**.
3. Em poucos segundos, o cartão expande exibindo seu **Código de Convite** (ex.: `DROCSID-xxxx-xxxx`) e o link público HTTPS com a chave da sala (`#key=...`).
4. Clique em **📋 Copiar** e envie para seus amigos no WhatsApp/Telegram.

> **Dica de bandeja do sistema, links `drocsid://` e logs:** ao abrir o app, um ícone na bandeja do Windows permite reabrir a janela ou encerrar o Drocsid completamente (ou abra **⚙️ Opções e Ajustes → ⏻ Encerrar aplicativo**). Convites `drocsid://` abrem direto no app instalado, e você pode girar a chave da sala a qualquer momento clicando em **🔑**. Os logs (com rotação automática acima de 5 MB) ficam salvos em `%LOCALAPPDATA%\Programs\Drocsid\drocsid.log`.

### Passo 3 — Entrar na Sala do Amigo (De Outra Rede / Cidade)
Seus amigos têm **duas opções**:
- **Opção A (Pelo App Instalado)**: abrem o **Drocsid** instalado no PC deles (ou clicam em um link `drocsid://...`), clicam em **🔗 Entrar** no cartão de Convites, colam o código `DROCSID-xxxx-xxxx` ou o link HTTPS completo e clicam em **Conectar**.
- **Opção B (Direto pelo Link)**: abrem o link `https://xxxx.trycloudflare.com/#key=...` diretamente no navegador.

> **Requisito de HTTPS (Importante):** microfone e transmissão de tela (`getUserMedia` / `getDisplayMedia`) exigem **Contexto Seguro** no navegador (`https://` pelo túnel ou `localhost`). Não utilize URLs `http://IP-da-LAN` para voz ou transmissão — se usar a rede local sem túnel, apenas o host em `127.0.0.1` terá contexto seguro no navegador.
>
> **Capacidade recomendada:** a chamada de voz e vídeo usa topologia **P2P mesh**, funcionando melhor para grupos pequenos de **até 4 ou 5 participantes simultâneos** (limitado principalmente pela banda de upload de quem hospeda ou transmite).

---

## 2. Os 3 Motores de Transmissão de Tela e Recursos (v0.4.0)

Ao clicar em **🖥️ Transmitir Tela**, você pode escolher entre (com cartões opcionais **`? Como funciona`** caso queira ver os detalhes):

1. **⚡ Direto (P2P — Até 60 FPS + Áudio do Computador)**
   - Transmite tela inteira, janela de jogo ou aba em **720p/1080p/1440p a até 60 FPS** com áudio do sistema.
   - Você pode configurar um servidor de apoio (**TURN**) opcional em **⚙️ Configurações → 🌐 Rede e Conexão**. Se a conexão direta falhar para um amigo, o Drocsid alterna automaticamente para o **Modo Compatível**.
2. **🌐 Modo Compatível (Túnel com `WebCodecs VP8` + Fallback JPEG Adaptativo)**
   - Alternativa para redes com UDP bloqueado: negocia automaticamente **WebCodecs VP8 (`DVP\x02`/`DVF\x02`)** quando todos os pares na sala suportam o codec, ou fallback **JPEG (`DVP\x01`/`DVF\x01`)** decodificado com `createImageBitmap`, ajuste adaptativo conforme a fila da conexão e controle de *backpressure*.
3. **🖥️ Captura do PC (Anfitrião — `DXGI 60 FPS` + `WASAPI Loopback`)**
   - Captura **monitores inteiros** via **DXGI Desktop Duplication** a até **60 FPS reais** (com detecção de quadros estáticos e fallback automático para **Win32 GDI**) ou **janelas específicas** (`PrintWindow`/`BitBlt` em [`src/capture.rs`](src/capture.rs)) e, quando habilitado, transmite também o **áudio do sistema via WASAPI Loopback** reamostrado para **24 kHz** ([`src/audio_capture.rs`](src/audio_capture.rs)) com controle de volume independente no palco.

### Recursos Extras na v0.4.0
- **🎛️ Interface Limpa, Temas & Configurações:** título simplificado (`Drocsid`), menu rápido de **Opções e Ajustes**, modal unificado de **Configurações** (temas **Escuro / AMOLED / Claro**, espaçamento **Confortável / Compacto**, detalhes técnicos opcionais na barra superior e guia explicativo sob demanda).
- **🎙️ Voz Avançada:** redução inteligente de ruído por IA (**RNNoise WASM**), captura em `AudioWorklet`, Relay **Opus V2 (`DAP\x02`/`DAF\x02`)** com fallback automático para **μ-law**, medidor **VU Meter**, **Teste de Mic** e **Aperto para Falar (PTT)** configurável (incluindo atalho global no Windows).
- **⊞ Palco Completo:** **Grade Multi-Stream (até 4 telas)** sem flicker, **Modo Teatro**, **Janela Flutuante (PiP)** em todos os motores, **Ponteiro Laser**, **📷 Câmera**, proteção anti-espelho infinito/tela verde ao compartilhar a própria tela (prévia pausada por padrão e protegida na **Tela Cheia**) e divisória palco/chat arrastável.
- **💬 Chat Rico & Upload Seguro:** Markdown completo (`marked` + `DOMPurify`), respostas, reações por emoji, edição/exclusão, **anexar/arrastar/colar imagens e GIFs animados** (`POST /api/upload` / `GET /api/media/:id`) com *lightbox* e **✨ Efeitos sonoros** recolhidos sob demanda.
- **🌐 Convite Prático:** cartão de **Convites** recolhível com **QR Code offline** para celular, botão encerrar link público, alerta de versão diferente no `Welcome`, monitor de saúde SSH e menu completo na bandeja do Windows.
- **🛡️ Moderação & Controle do Anfitrião:** rotação de chave (**🔑**), **Server Mute** (**🔇/🎙️**), **Expulsar (`🚫`)** ou **Banir IP/Sessão (`⛔`)** + **Desbanir Todos**, **Trancar Sala (`🔒/🔓`)** com banner de aprovação, **Excluir Salas (`🗑️`)** e **Limpar Chat (`🧹`)**.

---

## 3. Mapeamento Arquitetural: Discord (`app-1.0.9267`) $\rightarrow$ Drocsid (Rust)

> 📖 **Documentação técnica e regras para IAs:** veja [`ARCHITECTURE.md`](ARCHITECTURE.md) (diagramas de topologia e sequência, módulos Rust, protocolos binários e pipeline de build) e [`AGENTS.md`](AGENTS.md) (regras obrigatórias de autorização, escopo e sincronização de docs para agentes de IA).

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
cargo test --offline
```
Para incluir também os testes E2E com sockets WebSocket locais:
```powershell
cargo test -- --include-ignored
```
Para validar e testar o front-end modular (`web/` $\rightarrow$ `src/ui.html`):
```powershell
npm run build
npm run check
npm test
```
