//! Formato e leitura de convites (P0-2).
//!
//! Formatos aceitos:
//! * `DROCSID-<subdominio>-<chave>` → `https://<subdominio>.trycloudflare.com/#key=<chave>`
//! * `LHR-<subdominio>-<chave>`     → `https://<subdominio>.lhr.life/#key=<chave>`
//! * Link completo `https://host/#key=<chave>` (qualquer domínio)

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    /// Origem sem barra final, ex.: `https://abc-def.trycloudflare.com`
    pub origin: String,
    pub key: String,
}

impl Invite {
    pub fn link(&self) -> String {
        format!("{}/#key={}", self.origin, self.key)
    }

    /// Código curto quando o domínio é conhecido; caso contrário, o link completo.
    pub fn code(&self) -> String {
        let host = self
            .origin
            .strip_prefix("https://")
            .unwrap_or(&self.origin);
        if let Some(sub) = host.strip_suffix(".trycloudflare.com") {
            return format!("DROCSID-{}-{}", sub, self.key);
        }
        if let Some(sub) = host.strip_suffix(".lhr.life") {
            return format!("LHR-{}-{}", sub, self.key);
        }
        self.link()
    }
}

fn is_valid_key(k: &str) -> bool {
    k.len() >= 16 && k.len() <= 128 && k.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_valid_subdomain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

pub fn parse_invite(input: &str) -> Option<Invite> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }

    // Link completo (pode vir colado no meio de um texto)
    if let Some(pos) = s.find("https://").or_else(|| s.find("http://")) {
        let token: String = s[pos..]
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != ')' && *c != '"' && *c != '\'')
            .collect();
        let (base, fragment) = match token.split_once('#') {
            Some((b, f)) => (b, f),
            None => (token.as_str(), ""),
        };
        let origin = base.trim_end_matches('/').to_string();
        let key = fragment
            .split('&')
            .find_map(|kv| kv.strip_prefix("key="))
            .unwrap_or("")
            .to_string();
        if !is_valid_key(&key) {
            return None;
        }
        return Some(Invite { origin, key });
    }

    let upper = s.to_ascii_uppercase();
    let (rest, domain) = if upper.starts_with("DROCSID-") {
        (&s[8..], "trycloudflare.com")
    } else if upper.starts_with("LHR-") {
        (&s[4..], "lhr.life")
    } else {
        return None;
    };

    let (sub, key) = rest.rsplit_once('-')?;
    let sub = sub.to_ascii_lowercase();
    if !is_valid_subdomain(&sub) || !is_valid_key(key) {
        return None;
    }
    Some(Invite {
        origin: format!("https://{sub}.{domain}"),
        key: key.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn cloudflare_roundtrip() {
        let inv = Invite {
            origin: "https://cool-frog-sits-nice.trycloudflare.com".into(),
            key: KEY.into(),
        };
        let code = inv.code();
        assert_eq!(code, format!("DROCSID-cool-frog-sits-nice-{KEY}"));
        assert_eq!(parse_invite(&code), Some(inv.clone()));
        assert_eq!(parse_invite(&inv.link()), Some(inv));
    }

    #[test]
    fn lhr_roundtrip() {
        let inv = Invite {
            origin: "https://a1b2c3d4e5.lhr.life".into(),
            key: KEY.into(),
        };
        assert_eq!(parse_invite(&inv.code()), Some(inv));
    }

    #[test]
    fn link_inside_text_and_lowercase_prefix() {
        let txt = format!("entra aí: https://x-y.trycloudflare.com/#key={KEY} valeu");
        let inv = parse_invite(&txt).unwrap();
        assert_eq!(inv.origin, "https://x-y.trycloudflare.com");
        assert_eq!(inv.key, KEY);
        assert!(parse_invite(&format!("drocsid-x-y-{KEY}")).is_some());
    }

    #[test]
    fn rejects_missing_or_bad_key() {
        assert_eq!(parse_invite("https://x.trycloudflare.com"), None);
        assert_eq!(parse_invite("DROCSID-x-y"), None);
        assert_eq!(parse_invite("DROCSID--abc"), None);
        assert_eq!(parse_invite(&format!("DROCSID-a/b-{KEY}")), None);
        assert_eq!(parse_invite("qualquer coisa"), None);
        assert_eq!(parse_invite(""), None);
    }
}
