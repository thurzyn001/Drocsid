//! Testes de rota HTTP sem socket (rodam dentro do sandbox via `tower::ServiceExt::oneshot`).

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use drocsid::{build_router, security::Secrets, AppState};
use tower::ServiceExt;

const HOST: &str = "token-do-host-de-teste";
const KEY: &str = "0123456789abcdef0123456789abcdef";

fn app() -> Router {
    build_router(AppState::new(3000, Secrets::from_parts(HOST, KEY)))
}

async fn status(req: Request<Body>) -> StatusCode {
    app().oneshot(req).await.unwrap().status()
}

fn get(uri: &str) -> Request<Body> {
    Request::builder().uri(uri).body(Body::empty()).unwrap()
}

fn get_as_host(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn index_and_whoami_are_public() {
    assert_eq!(status(get("/")).await, StatusCode::OK);
    let res = app().oneshot(get("/api/whoami")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["app"], "drocsid");
}

#[tokio::test]
async fn host_only_routes_reject_guests() {
    // P0-1: miniaturas da tela do host e controle do túnel exigem o token do anfitrião
    for uri in ["/api/screens", "/api/tunnel/status"] {
        assert_eq!(status(get(uri)).await, StatusCode::UNAUTHORIZED, "{uri} sem token");
        assert_eq!(
            status(get_as_host(uri, KEY)).await,
            StatusCode::UNAUTHORIZED,
            "{uri}: a chave da sala não pode valer como token do host"
        );
    }
    let post = Request::builder()
        .method("POST")
        .uri("/api/tunnel/start")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(post).await, StatusCode::UNAUTHORIZED);

    let shutdown_no_token = Request::builder()
        .method("POST")
        .uri("/api/shutdown")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(shutdown_no_token).await, StatusCode::UNAUTHORIZED);

    let rotate_no_token = Request::builder()
        .method("POST")
        .uri("/api/room/rotate-key")
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(rotate_no_token).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn host_token_unlocks_tunnel_status() {
    assert_eq!(
        status(get_as_host("/api/tunnel/status", HOST)).await,
        StatusCode::OK
    );
    let rotate_host = Request::builder()
        .method("POST")
        .uri("/api/room/rotate-key")
        .header("authorization", format!("Bearer {HOST}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(status(rotate_host).await, StatusCode::OK);
}

#[tokio::test]
async fn websocket_requires_room_key_before_upgrade() {
    // P0-2: sem chave → 401, antes mesmo do upgrade
    assert_eq!(status(get("/ws")).await, StatusCode::UNAUTHORIZED);
    assert_eq!(status(get("/ws?key=errada")).await, StatusCode::UNAUTHORIZED);
    // Com chave válida a autorização passa; sem cabeçalhos de upgrade → 400
    assert_eq!(
        status(get(&format!("/ws?key={KEY}"))).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(get(&format!("/ws?host={HOST}"))).await,
        StatusCode::BAD_REQUEST
    );
}
