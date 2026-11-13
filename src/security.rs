//! Segredos de sessão e autorização (P0-1 / P0-2).
//!
//! * `host_token`: só a janela local do anfitrião conhece (passado no fragmento `#host=` da URL
//!   aberta pelo próprio processo). Libera recursos sensíveis: captura nativa da tela do host,
//!   miniaturas de monitores, controle do túnel e configurações.
//! * `room_key`: vai dentro do convite. Sem ela o WebSocket da sala é recusado.

use std::sync::{Arc, RwLock};
use axum::http::HeaderMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

#[derive(Debug, Clone)]
pub struct Secrets {
    pub host_token: String,
    pub room_key: Arc<RwLock<String>>,
}

impl Secrets {
    pub fn generate() -> Self {
        Self {
            // 2 x 122 bits aleatórios (getrandom do SO via uuid v4)
            host_token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            // 122 bits aleatórios, 32 caracteres hex
            room_key: Arc::new(RwLock::new(Uuid::new_v4().simple().to_string())),
        }
    }

    pub fn from_parts(host_token: impl Into<String>, room_key: impl Into<String>) -> Self {
        Self {
            host_token: host_token.into(),
            room_key: Arc::new(RwLock::new(room_key.into())),
        }
    }

    pub fn current_room_key(&self) -> String {
        self.room_key.read().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn rotate_room_key(&self) -> String {
        let new_key = Uuid::new_v4().simple().to_string();
        if let Ok(mut g) = self.room_key.write() {
            *g = new_key.clone();
        }
        new_key
    }

    /// Decide o papel de uma conexão WebSocket a partir dos parâmetros `?host=` / `?key=`.
    pub fn authorize(&self, host: Option<&str>, key: Option<&str>) -> Option<Role> {
        if let Some(h) = host {
            if constant_time_eq(h, &self.host_token) {
                return Some(Role::Host);
            }
        }
        let active_key = self.current_room_key();
        if let Some(k) = key {
            if constant_time_eq(k, &active_key) {
                return Some(Role::Guest);
            }
        }
        None
    }

    /// Verifica o cabeçalho `Authorization: Bearer <host_token>` das rotas exclusivas do anfitrião.
    pub fn is_host_request(&self, headers: &HeaderMap) -> bool {
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| constant_time_eq(t.trim(), &self.host_token))
            .unwrap_or(false)
    }
}

/// Comparação em tempo constante (evita vazar o segredo por diferença de tempo de resposta).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn generated_secrets_are_unique_and_long() {
        let a = Secrets::generate();
        let b = Secrets::generate();
        assert_ne!(a.host_token, b.host_token);
        assert_ne!(a.current_room_key(), b.current_room_key());
        assert_eq!(a.host_token.len(), 64);
        assert_eq!(a.current_room_key().len(), 32);
        let old = a.current_room_key();
        let rotated = a.rotate_room_key();
        assert_ne!(old, rotated);
        assert_eq!(a.authorize(None, Some(&old)), None);
        assert_eq!(a.authorize(None, Some(&rotated)), Some(Role::Guest));
    }

    #[test]
    fn authorize_roles() {
        let s = Secrets::from_parts("hosttoken", "roomkey");
        assert_eq!(s.authorize(Some("hosttoken"), None), Some(Role::Host));
        assert_eq!(s.authorize(None, Some("roomkey")), Some(Role::Guest));
        assert_eq!(s.authorize(Some("errado"), Some("roomkey")), Some(Role::Guest));
        assert_eq!(s.authorize(Some("roomkey"), None), None, "a chave da sala não vira host");
        assert_eq!(s.authorize(None, Some("hosttoken")), None, "token do host não vale como key");
        assert_eq!(s.authorize(None, None), None);
    }

    #[test]
    fn bearer_header() {
        let s = Secrets::from_parts("abc", "k");
        let mut h = HeaderMap::new();
        assert!(!s.is_host_request(&h));
        h.insert("authorization", HeaderValue::from_static("Bearer abc"));
        assert!(s.is_host_request(&h));
        h.insert("authorization", HeaderValue::from_static("Bearer abd"));
        assert!(!s.is_host_request(&h));
    }

    #[test]
    fn ct_eq() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
