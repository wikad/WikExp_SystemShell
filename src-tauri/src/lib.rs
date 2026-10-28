// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use tauri::Manager;
use std::fs;
use std::time::UNIX_EPOCH;
mod pty;
mod procs;
mod docker;
mod monitor;
mod shell;
mod launcher;
mod git;
mod search;
#[cfg(windows)]
mod win;
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String, 
    is_dir: bool,
    size: u64,
    modified: Option<u64>,
    hidden: bool,
}

// ukryty = atrybut Hidden/System w Windows albo nazwa zaczynająca się od kropki
fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    name.starts_with('.')
}
#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<FileEntry>,String>{
    // zczytane ścieżki w folderze 
    let entries = fs::read_dir(&path).map_err(|e| format!("can not open {path}: {e}"))?;

    let mut out = Vec::new();

    for entry in entries {

        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else {continue};

        //dobiera date kiedy zmodyfikowane 
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
        let name = entry.file_name().to_string_lossy().into_owned();
        let hidden = is_hidden(&name, &meta);
        out.push(FileEntry{
            name,
            hidden,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len()}, 
            modified,
        });
    
    }
    //sortowanie
    out.sort_by(|a, b|
    {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(out)

}

const MAX_TEXT_FILE: u64 = 5 * 1024 * 1024;

/// Odczyt pliku do edytora. Odrzuca pliki duże, binarne i nie-UTF-8.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_TEXT_FILE {
        return Err("plik jest większy niż 5 MB".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.contains(&0) {
        return Err("to plik binarny, nie da się go edytować jako tekst".into());
    }
    String::from_utf8(bytes).map_err(|_| "plik nie jest zapisany w UTF-8".into())
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("nie udało się zapisać {path}: {e}"))
}

#[tauri::command]
fn parent_dir(path: String) -> Option<String> {
    let path = std::path::Path::new(&path);
    path.parent().map(|p| p.to_string_lossy().into_owned())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(procs::ProcState::default())
        .manage(monitor::MonitorState::default())
        .invoke_handler(tauri::generate_handler![greet,read_dir,parent_dir, read_text_file, write_text_file, pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill, procs::list_processes, procs::kill_processes, docker::docker_list, docker::docker_action, monitor::system_stats, shell::apply_shell_layout, shell::list_windows, shell::window_action, shell::show_main, shell::battery_status, shell::dock_window, shell::undock_window, shell::focus_main, shell::style_docked, shell::toggle_launcher, shell::hide_launcher, launcher::list_apps, launcher::app_icons, launcher::launch_app, git::git_status, git::git_diff, git::git_stage, git::git_stage_all, git::git_commit, git::git_sync, git::git_branches, git::git_checkout, git::git_log, git::git_show, search::search_files])
        .setup(|app| {
            shell::setup(app.handle()); // pasek boczny + główne okno na pełny ekran
            Ok(())
        })
        .on_window_event(|window, event| {
            // główne okno to pulpit: nie da się go przesunąć, zmienić rozmiaru ani zminimalizować
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                shell::enforce_main(window.app_handle());
            }
            // zamknięcie głównego okna (Ctrl+Q) kończy całą aplikację, razem z paskiem
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                eprintln!("[shell] główne okno zamknięte → koniec aplikacji");
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                shell::cleanup(); // oddaj pas ekranu, przywróć pasek zadań Windows
            }
        });
}
