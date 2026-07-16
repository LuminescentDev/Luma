use std::io::{self, Write};
use std::path::Path;
use std::sync::{LazyLock, OnceLock};

use regex::Regex;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

static WORKER_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

static REDACTIONS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(
                r"(?is)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
            )
            .unwrap(),
            "[REDACTED PRIVATE KEY]",
        ),
        (
            Regex::new(
                r#"(?i)\b(password|passwd|passphrase|token|secret|api[_-]?key|authorization|bearer)\b(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)"#,
            )
            .unwrap(),
            "$1$2[REDACTED]",
        ),
        (
            // ssh/sshpass-style CLI flags that carry secrets, e.g. `-pW0rd` or `--password=x`
            Regex::new(r"(?i)(--?p(assword)?)([= ])\S+").unwrap(),
            "$1$3[REDACTED]",
        ),
    ]
});

/// Remove likely secrets from a string before it reaches any log sink.
pub fn redact(input: &str) -> String {
    let mut output = input.to_string();
    for (pattern, replacement) in REDACTIONS.iter() {
        output = pattern.replace_all(&output, *replacement).into_owned();
    }
    output
}

struct RedactingWriter<W: Write>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.0.write_all(redact(&text).as_bytes())?;
        // Report the original length so callers never see a short write.
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

struct RedactingMakeWriter<M>(M);

impl<'a, M: MakeWriter<'a>> MakeWriter<'a> for RedactingMakeWriter<M> {
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(self.0.make_writer())
    }
}

/// Initialize tracing with a redacting daily-rolling file log, plus stderr in
/// debug builds. Safe to call once; subsequent calls are no-ops.
pub fn init(log_dir: &Path) {
    if WORKER_GUARD.get().is_some() {
        return;
    }

    let file_appender = tracing_appender::rolling::daily(log_dir, "luma.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,luma_lib=debug"));

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(RedactingMakeWriter(non_blocking));

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    if cfg!(debug_assertions) {
        registry
            .with(tracing_subscriber::fmt::layer().with_writer(RedactingMakeWriter(io::stderr)))
            .init();
    } else {
        registry.init();
    }

    let _ = WORKER_GUARD.set(guard);
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_key_value_secrets() {
        let cases = [
            ("password=hunter2", "password=[REDACTED]"),
            ("passphrase: my secret", "passphrase: [REDACTED] secret"),
            ("token = abc.def.ghi", "token = [REDACTED]"),
            ("api_key=XYZ123", "api_key=[REDACTED]"),
            (
                "Authorization: Bearer abc123",
                "Authorization: [REDACTED] abc123",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "input: {input}");
        }
    }

    #[test]
    fn redacts_private_key_blocks() {
        let input = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nafter";
        let output = redact(input);
        assert!(!output.contains("AAAA"));
        assert!(output.contains("[REDACTED PRIVATE KEY]"));
        assert!(output.contains("before"));
        assert!(output.contains("after"));
    }

    #[test]
    fn redacts_truncated_private_key() {
        let input = "-----BEGIN RSA PRIVATE KEY-----\nAAAA (log cut off";
        assert!(!redact(input).contains("AAAA"));
    }

    #[test]
    fn leaves_normal_text_alone() {
        let input = "connected to host example.com:22 as user deploy";
        assert_eq!(redact(input), input);
    }
}
