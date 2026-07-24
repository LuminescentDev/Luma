use std::path::PathBuf;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use serde::Serialize;

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.map(PathBuf::from).filter(|path| path.is_dir())
}

/// Prevent background console programs from creating visible windows when
/// Luma is built as a Windows GUI application. Interactive shells are spawned
/// through ConPTY and must not use this helper.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn hide_background_std_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn hide_background_tokio_command(command: &mut tokio::process::Command) {
    hide_background_std_command(command.as_std_mut());
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

#[cfg(windows)]
fn find_in_path(executable: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(executable);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn shell(id: &str, name: &str, path: PathBuf, args: &[&str]) -> DetectedShell {
    DetectedShell {
        id: id.into(),
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
    }
}

/// Detect shells available on this machine, ordered by preference. The first
/// entry is the platform default when the user has not chosen one.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn detect_shells() -> Vec<DetectedShell> {
    let mut shells = Vec::new();

    #[cfg(windows)]
    {
        let system32 = std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32"))
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32"));

        if let Some(pwsh) = find_in_path("pwsh.exe") {
            shells.push(shell("pwsh", "PowerShell", pwsh, &["-NoLogo"]));
        }
        let windows_powershell = system32.join(r"WindowsPowerShell\v1.0\powershell.exe");
        if windows_powershell.is_file() {
            shells.push(shell(
                "powershell",
                "Windows PowerShell",
                windows_powershell,
                &["-NoLogo"],
            ));
        }
        let cmd = std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .unwrap_or_else(|| system32.join("cmd.exe"));
        if cmd.is_file() {
            shells.push(shell("cmd", "Command Prompt", cmd, &[]));
        }
        let wsl = system32.join("wsl.exe");
        if wsl.is_file() {
            shells.push(shell("wsl", "WSL", wsl, &[]));
        }
        for git_bash in [
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        ] {
            if git_bash.is_file() {
                shells.push(shell("git-bash", "Git Bash", git_bash, &["-i", "-l"]));
                break;
            }
        }
    }

    #[cfg(not(windows))]
    {
        // The user's login shell first.
        if let Ok(login_shell) = std::env::var("SHELL") {
            let path = PathBuf::from(&login_shell);
            if path.is_file() {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Shell".into());
                shells.push(shell("login", &format!("Default ({name})"), path, &["-l"]));
            }
        }
        for (id, name, candidates) in [
            ("bash", "Bash", vec!["/bin/bash", "/usr/bin/bash"]),
            ("zsh", "Zsh", vec!["/bin/zsh", "/usr/bin/zsh"]),
            (
                "fish",
                "Fish",
                vec![
                    "/usr/bin/fish",
                    "/usr/local/bin/fish",
                    "/opt/homebrew/bin/fish",
                ],
            ),
        ] {
            if let Some(path) = candidates
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
            {
                let duplicate = shells
                    .iter()
                    .any(|s: &DetectedShell| s.path == path.to_string_lossy());
                if !duplicate {
                    shells.push(shell(id, name, path, &["-l"]));
                }
            }
        }
    }

    shells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_shell() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "no shells detected");
        for s in &shells {
            assert!(
                std::path::Path::new(&s.path).is_file(),
                "detected shell path missing: {}",
                s.path
            );
        }
    }
}
