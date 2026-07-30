// Tauri's mobile Plugin base class owns the listener commands. They still need
// ACL entries or addPluginListener() is rejected before reaching Swift.
const COMMANDS: &[&str] = &[
    "set_items",
    "set_active_tab",
    "set_hidden",
    "set_badge",
    "set_tint_color",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
