//! Launcher: lista programów (menu Start, pulpit, aplikacje ze Sklepu), ich ikony i uruchamianie.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    name: String,
    /// ścieżka do skrótu .lnk/.url, programu, adres typu "ms-settings:"
    /// albo aplikacja ze Sklepu: "shell:AppsFolder\<AppID>"
    target: String,
}

static CACHE: Mutex<Option<Vec<AppEntry>>> = Mutex::new(None);

/// Aplikacje z `Get-StartApps` (wszystko, co pokazuje menu Start, łącznie ze Sklepem).
/// PowerShell startuje ~1 s, więc lista jest odświeżana w tle, najwyżej co 5 minut.
struct StoreApps {
    apps: Vec<AppEntry>,
    fetched: Option<Instant>,
    running: bool,
}
static STORE: Mutex<StoreApps> = Mutex::new(StoreApps { apps: Vec::new(), fetched: None, running: false });
const STORE_TTL: Duration = Duration::from_secs(300);

/// Skróty, które nie są programami (dezinstalatory, pomoc, strony www).
const SKIP: [&str; 8] = ["uninstall", "odinstaluj", "readme", "help", "pomoc", "website", "documentation", "release notes"];

/// Skrót do programu: .lnk (zwykły skrót) albo .url (np. gry ze Steama, Epic).
fn is_shortcut(p: &Path) -> bool {
    p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("lnk") || x.eq_ignore_ascii_case("url"))
}

/// Przechodzi folder (do `max_depth` poziomów w głąb) i zbiera skróty.
fn walk(dir: &Path, out: &mut Vec<AppEntry>, depth: u32, max_depth: u32) {
    if depth > max_depth {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out, depth + 1, max_depth);
        } else if is_shortcut(&p) {
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let low = name.to_lowercase();
            if name.is_empty() || SKIP.iter().any(|w| low.contains(w)) {
                continue;
            }
            out.push(AppEntry { name, target: p.to_string_lossy().into_owned() });
        }
    }
}

/// `Get-StartApps` → lista {Name, AppID}. Każdą pozycję da się uruchomić jako shell:AppsFolder\AppID.
#[cfg(windows)]
fn fetch_start_apps() -> Vec<AppEntry> {
    use std::os::windows::process::CommandExt;
    #[derive(Deserialize)]
    struct Raw {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "AppID")]
        app_id: String,
    }
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // UTF-8, żeby polskie nazwy (np. „Kalkulator”) nie zamieniły się w krzaki
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
    let Ok(out) = out else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    // jedna aplikacja = obiekt, wiele = tablica
    let raw: Vec<Raw> = serde_json::from_str::<Vec<Raw>>(text)
        .or_else(|_| serde_json::from_str::<Raw>(text).map(|r| vec![r]))
        .unwrap_or_default();
    raw.into_iter()
        .filter(|r| !r.name.is_empty() && !r.app_id.is_empty())
        .filter(|r| {
            let low = r.name.to_lowercase();
            !SKIP.iter().any(|w| low.contains(w)) && !r.app_id.starts_with("http")
        })
        .map(|r| AppEntry { name: r.name, target: format!(r"shell:AppsFolder\{}", r.app_id) })
        .collect()
}
#[cfg(not(windows))]
fn fetch_start_apps() -> Vec<AppEntry> {
    vec![]
}

/// Zwraca ostatnią znaną listę z Get-StartApps; gdy jest stara, odświeża ją w tle
/// (wynik trafi do launchera przy następnym otwarciu).
fn store_apps() -> Vec<AppEntry> {
    let mut st = STORE.lock().unwrap();
    let stale = st.fetched.is_none_or(|t| t.elapsed() > STORE_TTL);
    if stale && !st.running {
        st.running = true;
        std::thread::spawn(|| {
            let apps = fetch_start_apps();
            let mut st = STORE.lock().unwrap();
            st.apps = apps;
            st.fetched = Some(Instant::now());
            st.running = false;
        });
    }
    st.apps.clone()
}

fn scan() -> Vec<AppEntry> {
    let mut out = Vec::new();
    // menu Start: wspólne dla wszystkich użytkowników + własne
    for var in ["ProgramData", "APPDATA"] {
        if let Ok(base) = std::env::var(var) {
            walk(&PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"), &mut out, 0, 6);
        }
    }
    // pulpit: własny, wspólny i (jeśli pulpit jest w OneDrive) ten z OneDrive; bez podfolderów
    let mut desktops: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") { desktops.push(PathBuf::from(home).join("Desktop")); }
    if let Ok(public) = std::env::var("PUBLIC") { desktops.push(PathBuf::from(public).join("Desktop")); }
    if let Ok(od) = std::env::var("OneDrive") {
        desktops.push(PathBuf::from(&od).join("Desktop"));
        desktops.push(PathBuf::from(&od).join("Pulpit")); // polska nazwa folderu w OneDrive
    }
    for d in desktops {
        walk(&d, &mut out, 0, 0);
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
    // na końcu aplikacje ze Sklepu i reszta menu Start: przy tej samej nazwie wygrywa skrót
    // z dysku (stoi wcześniej, a dedup zostawia pierwszy), bo ma pewną ikonę i szybciej startuje
    out.extend(store_apps());
    out.sort_by_key(|a| (a.name.to_lowercase(), a.target.starts_with("shell:")));
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name)); // ten sam program w kilku miejscach
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
            // pliki i aplikacje ze Sklepu (shell:AppsFolder\…) mają ikony; "ms-settings:" nie
            #[cfg(windows)]
            if t.contains('\\') {
                return crate::win::file_icon(t);
            }
            let _ = t;
            None
        })
        .collect()
}

/// Otwiera plik lub folder domyślnym programem Windows (`with_dialog` = okno „Otwórz za pomocą”).
#[tauri::command]
pub fn open_path(path: String, with_dialog: bool) -> Result<(), String> {
    #[cfg(windows)]
    return crate::win::launch_verb(&path, if with_dialog { "openas" } else { "open" });
    #[cfg(not(windows))]
    {
        let _ = (path, with_dialog);
        Ok(())
    }
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
