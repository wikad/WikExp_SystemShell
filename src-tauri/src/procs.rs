use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

/// `System` trzyma poprzedni pomiar, bo CPU% liczy się z różnicy między
/// dwoma odświeżeniami. Dlatego żyje w stanie aplikacji, a nie w komendzie.
pub struct ProcState {
    sys: Mutex<System>,
}

impl Default for ProcState {
    fn default() -> Self {
        Self { sys: Mutex::new(System::new()) }
    }
}

/// Procesy zgrupowane po nazwie (np. 30× chrome.exe → jeden wiersz).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcGroup {
    name: String,
    pids: Vec<u32>,
    cpu: f32,    // % całego procesora (0–100)
    memory: u64, // bajty
}

/// Procesy wewnątrz WSL przez `ps` (pcpu to średnia z całego życia procesu, nie chwilowe CPU).
/// Wątki jądra (RSS 0) pomijamy.
fn wsl_processes(backend: &str) -> Result<Vec<ProcGroup>, String> {
    let out = crate::wsl::command(backend, "ps", &["-eo", "pid=,pcpu=,rss=,comm="])?
        .output()
        .map_err(|_| "wsl.exe nie jest dostępne (WSL nie jest zainstalowany?)".to_string())?;
    if !out.status.success() {
        let err = crate::wsl::first_line(&crate::wsl::decode(&out.stderr));
        return Err(if err.is_empty() { "ps w WSL zwrócił błąd".into() } else { err });
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
    let mut groups: HashMap<String, ProcGroup> = HashMap::new();
    for line in crate::wsl::decode(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(cpu), Some(rss)) = (it.next(), it.next(), it.next()) else { continue };
        let name = it.collect::<Vec<_>>().join(" ");
        let (Ok(pid), Ok(cpu), Ok(rss)) = (pid.parse::<u32>(), cpu.parse::<f32>(), rss.parse::<u64>()) else { continue };
        if rss == 0 || name.is_empty() {
            continue;
        }
        let g = groups.entry(name.clone()).or_insert_with(|| ProcGroup { name, pids: Vec::new(), cpu: 0.0, memory: 0 });
        g.pids.push(pid);
        g.cpu += cpu / cores;
        g.memory += rss * 1024; // ps podaje KiB
    }
    Ok(groups.into_values().collect())
}

// async = komenda biegnie poza wątkiem UI, więc odświeżanie nie zacina okna
#[tauri::command]
pub async fn list_processes(state: State<'_, ProcState>, backend: Option<String>) -> Result<Vec<ProcGroup>, String> {
    let backend = backend.unwrap_or_else(|| "win".into());
    if backend != "win" {
        return tauri::async_runtime::spawn_blocking(move || wsl_processes(&backend))
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_processes(ProcessesToUpdate::All, true);

    // sysinfo podaje CPU per rdzeń (może być > 100%), więc dzielimy przez liczbę rdzeni
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;

    let mut groups: HashMap<String, ProcGroup> = HashMap::new();
    for (pid, p) in sys.processes() {
        if pid.as_u32() == 0 {
            continue; // "System Idle Process"
        }
        let name = p.name().to_string_lossy().into_owned();
        let g = groups.entry(name.clone()).or_insert_with(|| ProcGroup {
            name,
            pids: Vec::new(),
            cpu: 0.0,
            memory: 0,
        });
        g.pids.push(pid.as_u32());
        g.cpu += p.cpu_usage() / cores;
        g.memory += p.memory();
    }
    Ok(groups.into_values().collect())
}

/// Zabija wszystkie podane procesy, zwraca ile się udało.
#[tauri::command]
pub async fn kill_processes(state: State<'_, ProcState>, pids: Vec<u32>, backend: Option<String>) -> Result<usize, String> {
    let backend = backend.unwrap_or_else(|| "win".into());
    if backend != "win" {
        return tauri::async_runtime::spawn_blocking(move || {
            let mut args: Vec<String> = vec!["-9".into()];
            args.extend(pids.iter().map(|p| p.to_string()));
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let out = crate::wsl::command(&backend, "kill", &refs)?.output().map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(pids.len())
            } else {
                let err = crate::wsl::first_line(&crate::wsl::decode(&out.stderr));
                Err(if err.is_empty() { "kill w WSL zwrócił błąd".into() } else { err })
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let sys = state.sys.lock().map_err(|e| e.to_string())?;
    let killed = pids
        .iter()
        .filter_map(|pid| sys.process(Pid::from_u32(*pid)))
        .filter(|p| p.kill())
        .count();
    if killed == 0 {
        return Err("nie udało się zabić procesu (brak uprawnień?)".into());
    }
    Ok(killed)
}
