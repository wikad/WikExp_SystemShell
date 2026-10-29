// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use tauri::Manager;
use std::fs;
use std::time::UNIX_EPOCH;
mod applog;
mod safety;
mod watchdog;
mod autostart;
mod power;
mod pty;
mod procs;
mod docker;
mod wsl;
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

const MAX_PREVIEW_FILE: u64 = 200 * 1024 * 1024;

/// Surowe bajty pliku do podglądu (PDF). Idą binarnie, bez serializacji do JSON.
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > MAX_PREVIEW_FILE {
        return Err("plik jest większy niż 200 MB".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
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
/// Wpis do logu z frontu (błędy okna, nieobsłużone odrzucenia). Poziom: info / warn / error.
#[tauri::command]
fn log_write(level: String, msg: String) {
    let msg: String = msg.chars().take(4000).collect();
    match level.as_str() {
        "warn" => applog::warn(&msg),
        "error" => applog::error(&msg),
        _ => applog::info(&msg),
    }
}

#[tauri::command]
fn get_log_path() -> Option<String> {
    applog::log_path().map(|p| p.to_string_lossy().into_owned())
}

/// Stan powłoki dla ustawień: czy wpis Shell w rejestrze wskazuje na ten program.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellStatus {
    enabled: bool,
    value: Option<String>, // aktualna wartość Shell (None = domyślnie explorer.exe)
    exe: String,
    dev: bool, // build developerski: ustawienie powłoki zablokowane
}

#[tauri::command]
fn shell_status() -> Result<ShellStatus, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let value = safety::shell_value()?;
    let enabled = value.as_deref().is_some_and(|v| safety::same_command(v, &exe));
    let dev = cfg!(debug_assertions) || safety::is_dev_exe(&exe);
    Ok(ShellStatus { enabled, value, exe, dev })
}

/// true = wpisz ten program jako powłokę (działa od następnego logowania), false = usuń wpis (explorer.exe).
#[tauri::command]
fn shell_set(enabled: bool) -> Result<(), String> {
    let res = if enabled {
        std::env::current_exe()
            .map_err(|e| e.to_string())
            .and_then(|exe| safety::shell_command_for(&exe, cfg!(debug_assertions)))
            .and_then(|cmd| safety::set_shell_value(&cmd).map(|_| cmd))
            .map(|cmd| crate::logi!("[powłoka] ustawiono Shell = {cmd}"))
    } else {
        safety::clear_shell_value().map(|_| crate::logi!("[powłoka] usunięto wpis Shell, powrót do explorer.exe"))
    };
    if let Err(e) = &res {
        crate::loge!("[powłoka] zmiana nie powiodła się: {e}");
    }
    res
}

/// Awaryjnie: oddaj pas ekranu, pokaż pasek Windows i uruchom explorer.exe (skrót Ctrl+Alt+F12 robi to samo).
#[tauri::command]
fn emergency_explorer() -> Result<(), String> {
    shell::emergency_restore()
}

#[tauri::command]
fn autostart_list() -> Vec<autostart::Entry> {
    autostart::list()
}

pub fn run() {
    applog::init();
    applog::install_panic_hook();
    // tryb nadzorcy (wpis Shell w rejestrze): bez okien, tylko pilnuje właściwego WikExp
    if std::env::args().any(|a| a == safety::WATCHDOG_ARG) {
        watchdog::run_supervisor();
        return;
    }
    // druga kopia nie ma sensu: dwa paski i dwa pulpity walczyłyby o ekran
    if !safety::acquire_single_instance() {
        crate::logw!("[start] WikExp już działa w tej sesji, ta kopia kończy pracę");
        safety::notify_already_running();
        std::process::exit(watchdog::EXIT_ALREADY_RUNNING); // nadzorca wie, że to nie awaria
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(procs::ProcState::default())
        .manage(monitor::MonitorState::default())
        .invoke_handler(tauri::generate_handler![greet, log_write, get_log_path, shell_status, shell_set, emergency_explorer, autostart_list, power::power_action, read_dir,parent_dir, read_text_file, write_text_file, read_file_bytes, pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill, procs::list_processes, procs::kill_processes, docker::docker_list, docker::docker_action, wsl::wsl_list, wsl::wsl_action, monitor::system_stats, shell::apply_shell_layout, shell::list_windows, shell::window_action, shell::show_main, shell::set_desktop_layer, shell::battery_status, shell::dock_window, shell::undock_window, shell::focus_main, shell::style_docked, shell::toggle_launcher, shell::hide_launcher, shell::toggle_flyout, shell::hide_flyout, launcher::list_apps, launcher::app_icons, launcher::launch_app, launcher::open_path, git::git_status, git::git_diff, git::git_stage, git::git_stage_all, git::git_commit, git::git_sync, git::git_branches, git::git_checkout, git::git_log, git::git_show, search::search_files])
        .setup(|app| {
            shell::setup(app.handle()); // pasek boczny + główne okno na pełny ekran
            autostart::run_if_first_start(); // tylko jako powłoka, raz po zalogowaniu
            Ok(())
        })
        .on_window_event(|window, event| {
            // główne okno to pulpit: nie da się go przesunąć, zmienić rozmiaru ani zminimalizować
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                shell::enforce_main(window.app_handle());
            }
            // warstwa pulpitu: aktywowane główne okno wraca na spód
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
                shell::keep_bottom(window.app_handle());
            }
            // zamknięcie głównego okna (Ctrl+Q) kończy całą aplikację, razem z paskiem
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                crate::logi!("[shell] główne okno zamknięte → koniec aplikacji");
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                shell::cleanup(); // oddaj pas ekranu, przywróć pasek zadań Windows
                crate::logi!("=== WikExp koniec ===");
            }
        });
}
