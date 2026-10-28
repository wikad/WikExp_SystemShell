//! Launcher: lista programów ze skrótów menu Start, ich ikony i uruchamianie.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    name: String,
    target: String, // ścieżka do skrótu .lnk / programu albo adres typu "ms-settings:"
}

static CACHE: Mutex<Option<Vec<AppEntry>>> = Mutex::new(None);

/// Skróty, które nie są programami (dezinstalatory, pomoc, strony www).
const SKIP: [&str; 8] = ["uninstall", "odinstaluj", "readme", "help", "pomoc", "website", "documentation", "release notes"];

fn walk(dir: &Path, out: &mut Vec<AppEntry>, depth: u32) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out, depth + 1);
        } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let low = name.to_lowercase();
            if name.is_empty() || SKIP.iter().any(|w| low.contains(w)) {
                continue;
            }
            out.push(AppEntry { name, target: p.to_string_lossy().into_owned() });
        }
    }
}

fn scan() -> Vec<AppEntry> {
    let mut out = Vec::new();
    // menu Start: wspólne dla wszystkich użytkowników + własne
    for var in ["ProgramData", "APPDATA"] {
        if let Ok(base) = std::env::var(var) {
            walk(&PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"), &mut out, 0);
        }
    }
    // kilka pozycji systemowych, których nie ma jako skrótów
    let win = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    for (name, target) in [
        ("Ustawienia", "ms-settings:".to_string()),
        ("Menedżer zadań", format!(r"{win}\System32\Taskmgr.exe")),
        ("Panel sterowania", format!(r"{win}\System32\control.exe")),
        ("Eksplorator plików", format!(r"{win}\explorer.exe")),
    ] {
        out.push(AppEntry { name: name.into(), target });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name)); // ten sam program w obu menu Start
    out
}

/// Lista programów (z pamięci podręcznej; refresh = przeskanuj menu Start od nowa).
#[tauri::command]
pub async fn list_apps(refresh: bool) -> Vec<AppEntry> {
    let mut cache = CACHE.lock().unwrap();
    if refresh || cache.is_none() {
        *cache = Some(scan());
    }
    cache.clone().unwrap_or_default()
}

/// Ikony dla podanych pozycji (tylko widocznych w launcherze, żeby było szybko).
#[tauri::command]
pub fn app_icons(targets: Vec<String>) -> Vec<Option<String>> {
    targets
        .iter()
        .map(|t| {
            #[cfg(windows)]
            if t.contains('\\') {
                return crate::win::file_icon(t);
            }
            let _ = t;
            None
        })
        .collect()
}

#[tauri::command]
pub fn launch_app(app: tauri::AppHandle, target: String) -> Result<(), String> {
    crate::shell::hide_launcher(app);
    #[cfg(windows)]
    return crate::win::launch(&target);
    #[cfg(not(windows))]
    {
        let _ = target;
        Ok(())
    }
}
