use serde::{Deserialize, Serialize};
use std::process::Command;

/// Jeden kontener z `docker ps -a --format "{{json .}}"`.
/// Docker zwraca pola z wielkiej litery, `rename` mapuje je na nasze nazwy.
#[derive(Deserialize, Serialize)]
pub struct Container {
    #[serde(rename(deserialize = "ID"))]
    id: String,
    #[serde(rename(deserialize = "Names"))]
    name: String,
    #[serde(rename(deserialize = "Image"))]
    image: String,
    #[serde(rename(deserialize = "State"))]
    state: String, // running / exited / paused / created ...
    #[serde(rename(deserialize = "Status"))]
    status: String, // np. "Up 2 hours", "Exited (0) 3 days ago"
    #[serde(rename(deserialize = "Ports"), default)]
    ports: String,
}

/// Uruchamia `docker <args>` bez migającego okna konsoli i zwraca stdout.
fn docker(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("docker");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|_| "docker nie jest zainstalowany albo nie ma go w PATH".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.contains("pipe") || err.contains("daemon") {
            "Docker Desktop nie działa".to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// `docker` potrafi myśleć sekundę i dłużej, więc odpalamy go w puli wątków
// blokujących, żeby nie zablokować runtime'u Tauri.
#[tauri::command]
pub async fn docker_list() -> Result<Vec<Container>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = docker(&["ps", "-a", "--no-trunc", "--format", "{{json .}}"])?;
        out.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Container>(l).map_err(|e| e.to_string()))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_action(id: String, action: String) -> Result<(), String> {
    // tylko znane akcje: nie przepuszczamy dowolnych argumentów do dockera
    let verb = match action.as_str() {
        "start" | "stop" | "restart" | "rm" => action,
        _ => return Err(format!("nieznana akcja: {action}")),
    };
    tauri::async_runtime::spawn_blocking(move || docker(&[&verb, &id]).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}
