//! Drocsid — chat, voz e compartilhamento de tela entre amigos.

pub mod capture;
pub mod invite;
pub mod protocol;
pub mod security;
pub mod server;
pub mod state;
pub mod tunnel;

pub use server::{build_router, VERSION};
pub use state::AppState;
