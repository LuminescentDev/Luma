//! Device-local OpenSSH agent access.
//!
//! Agent-backed keys (including FIDO2 `sk-*` keys and keys guarded by a
//! platform provider such as 1Password) never expose private material to Luma.
//! The agent performs every signature and owns user-presence/biometric prompts.

use russh::keys::agent::client::{AgentClient, AgentStream};

use crate::errors::{LumaError, Result};

pub(crate) type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;
pub(crate) type DynamicAgentStream = Box<dyn AgentStream + Send + Unpin + 'static>;

pub(crate) async fn connect_client() -> Result<DynamicAgentClient> {
    // Exactly one of these blocks survives cfg expansion on any given target,
    // so each is written as the function's tail expression.
    #[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
    {
        AgentClient::connect_env()
            .await
            .map(AgentClient::dynamic)
            .map_err(agent_error)
    }

    #[cfg(windows)]
    {
        const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
        if let Ok(client) = AgentClient::connect_named_pipe(OPENSSH_PIPE).await {
            return Ok(client.dynamic());
        }
        AgentClient::connect_pageant()
            .await
            .map(AgentClient::dynamic)
            .map_err(agent_error)
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Err(LumaError::KeyUnavailable(
            "SSH-agent and hardware-backed keys are device-bound and unavailable on mobile".into(),
        ))
    }
}

pub(crate) async fn connect_stream() -> Result<DynamicAgentStream> {
    connect_client().await.map(AgentClient::into_inner)
}

fn agent_error(error: russh::keys::Error) -> LumaError {
    LumaError::KeyUnavailable(format!(
        "no usable SSH agent was found on this device: {error}"
    ))
}
