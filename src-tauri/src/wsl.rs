use serde::Serialize;
use std::process::Command;
use sysinfo::{ProcessesToUpdate, System};

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

/// Nazwa dystrybucji trafia jako argument do wsl.exe, więc przepuszczamy tylko bezpieczne znaki
/// (i nic, co zaczyna się od "-", żeby nie udawało przełącznika).
pub fn valid_distro(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && !n.starts_with('-')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Buduje komendę dla wybranego źródła:
/// "win" → program uruchomiony bezpośrednio w Windowsie,
/// "wsl" → przez `wsl.exe -e` w domyślnej dystrybucji,
/// "wsl:Nazwa" → przez `wsl.exe -d Nazwa -e` w tej dystrybucji.
pub fn command(backend: &str, program: &str, args: &[&str]) -> Result<Command, String> {
    let mut cmd = match backend {
        "win" => Command::new(program),
        "wsl" => {
            let mut c = Command::new("wsl.exe");
            c.arg("-e").arg(program);
            c
        }
        b if b.starts_with("wsl:") => {
            let name = &b[4..];
            if !valid_distro(name) {
                return Err("niepoprawna nazwa dystrybucji WSL".into());
            }
            let mut c = Command::new("wsl.exe");
            c.args(["-d", name, "-e", program]);
            c
        }
        _ => return Err(format!("nieznane źródło: {backend}")),
    };
    cmd.args(args);
    hide(&mut cmd);
    Ok(cmd)
}

/// Własne komunikaty i listy wsl.exe są w UTF-16LE, a wyjście programów z wnętrza dystrybucji w UTF-8.
pub fn decode(bytes: &[u8]) -> String {
    if bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0 {
        let u: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u).trim_start_matches('\u{feff}').to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Pierwsza niepusta linia z wyjścia, do krótkich komunikatów błędów.
pub fn first_line(s: &str) -> String {
    s.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn run_wsl(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(args);
    hide(&mut cmd);
    let out = cmd
        .output()
        .map_err(|_| "wsl.exe nie jest dostępne (WSL nie jest zainstalowany?)".to_string())?;
    let stdout = decode(&out.stdout);
    if !out.status.success() {
        let msg = first_line(&decode(&out.stderr));
        let msg = if msg.is_empty() { first_line(&stdout) } else { msg };
        return Err(if msg.is_empty() { "wsl.exe zwrócił błąd".into() } else { msg });
    }
    Ok(stdout)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distro {
    name: String,
    running: bool,
    version: u32,
    is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslInfo {
    distros: Vec<Distro>,
    vmmem: u64, // bajty zajęte przez maszynę wirtualną WSL (procesy vmmem*)
}

#[tauri::command]
pub async fn wsl_list() -> Result<WslInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let listing = run_wsl(&["-l", "-v"])?;
        // nagłówki i stany są lokalizowane (po polsku też), więc "działa" bierzemy z osobnej listy samych nazw
        let running_txt = run_wsl(&["-l", "--running", "-q"]).unwrap_or_default();
        let running: Vec<&str> = running_txt.lines().map(|l| l.trim()).collect();

        let mut distros = Vec::new();
        for line in listing.lines() {
            let line = line.trim();
            let is_default = line.starts_with('*');
            let toks: Vec<&str> = line.trim_start_matches('*').split_whitespace().collect();
            if toks.len() < 3 {
                continue;
            }
            // wiersz z danymi kończy się numerem wersji; nagłówek ("VERSION"/"WERSJA") odpada
            let Ok(version) = toks[toks.len() - 1].parse::<u32>() else { continue };
            let name = toks[0].to_string();
            distros.push(Distro { running: running.contains(&name.as_str()), name, version, is_default });
        }

        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let vmmem: u64 = sys
            .processes()
            .values()
            .filter(|p| p.name().to_string_lossy().to_lowercase().starts_with("vmmem"))
            .map(|p| p.memory())
            .sum();
        Ok(WslInfo { distros, vmmem })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// terminate = zatrzymaj dystrybucję, default = ustaw jako domyślną, shutdown = wyłącz całe WSL.
#[tauri::command]
pub async fn wsl_action(distro: String, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let res = match action.as_str() {
            "shutdown" => run_wsl(&["--shutdown"]),
            "terminate" | "default" => {
                if !valid_distro(&distro) {
                    return Err("niepoprawna nazwa dystrybucji WSL".into());
                }
                run_wsl(&[if action == "terminate" { "-t" } else { "-s" }, distro.as_str()])
            }
            _ => Err(format!("nieznana akcja: {action}")),
        };
        res.map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
