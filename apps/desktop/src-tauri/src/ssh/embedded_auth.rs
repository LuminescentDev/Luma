use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg};
use russh::{MethodKind, MethodSet};
use serde::Serialize;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use super::embedded::{Client, Control, EmbeddedSshTimeouts, PingFailure, SharedDataCallback};
use super::SshConnectionConfig;
use crate::errors::{LumaError, Result};

const PROMPT_MARKER: &str = "__LUMA_SSH_PROMPT__";
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_PROMPT_ATTEMPTS: usize = 3;
const MAX_KEYBOARD_INTERACTIVE_ROUNDS: usize = 16;
const MAX_AUTH_METHOD_ATTEMPTS: usize = 12;

#[derive(Debug)]
pub(super) enum AuthAbort {
    Disconnect,
    Error(LumaError),
}

pub(super) struct AuthDriver {
    control_rx: mpsc::UnboundedReceiver<Control>,
    answers: VecDeque<Zeroizing<String>>,
    partial_answer: Zeroizing<String>,
    swallow_lf: bool,
    dimensions: (u16, u16),
}

impl AuthDriver {
    pub(super) fn new(control_rx: mpsc::UnboundedReceiver<Control>, cols: u16, rows: u16) -> Self {
        Self {
            control_rx,
            answers: VecDeque::new(),
            partial_answer: Zeroizing::new(String::new()),
            swallow_lf: false,
            dimensions: (cols, rows),
        }
    }

    pub(super) fn into_parts(self) -> (mpsc::UnboundedReceiver<Control>, (u16, u16)) {
        (self.control_rx, self.dimensions)
    }

    async fn operation<T, F>(
        &mut self,
        timeout: Duration,
        timeout_message: &'static str,
        operation: F,
    ) -> std::result::Result<T, AuthAbort>
    where
        F: Future<Output = std::result::Result<T, russh::Error>>,
    {
        tokio::pin!(operation);
        let timeout = tokio::time::sleep(timeout);
        tokio::pin!(timeout);
        loop {
            tokio::select! {
                result = &mut operation => return result.map_err(|error| AuthAbort::Error(super::embedded::connect_error(error))),
                _ = &mut timeout => {
                    return Err(AuthAbort::Error(LumaError::SshConnection {
                        category: "timeout",
                        message: timeout_message.into(),
                    }));
                }
                control = self.control_rx.recv() => self.handle_control(control)?,
            }
        }
    }

    async fn answer(&mut self) -> std::result::Result<Zeroizing<String>, AuthAbort> {
        if let Some(answer) = self.answers.pop_front() {
            return Ok(answer);
        }
        tokio::time::timeout(PROMPT_TIMEOUT, async {
            loop {
                let control = self.control_rx.recv().await;
                self.handle_control(control)?;
                if let Some(answer) = self.answers.pop_front() {
                    return Ok(answer);
                }
            }
        })
        .await
        .map_err(|_| {
            AuthAbort::Error(LumaError::SshConnection {
                category: "auth-failed",
                message: "SSH authentication timed out waiting for a credential".into(),
            })
        })?
    }

    fn handle_control(&mut self, control: Option<Control>) -> std::result::Result<(), AuthAbort> {
        match control {
            Some(Control::Write(data)) => {
                self.push_input(&String::from_utf8_lossy(&data));
                Ok(())
            }
            Some(Control::Resize(cols, rows)) => {
                self.dimensions = (cols, rows);
                Ok(())
            }
            Some(Control::Ping(reply)) => {
                let _ = reply.send(Err(PingFailure::Authenticating));
                Ok(())
            }
            Some(Control::Disconnect) | None => Err(AuthAbort::Disconnect),
        }
    }

    fn push_input(&mut self, input: &str) {
        for character in input.chars() {
            match character {
                '\r' => {
                    self.answers
                        .push_back(Zeroizing::new(std::mem::take(&mut *self.partial_answer)));
                    self.swallow_lf = true;
                }
                '\n' if self.swallow_lf => self.swallow_lf = false,
                '\n' => {
                    self.answers
                        .push_back(Zeroizing::new(std::mem::take(&mut *self.partial_answer)));
                }
                _ => {
                    self.swallow_lf = false;
                    self.partial_answer.push(character);
                }
            }
        }
    }
}

#[derive(Serialize)]
struct PromptMarker<'a> {
    label: &'a str,
    secret: bool,
    target: &'a str,
}

fn emit(on_data: &SharedDataCallback, bytes: &[u8]) {
    (on_data.lock().unwrap())(bytes);
}

