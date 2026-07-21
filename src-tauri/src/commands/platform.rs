use serde::Serialize;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Windows,
    Macos,
    Linux,
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformFeatures {
    pub local_terminal: bool,
    pub serial: bool,
    pub system_ssh: bool,
    pub sftp: bool,
    pub port_forwarding: bool,
    pub updater: bool,
    pub biometrics: bool,
    pub window_controls: bool,
    pub folder_sync: bool,
    pub drag_and_drop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub os: Os,
    pub is_mobile: bool,
    pub features: PlatformFeatures,
}

pub fn capabilities_for(os: Os) -> PlatformCapabilities {
    let is_mobile = matches!(os, Os::Android | Os::Ios);
    let features = if is_mobile {
        PlatformFeatures {
            local_terminal: false,
            serial: false,
            system_ssh: false,
            sftp: true,
            port_forwarding: false,
            updater: false,
            biometrics: false,
            window_controls: false,
            folder_sync: false,
            drag_and_drop: false,
        }
    } else {
        PlatformFeatures {
            local_terminal: true,
            serial: true,
            system_ssh: true,
            sftp: true,
            port_forwarding: true,
            updater: true,
            biometrics: false,
            window_controls: true,
            folder_sync: true,
            drag_and_drop: true,
        }
    };
    PlatformCapabilities {
        os,
        is_mobile,
        features,
    }
}

fn current_os() -> Os {
    #[cfg(target_os = "windows")]
    return Os::Windows;
    #[cfg(target_os = "macos")]
    return Os::Macos;
    #[cfg(target_os = "linux")]
    return Os::Linux;
    #[cfg(target_os = "android")]
    return Os::Android;
    #[cfg(target_os = "ios")]
    return Os::Ios;
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    capabilities_for(current_os())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_capabilities_match_the_contract() {
        for os in [Os::Windows, Os::Macos, Os::Linux] {
            let capabilities = capabilities_for(os);
            assert!(!capabilities.is_mobile);
            assert_eq!(
                capabilities.features,
                PlatformFeatures {
                    local_terminal: true,
                    serial: true,
                    system_ssh: true,
                    sftp: true,
                    port_forwarding: true,
                    updater: true,
                    biometrics: false,
                    window_controls: true,
                    folder_sync: true,
                    drag_and_drop: true,
                }
            );
        }
    }

    #[test]
    fn mobile_capabilities_match_the_contract() {
        for os in [Os::Android, Os::Ios] {
            let capabilities = capabilities_for(os);
            assert!(capabilities.is_mobile);
            assert_eq!(
                capabilities.features,
                PlatformFeatures {
                    local_terminal: false,
                    serial: false,
                    system_ssh: false,
                    sftp: true,
                    port_forwarding: false,
                    updater: false,
                    biometrics: false,
                    window_controls: false,
                    folder_sync: false,
                    drag_and_drop: false,
                }
            );
        }
    }

    #[test]
    fn serializes_exact_camel_case_shape() {
        let value = serde_json::to_value(capabilities_for(Os::Android)).unwrap();
        assert_eq!(value["os"], "android");
        assert_eq!(value["isMobile"], true);
        assert_eq!(value["features"]["localTerminal"], false);
        assert_eq!(value["features"]["systemSsh"], false);
        assert_eq!(value["features"]["portForwarding"], false);
        assert_eq!(value["features"]["dragAndDrop"], false);
        assert!(value.get("is_mobile").is_none());
    }
}
