//! Testes ponta a ponta com sockets reais (servidor + clientes WebSocket).
//!
//! O sandbox de desenvolvimento bloqueia sockets locais, por isso ficam marcados com `#[ignore]`.
//! Para rodar: `cargo test -- --include-ignored`

use std::time::Duration;

use drocsid::{build_router, security::Secrets, AppState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

const HOST: &str = "token-do-host-e2e";
const KEY: &str = "fedcba9876543210fedcba9876543210";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn spawn_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = AppState::new(addr.port(), Secrets::from_parts(HOST, KEY));
    tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });
    format!("ws://{addr}/ws")
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string())).await.unwrap();
}

/// Lê mensagens até achar uma do tipo pedido (ignora as outras), com timeout.
async fn recv_type(ws: &mut Ws, ty: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v["type"] == ty {
                        return v;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("conexão encerrada esperando {ty}: {other:?}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timeout esperando {ty}"))
}

async fn join(url: &str, auth: &str, name: &str) -> (Ws, Value) {
    let (mut ws, _) = connect_async(format!("{url}?{auth}")).await.unwrap();
    let welcome = recv_type(&mut ws, "welcome").await;
    send(&mut ws, json!({"type":"join_room","username":name,"room":"geral"})).await;
    recv_type(&mut ws, "room_state").await;
    (ws, welcome)
}

#[tokio::test]
#[ignore = "precisa de sockets locais"]
async fn rejects_connection_without_key() {
    let url = spawn_server().await;
    assert!(connect_async(url.clone()).await.is_err());
    assert!(connect_async(format!("{url}?key=errada")).await.is_err());
}

#[tokio::test]
#[ignore = "precisa de sockets locais"]
async fn roles_and_chat() {
    let url = spawn_server().await;
    let (mut host, w_host) = join(&url, &format!("host={HOST}"), "Anfitriao").await;
    let (mut guest, w_guest) = join(&url, &format!("key={KEY}"), "Amigo").await;
    assert_eq!(w_host["is_host"], true);
    assert_eq!(w_guest["is_host"], false);

    send(&mut guest, json!({"type":"chat_message","text":"olá"})).await;
    let got = recv_type(&mut host, "chat_broadcast").await;
    assert_eq!(got["entry"]["text"], "olá");
    assert_eq!(got["entry"]["username"], "Amigo");
}

#[tokio::test]
#[ignore = "precisa de sockets locais"]
async fn guest_cannot_start_native_host_capture() {
    let url = spawn_server().await;
    let (mut guest, _) = join(&url, &format!("key={KEY}"), "Intruso").await;
    send(
        &mut guest,
        json!({"type":"start_screen_share","mode":"native_host","source_id":"screen:0:0",
               "source_name":"x","width":1280,"height":720,"fps":10,"has_audio":false,"quality":50}),
    )
    .await;
    let err = recv_type(&mut guest, "error").await;
    assert!(err["message"].as_str().unwrap().contains("anfitrião"));
}