fn emit_text(on_data: &SharedDataCallback, text: &str) {
    emit(on_data, text.as_bytes());
}

async fn prompt(
    driver: &mut AuthDriver,
    on_data: &SharedDataCallback,
    label: &str,
    secret: bool,
    target: &str,
    text: &str,
) -> std::result::Result<Zeroizing<String>, AuthAbort> {
    let marker = serde_json::to_string(&PromptMarker {
        label,
        secret,
        target,
    })
    .map_err(|error| {
        AuthAbort::Error(LumaError::SshConnection {
            category: "ssh-error",
            message: format!("could not encode SSH credential prompt: {error}"),
        })
    })?;
    emit_text(on_data, &format!("{PROMPT_MARKER}{marker}\r\n{text}"));
    driver.answer().await
}

fn method_available(methods: &MethodSet, method: MethodKind) -> bool {
    methods.contains(&method)
}

fn auth_failure(result: AuthResult) -> Option<MethodSet> {
    match result {
        AuthResult::Success => None,
        AuthResult::Failure {
            remaining_methods, ..
        } => Some(remaining_methods),
    }
}

fn key_passphrase_error() -> LumaError {
    LumaError::SshConnection {
        category: "key-passphrase-invalid",
        message: "The configured passphrase could not decrypt the private key".into(),
    }
}

fn authentication_type(config: &SshConnectionConfig) -> &str {
    &config.authentication_type
}

fn prompt_target(config: &SshConnectionConfig) -> String {
    match config.username.as_deref() {
        Some(username) => format!("{username}@{}", config.hostname),
        None => config.hostname.clone(),
    }
}

fn load_saved_key(config: &SshConnectionConfig) -> Result<PrivateKey> {
    let identity_file = config
        .identity_file
        .as_deref()
        .ok_or_else(|| LumaError::KeyUnavailable("host has no private key file".into()))?;
    let passphrase = config.key_passphrase.as_deref().map(|value| value.as_str());
    load_secret_key(identity_file, passphrase)
        .map_err(|error| LumaError::KeyUnavailable(format!("could not load private key: {error}")))
}

async fn load_key_with_prompts(
    config: &SshConnectionConfig,
    driver: &mut AuthDriver,
    on_data: &SharedDataCallback,
) -> std::result::Result<PrivateKey, AuthAbort> {
    let identity_file = config.identity_file.as_deref().ok_or_else(|| {
        AuthAbort::Error(LumaError::KeyUnavailable(
            "host has no private key file".into(),
        ))
    })?;
    if let Ok(key) = load_secret_key(
        identity_file,
        config.key_passphrase.as_deref().map(|value| value.as_str()),
    ) {
        return Ok(key);
    }

    let prompt_text = format!("Enter passphrase for key '{identity_file}':");
    let target = prompt_target(config);
    for _ in 0..MAX_PROMPT_ATTEMPTS {
        let passphrase = prompt(
            driver,
            on_data,
            "Key passphrase",
            true,
            &target,
            &prompt_text,
        )
        .await?;
        if let Ok(key) = load_secret_key(identity_file, Some(passphrase.as_str())) {
            return Ok(key);
        }
    }
    Err(AuthAbort::Error(key_passphrase_error()))
}

async fn authenticate_key(
    handle: &mut Handle<Client>,
    username: &str,
    key: PrivateKey,
    driver: &mut AuthDriver,
    timeouts: EmbeddedSshTimeouts,
) -> std::result::Result<AuthResult, AuthAbort> {
    let hash = driver
        .operation(
            timeouts.signature_negotiation,
            "SSH signature negotiation timed out",
            handle.best_supported_rsa_hash(),
        )
        .await?
        .flatten();
    driver
        .operation(
            timeouts.authentication,
            "SSH key authentication timed out",
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
        )
        .await
}

struct AuthenticationBudget {
    timeouts: EmbeddedSshTimeouts,
    method_attempts: usize,
}

