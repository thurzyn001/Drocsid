# Regras para Agentes de IA (`AGENTS.md`)

Este arquivo define regras obrigatórias para qualquer agente de IA (Antigravity, Codex, Claude Code, Cursor, Copilot etc.) que atue neste repositório (**Drocsid**).

---

## 0. Leitura Obrigatória Antes de Qualquer Ação (Markdowns do Projeto)

Antes de responder sobre arquitetura, diagnosticar um bug, propor alterações ou editar qualquer arquivo, **leia primeiro os Markdowns de referência do projeto** para entender o estado atual e não contrariar decisões já tomadas:

1. **[`AGENTS.md`](AGENTS.md):** regras de conduta, escopo e autorização deste repositório.
2. **[`ARCHITECTURE.md`](ARCHITECTURE.md):** visão geral, módulos Rust (`src/*.rs`), SPA embarcada (`src/ui.html`), protocolos binários (`DVP\x01`/`DVF\x01` e `DAP\x01`/`DAF\x01`), WebRTC, segurança e fluxo de build/instalador.
3. **[`README.md`](README.md):** fluxo de uso, requisitos de rede/HTTPS, modos de transmissão e comandos oficiais de compilação e teste.
4. **Checklist / Todo (`todo.md` nos artefatos da sessão ativa ou `TODO.md` no repositório, se existir):** histórico de bugs já corrigidos, decisões pendentes e contexto recente.

> **Regra prática:** se a dúvida puder ser respondida ou contextualizada pelos Markdowns e pelo código atual, leia ambos antes de supor qualquer comportamento.

---

## 1. Autorização Obrigatória Antes de Mudanças

- **Sempre peça autorização explícita do usuário antes de alterar código, scripts, instalador, configurações ou arquitetura**, apresentando de forma objetiva:
  1. Qual é o problema encontrado ou plano proposto;
  2. Quais arquivos e funções serão modificados;
  3. Quais impactos ou riscos existem.
- Se o usuário fizer uma **pergunta, relato de bug ou pedido de investigação** (ex.: *"o que pode ser?"*, *"investigue"*, *"tem alguma alternativa?"*), **apenas investigue, diagnostique e proponha as opções** — **não edite arquivos diretamente** sem confirmação prévia.
- Mesmo após aprovação inicial, se durante a tarefa surgir necessidade de alterar arquivos, dependências (`Cargo.toml`), fluxos de rede, UI ou comportamento fora do escopo aprovado, **pare e peça autorização** antes de prosseguir.
- Comandos destrutivos (`git reset`, `git clean`, `rmdir`, exclusão de arquivos do usuário ou limpeza de dados em `%LOCALAPPDATA%\Programs\Drocsid`) e comandos com acesso externo/rede fora do sandbox exigem autorização explícita.

---

## 2. Escopo Estrito e Tolerância Zero a Regressões

**Nunca altere, reescreva ou quebre algo que não foi pedido no prompt.**

- **Edições cirúrgicas:** modifique apenas os trechos diretamente ligados ao pedido aprovado. Não faça "limpezas", refatorações estilísticas, renomeações em massa ou reorganizações em módulos não solicitados.
- **Preservação da UI embutida ([`src/ui.html`](src/ui.html)):**
  - Trata-se de um SPA único com mais de 4.000 linhas embutido via `include_str!("ui.html")`. **Nunca sobrescreva parcialmente nem trunque `src/ui.html`.**
  - Preserve rigorosamente a inicialização resiliente (`init()`, `renderRooms()`, criação `+`, `connectWebSocket()`), handlers `onclick`/`oninput`, IDs do DOM e separação de streams (`localDisplayStream` vs `localWebcamStream`).
  - Ao alterar desktop, valide que **mobile (`@media (max-width: 900px)`)** não foi quebrado — e vice-versa.
- **Preservação de invariantes de segurança e protocolos:**
  - Nunca enfraqueça `host_token`, `room_key`, `constant_time_eq`, persistência em `secrets.json`, bind padrão em `127.0.0.1` ou filtros de autorização antes do upgrade `/ws` ([`src/security.rs`](src/security.rs), [`src/server.rs`](src/server.rs)).
  - Mantenha compatibilidade dos protocolos JSON (`ClientMessage`/`ServerMessage`) e binários (`DVP\x01`, `DVF\x01`, `DAP\x01`, `DAF\x01` em [`src/protocol.rs`](src/protocol.rs)).
- **Proibido quebrar o build ou os testes existentes:** antes de concluir qualquer alteração aprovada, rode no mínimo:
  - Validação de sintaxe JS e referências de DOM/handlers caso [`src/ui.html`](src/ui.html) tenha sido editado;
  - `cargo test --offline` (e `cargo check` / `cargo build --release` ou `build-installer.ps1` quando aplicável);
  - `git diff` / `git status` para confirmar que nenhuma parte fora do pedido foi tocada.

---

## 3. Documentação Sempre Sincronizada (`todo`, `ARCHITECTURE.md` e `README.md`)

