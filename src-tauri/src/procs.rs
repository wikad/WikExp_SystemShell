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

// async = komenda biegnie poza wątkiem UI, więc odświeżanie nie zacina okna
#[tauri::command]
pub async fn list_processes(state: State<'_, ProcState>) -> Result<Vec<ProcGroup>, String> {
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
pub async fn kill_processes(state: State<'_, ProcState>, pids: Vec<u32>) -> Result<usize, String> {
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