async fn authenticate_password_with_prompts(
    handle: &mut Handle<Client>,
    config: &SshConnectionConfig,
    fallback: bool,
    remaining_methods: &mut MethodSet,
    driver: &mut AuthDriver,
    on_data: &SharedDataCallback,
    budget: &mut AuthenticationBudget,
) -> std::result::Result<bool, AuthAbort> {
    let username = config.username.as_deref().ok_or_else(|| {
        AuthAbort::Error(LumaError::InvalidInput("SSH username is required".into()))
    })?;
    let saved_password = if fallback {
        config.fallback_password.as_deref()
    } else {
        config.password.as_deref()
    };
    let mut saved_password = saved_password.map(|value| Zeroizing::new(value.to_string()));
    for prompt_attempt in 0..=MAX_PROMPT_ATTEMPTS {
        if budget.method_attempts >= MAX_AUTH_METHOD_ATTEMPTS
            || !method_available(remaining_methods, MethodKind::Password)
        {
            return Ok(false);
        }
        let password = if prompt_attempt == 0 {
            let Some(password) = saved_password.take() else {
                continue;
            };
            password
        } else {
            let target = prompt_target(config);
            let text = format!("{target}'s password:");
            prompt(driver, on_data, "Password", true, &target, &text).await?
        };
        budget.method_attempts += 1;
        let result = driver
            .operation(
                budget.timeouts.authentication,
                "SSH password authentication timed out",
                handle.authenticate_password(username, password.as_str()),
            )
            .await?;
        match auth_failure(result) {
            None => return Ok(true),
            Some(methods) => *remaining_methods = methods,
        }
    }
    Ok(false)
}

async fn authenticate_keyboard_interactive(
    handle: &mut Handle<Client>,
    username: &str,
    target: &str,
    driver: &mut AuthDriver,
    on_data: &SharedDataCallback,
    timeouts: EmbeddedSshTimeouts,
    method_attempts: &mut usize,
) -> std::result::Result<std::result::Result<(), MethodSet>, AuthAbort> {
    if *method_attempts >= MAX_AUTH_METHOD_ATTEMPTS {
        return Ok(Err(MethodSet::empty()));
    }
    *method_attempts += 1;
    let mut response = driver
        .operation(
            timeouts.authentication,
            "SSH keyboard-interactive authentication timed out",
            handle.authenticate_keyboard_interactive_start(username, None),
        )
        .await?;
    for _ in 0..MAX_KEYBOARD_INTERACTIVE_ROUNDS {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(Ok(())),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            } => return Ok(Err(remaining_methods)),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                if !name.is_empty() {
                    emit_text(on_data, &format!("{name}\r\n"));
                }
                if !instructions.is_empty() {
                    emit_text(on_data, &format!("{instructions}\r\n"));
                }
                let mut answers = Vec::with_capacity(prompts.len());
                for server_prompt in prompts {
                    let answer = prompt(
                        driver,
                        on_data,
                        &server_prompt.prompt,
                        !server_prompt.echo,
                        target,
                        &server_prompt.prompt,
                    )
                    .await?;
                    answers.push(answer.as_str().to_string());
                }
                response = driver
                    .operation(
                        timeouts.authentication,
                        "SSH keyboard-interactive authentication timed out",
                        handle.authenticate_keyboard_interactive_respond(answers),
                    )
                    .await?;
            }
        }
    }
    Err(AuthAbort::Error(LumaError::SshConnection {
        category: "auth-failed",
        message: "SSH keyboard-interactive authentication exceeded the allowed prompt rounds"
            .into(),
    }))
}

pub(super) async fn authenticate_with_prompts(
    handle: &mut Handle<Client>,
    config: &SshConnectionConfig,
    driver: &mut AuthDriver,
    on_data: &SharedDataCallback,
    timeouts: EmbeddedSshTimeouts,
) -> std::result::Result<(), AuthAbort> {
    let username = config.username.as_deref().ok_or_else(|| {
        AuthAbort::Error(LumaError::InvalidInput("SSH username is required".into()))
    })?;
    let none = driver
        .operation(
            timeouts.authentication,
            "SSH authentication negotiation timed out",
            handle.authenticate_none(username),
        )
        .await?;
    let mut remaining_methods = match auth_failure(none) {
        None => return Ok(()),
        Some(methods) => methods,
    };
    let mut budget = AuthenticationBudget {
        timeouts,
        method_attempts: 0,
    };

    let authentication_type = authentication_type(config);
    let target = prompt_target(config);
    if authentication_type == "key" && method_available(&remaining_methods, MethodKind::PublicKey) {
        let key = load_key_with_prompts(config, driver, on_data).await?;
        budget.method_attempts += 1;
        let result = authenticate_key(handle, username, key, driver, budget.timeouts).await?;
        match auth_failure(result) {
            None => return Ok(()),
            Some(methods) => remaining_methods = methods,
        }
    }

    if authentication_type == "interactive"
        && method_available(&remaining_methods, MethodKind::KeyboardInteractive)
    {
        match authenticate_keyboard_interactive(
            handle,
            username,
            &target,
            driver,
            on_data,
            budget.timeouts,
            &mut budget.method_attempts,
        )
        .await?
        {
            Ok(()) => return Ok(()),
            Err(methods) => remaining_methods = methods,
        }
    }

    if authenticate_password_with_prompts(
        handle,
        config,
        authentication_type == "key",
        &mut remaining_methods,
        driver,
        on_data,
        &mut budget,
    )
    .await?
    {
        return Ok(());
    }

    if method_available(&remaining_methods, MethodKind::KeyboardInteractive) {
        if let Ok(()) = authenticate_keyboard_interactive(
            handle,
            username,
            &target,
            driver,
            on_data,
            budget.timeouts,
            &mut budget.method_attempts,
        )
        .await?
        {
            return Ok(());
        }
    }

    Err(AuthAbort::Error(LumaError::SshConnection {
        category: "auth-failed",
        message: "SSH authentication failed".into(),
    }))
}