Toda mudança aprovada e implementada **só está concluída** quando a documentação do projeto estiver atualizada com os fatos reais do código:

1. **Checklist / Todo (`todo.md` ou `TODO.md`):**
   - Atualize a lista de tarefas da sessão/projeto (`todo.md` nos artefatos ativos da conversa ou `TODO.md` no repositório, se existir) marcando `[x]` somente após validar testes/build e registrando novos bugs, limitações ou pendências descobertas.
2. **Arquitetura ([`ARCHITECTURE.md`](ARCHITECTURE.md)):**
   - Atualize sempre que houver mudança em módulos Rust (`src/*.rs`), endpoints HTTP/WS, formato de mensagens/protocolos binários, fluxos WebRTC/Relay/Túnel, modelo de segurança, arquivos em `%LOCALAPPDATA%\Programs\Drocsid`, processo de build/instalador ou suíte de testes.
   - Se houver cópia de `ARCHITECTURE.md` em artefato da sessão, mantenha ambas alinhadas.
3. **Guia do Usuário e Repositório ([`README.md`](README.md)):**
   - Atualize instruções de uso, atalhos, recursos visíveis na UI, requisitos de rede/HTTPS, comandos de compilação e status de artefatos distribuídos no Git (como `dist/Drocsid-Setup.exe`).
   - Se o binário final mudar e o repositório distribuir [`dist/Drocsid-Setup.exe`](dist/Drocsid-Setup.exe), recompilar o instalador ([`build-installer.ps1`](build-installer.ps1) / [`compilar-instalador.bat`](compilar-instalador.bat)) deve ser considerado e alinhado com o usuário para não deixar fonte e instalador dessincronizados.

---

## 4. Regras Específicas da Base Drocsid

- **Preservação de contexto e comentários existentes:** não apague nem sobrescreva comentários que documentam o mapeamento de engenharia reversa (**REA**, ex.: ordinais de `discord_voice.node` em [`src/capture.rs`](src/capture.rs)) ou marcações históricas de correções (`P0-*`, `P1-*`, `P2-*`, `B-*`, `T-*`, `U-*`, `I-*`, `F-*`).
- **Leitura cirúrgica em arquivos grandes:** [`src/ui.html`](src/ui.html) possui mais de 4.000 linhas; localize funções/seletores antes de ler intervalos específicos, evitando edições às cegas.
- **Processos filhos, logs e `windows_subsystem`:**
  - Em release ([`src/main.rs`](src/main.rs)), o binário roda sem console (`windows_subsystem = "windows"`); diagnósticos reais de execução ficam em `%LOCALAPPDATA%\Programs\Drocsid\drocsid.log` (com rotação para `drocsid.old.log` acima de 5 MB).
  - Processos do túnel ([`src/tunnel.rs`](src/tunnel.rs)) devem sempre manter `CREATE_NO_WINDOW`, `kill_on_drop(true)` e encerramento limpo pela bandeja ([`src/tray.rs`](src/tray.rs)) / `/api/shutdown` para não deixar `cloudflared.exe` ou `ssh` órfãos.
- **Limitações de Sandbox e Rede Local:**
  - Ambientes sandbox no Windows podem bloquear sockets TCP locais (`127.0.0.1`). Por isso [`tests/http_routes.rs`](tests/http_routes.rs) usa `tower::ServiceExt::oneshot`, enquanto [`tests/ws_e2e.rs`](tests/ws_e2e.rs) usa `#[ignore = "precisa de sockets locais"]`. Não remova nem afrouxe esses testes para "forçar verde".
  - Microfone (`getUserMedia`) e tela (`getDisplayMedia`) no navegador exigem **Contexto Seguro** (`https://` pelo túnel ou `localhost`/`127.0.0.1`); nunca sugira `http://IP-da-LAN` como solução de voz/Go Live em navegadores remotos.
- **Artefatos no Git e Instalador:**
  - Como [`dist/Drocsid-Setup.exe`](dist/Drocsid-Setup.exe) está versionado ([`.gitignore`](.gitignore) ignora apenas `/target` e `/installer/payload.gz`), sempre que houver alteração em `src/` que o usuário pretenda distribuir aos amigos, **lembre e peça autorização antes** para rodar [`build-installer.ps1`](build-installer.ps1) / [`compilar-instalador.bat`](compilar-instalador.bat).
  - Nunca execute `git commit` ou `git push` automaticamente sem pedido explícito do usuário.

---

## 5. Honestidade Técnica e Verificação

- **Nunca reporte testes ou builds como aprovados sem executá-los após a última edição.** Informe exatamente o que passou, o que falhou e o que foi ignorado (como [`tests/ws_e2e.rs`](tests/ws_e2e.rs), marcado com `#[ignore = "precisa de sockets locais"]` em ambientes sem socket local).
- **Cite apenas arquivos, símbolos, constantes e comportamentos verificados diretamente nos arquivos atuais.** Nunca preencha lacunas por suposição.
- **Reproduza o idioma do projeto (`pt-BR`)** em mensagens, comentários novos, documentação e interface.
