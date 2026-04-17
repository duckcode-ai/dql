// Tauri entrypoint for the DQL desktop app. Minimal shell: loads the
// bundled notebook frontend. The CLI ships separately (Homebrew / npm).
// Future: sidecar-spawn the CLI so the desktop app is self-contained.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