pub(super) async fn authenticate_without_prompts<H>(
    handle: &mut Handle<H>,
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
) -> Result<()>
where
    H: russh::client::Handler<Error = russh::Error>,
{
    let username = config
        .username
        .as_deref()
        .ok_or_else(|| LumaError::InvalidInput("SSH username is required".into()))?;
    let none = tokio::time::timeout(timeouts.authentication, handle.authenticate_none(username))
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH authentication negotiation timed out".into(),
        })?
        .map_err(super::embedded::connect_error)?;
    if auth_failure(none).is_none() {
        return Ok(());
    }
    let authentication_type = authentication_type(config);

    if authentication_type == "key" {
        let key = load_saved_key(config).map_err(|error| {
            if config.key_passphrase.is_some() {
                key_passphrase_error()
            } else {
                error
            }
        })?;
        let hash = tokio::time::timeout(
            timeouts.signature_negotiation,
            handle.best_supported_rsa_hash(),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH signature negotiation timed out".into(),
        })?
        .map_err(super::embedded::connect_error)?
        .flatten();
        let result = tokio::time::timeout(
            timeouts.authentication,
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH key authentication timed out".into(),
        })?
        .map_err(super::embedded::connect_error)?;
        let remaining_methods = match auth_failure(result) {
            None => return Ok(()),
            Some(methods) => methods,
        };
        if let Some(password) = config.fallback_password.as_deref() {
            if method_available(&remaining_methods, MethodKind::Password) {
                let result = tokio::time::timeout(
                    timeouts.authentication,
                    handle.authenticate_password(username, password.as_str()),
                )
                .await
                .map_err(|_| LumaError::SshConnection {
                    category: "timeout",
                    message: "SSH fallback password authentication timed out".into(),
                })?
                .map_err(super::embedded::connect_error)?;
                if result.success() {
                    return Ok(());
                }
            }
        }
    } else if let Some(password) = config.password.as_deref() {
        let result = tokio::time::timeout(
            timeouts.authentication,
            handle.authenticate_password(username, password.as_str()),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH password authentication timed out".into(),
        })?
        .map_err(super::embedded::connect_error)?;
        if result.success() {
            return Ok(());
        }
    }

    Err(LumaError::SshConnection {
        category: "auth-failed",
        message: "SSH authentication failed".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn auth_driver_assembles_split_writes_and_coalesces_crlf() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut driver = AuthDriver::new(rx, 80, 24);
        tx.send(Control::Write(b"sec".to_vec())).unwrap();
        tx.send(Control::Write(b"ret\r".to_vec())).unwrap();
        tx.send(Control::Write(b"\nnext\n".to_vec())).unwrap();

        let first = driver.answer().await.unwrap();
        let second = driver.answer().await.unwrap();
        assert_eq!(first.as_str(), "secret");
        assert_eq!(second.as_str(), "next");
        let _: &Zeroizing<String> = &first;
    }

    #[tokio::test]
    async fn auth_driver_tracks_resize_and_reports_authenticating_ping() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut driver = AuthDriver::new(rx, 80, 24);
        let (reply, response) = oneshot::channel();
        tx.send(Control::Resize(132, 44)).unwrap();
        tx.send(Control::Ping(reply)).unwrap();
        tx.send(Control::Write(b"answer\n".to_vec())).unwrap();

        assert_eq!(driver.answer().await.unwrap().as_str(), "answer");
        assert!(matches!(
            response.await.unwrap(),
            Err(PingFailure::Authenticating)
        ));
        let (_, dimensions) = driver.into_parts();
        assert_eq!(dimensions, (132, 44));
    }
}
