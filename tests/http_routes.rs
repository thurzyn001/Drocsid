//! Testes de rota HTTP sem socket (rodam dentro do sandbox via `tower::ServiceExt::oneshot`).

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use drocsid::{build_router, security::Secrets, AppState};
use http_body_util::BodyExt;
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

#[tokio::test]
async fn banned_guest_is_rejected_before_upgrade_and_host_is_immune() {
    let state = AppState::new(3000, Secrets::from_parts(HOST, KEY));
    state.ban_peer(Some("198.51.100.9"), Some("cid_ban_1")).await;
    let router = build_router(state);

    let blocked_by_cid = router
        .clone()
        .oneshot(get(&format!("/ws?key={KEY}&cid=cid_ban_1")))
        .await
        .unwrap();
    assert_eq!(blocked_by_cid.status(), StatusCode::FORBIDDEN);

    let blocked_by_ip = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(&format!("/ws?key={KEY}"))
                .header("cf-connecting-ip", "198.51.100.9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(blocked_by_ip.status(), StatusCode::FORBIDDEN);

    let host_ok = router
        .oneshot(
            Request::builder()
                .uri(&format!("/ws?host={HOST}&cid=cid_ban_1"))
                .header("cf-connecting-ip", "198.51.100.9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(host_ok.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn upload_e_serve_media_validam_auth_e_magic_bytes() {
    let tmp_dir = std::env::temp_dir().join(format!("drocsid_media_test_{}", uuid::Uuid::new_v4()));
    let state = AppState::new(3000, Secrets::from_parts(HOST, KEY));
    *state.media_dir_override.write().await = Some(tmp_dir.clone());
    let router = build_router(state);

    let boundary = "----DrocsidTestBoundary";
    let build_multipart = |payload: &[u8]| -> Body {
        let mut body = Vec::new();
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"img.png\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(payload);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        Body::from(body)
    };

    // Sem credencial -> 401
    let unauth = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload")
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(build_multipart(b"\x89PNG\r\n\x1a\nfake"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    // SVG disfarçado -> 415 Unsupported Media Type
    let svg_res = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/upload?key={KEY}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(build_multipart(b"<svg onload=alert(1)>"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(svg_res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // PNG válido -> 200 OK e entrega protegida por auth
    let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
    let ok_res = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&format!("/api/upload?key={KEY}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(build_multipart(png_bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok_res.status(), StatusCode::OK);
    let raw_json = ok_res.into_body().collect().await.unwrap().to_bytes();
    let meta: serde_json::Value = serde_json::from_slice(&raw_json).unwrap();
    let media_url = meta["url"].as_str().unwrap();
    assert!(media_url.starts_with("/api/media/") && media_url.ends_with(".png"));

    // Download sem auth -> 401
    assert_eq!(
        router.clone().oneshot(get(media_url)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    // Download com auth -> 200 + nosniff + bytes idênticos
    let fetched = router
        .clone()
        .oneshot(get(&format!("{media_url}?key={KEY}")))
        .await
        .unwrap();
    assert_eq!(fetched.status(), StatusCode::OK);
    assert_eq!(fetched.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");
    assert_eq!(fetched.headers().get(header::X_CONTENT_TYPE_OPTIONS).unwrap(), "nosniff");
    let fetched_bytes = fetched.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&fetched_bytes[..], png_bytes);

    // Path traversal -> 400
    assert_eq!(
        router
            .oneshot(get(&format!("/api/media/..%2fsecrets.json?key={KEY}")))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}
