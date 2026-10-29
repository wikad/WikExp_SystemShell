use serde::{Deserialize, Serialize};

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
/// backend: "win" (Docker z Windowsa), "wsl" albo "wsl:Nazwa" (docker wewnątrz dystrybucji WSL).
fn docker(backend: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::wsl::command(backend, "docker", args)?;
    let wsl = backend != "win";
    let out = cmd.output().map_err(|_| {
        if wsl { "wsl.exe nie jest dostępne (WSL nie jest zainstalowany?)".to_string() }
        else { "docker nie jest zainstalowany albo nie ma go w PATH".to_string() }
    })?;
    if !out.status.success() {
        let err = crate::wsl::first_line(&crate::wsl::decode(&out.stderr));
        let low = err.to_lowercase();
        return Err(if wsl && (low.contains("no such file") || low.contains("not found") || low.contains("execvpe")) {
            "docker nie jest zainstalowany w tej dystrybucji WSL".to_string()
        } else if wsl {
            if err.is_empty() { "docker w WSL zwrócił błąd".to_string() } else { err }
        } else if err.contains("pipe") || err.contains("daemon") {
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
pub async fn docker_list(backend: Option<String>) -> Result<Vec<Container>, String> {
    let backend = backend.unwrap_or_else(|| "win".into());
    tauri::async_runtime::spawn_blocking(move || {
        let out = docker(&backend, &["ps", "-a", "--no-trunc", "--format", "{{json .}}"])?;
        out.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Container>(l).map_err(|e| e.to_string()))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn docker_action(id: String, action: String, backend: Option<String>) -> Result<(), String> {
    let backend = backend.unwrap_or_else(|| "win".into());
    // tylko znane akcje: nie przepuszczamy dowolnych argumentów do dockera
    let verb = match action.as_str() {
        "start" | "stop" | "restart" | "rm" => action,
        _ => return Err(format!("nieznana akcja: {action}")),
    };
    tauri::async_runtime::spawn_blocking(move || docker(&backend, &[&verb, &id]).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}
