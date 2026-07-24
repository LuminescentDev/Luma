#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SERVICE: &str = "luma.ssh.key-passphrase.test";

struct CredentialGuard {
    account: String,
}

impl Drop for CredentialGuard {
    fn drop(&mut self) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, &self.account) {
            let _ = entry.delete_credential();
        }
    }
}

struct TestFiles(PathBuf);

impl Drop for TestFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn find_in_path(executable: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(executable))
            .find(|candidate| candidate.is_file())
    })
}

fn ssh_keygen() -> PathBuf {
    find_in_path("ssh-keygen.exe").unwrap_or_else(|| {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        system_root.join(r"System32\OpenSSH\ssh-keygen.exe")
    })
}

fn configure_askpass(command: &mut Command, helper: &Path, account: &str) {
    command
        .env("SSH_ASKPASS", helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", "luma:0")
        .env("LUMA_ASKPASS_ID", account)
        .env("LUMA_ASKPASS_SERVICE", SERVICE)
        .env("LUMA_ASKPASS_PROMPT", "passphrase");
}

#[test]
fn luma_binary_delivers_saved_passphrase_to_openssh() {
    let helper = PathBuf::from(env!("CARGO_BIN_EXE_luma"));
    assert!(helper.is_file(), "Cargo did not build the Luma binary");
    let keygen = ssh_keygen();
    assert!(keygen.is_file(), "Windows OpenSSH ssh-keygen was not found");

    let account = format!("askpass-regression-{}", uuid::Uuid::new_v4());
    let _credential = CredentialGuard {
        account: account.clone(),
    };
    let passphrase = "synthetic Luma askpass phrase !42";
    keyring::Entry::new(SERVICE, &account)
        .unwrap()
        .set_password(passphrase)
        .unwrap();

    let direct = Command::new(&helper)
        .arg("Enter passphrase for key 'imported-id_rsa':")
        .env("LUMA_ASKPASS_ID", &account)
        .env("LUMA_ASKPASS_SERVICE", SERVICE)
        .env("LUMA_ASKPASS_PROMPT", "passphrase")
        .output()
        .unwrap();
    assert!(direct.status.success());
    assert_eq!(direct.stdout, passphrase.as_bytes());
    assert!(direct.stderr.is_empty());

    let rejected_prompt = Command::new(&helper)
        .arg("Password for unrelated account:")
        .env("LUMA_ASKPASS_ID", &account)
        .env("LUMA_ASKPASS_SERVICE", SERVICE)
        .env("LUMA_ASKPASS_PROMPT", "passphrase")
        .output()
        .unwrap();
    assert!(!rejected_prompt.status.success());
    assert!(rejected_prompt.stdout.is_empty());

    let files = TestFiles(std::env::temp_dir().join(format!(
        "luma-askpass-integration-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir_all(&files.0).unwrap();
    let private_key = files.0.join("id_rsa");
    let generated = Command::new(&keygen)
        .args(["-q", "-t", "rsa", "-b", "2048", "-N", passphrase, "-f"])
        .arg(&private_key)
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "ssh-keygen failed to create the fixture: {}",
        String::from_utf8_lossy(&generated.stderr)
    );

    let mut extract = Command::new(&keygen);
    extract
        .args(["-y", "-f"])
        .arg(&private_key)
        .stdin(Stdio::null());
    configure_askpass(&mut extract, &helper, &account);
    let extracted = extract.output().unwrap();
    assert!(
        extracted.status.success(),
        "OpenSSH did not receive the saved passphrase: {}",
        String::from_utf8_lossy(&extracted.stderr)
    );
    assert!(extracted.stderr.is_empty());
    assert!(String::from_utf8_lossy(&extracted.stdout).starts_with("ssh-rsa "));
}
