use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

/// Jedna sesja = jeden ukryty PowerShell podpięty do jednego panelu terminala.
struct Session {
    generation: u64, // odróżnia starą sesję od nowej o tym samym id
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Wszystkie sesje, kluczem jest id panelu z frontu ("terminal", "terminal-2", ...).
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, PtyState>, id: String, cols: u16, rows: u16, shell: String, cwd: Option<String>) -> Result<(), String> {
    // tylko znane shelle: z frontu nie da się podać dowolnego programu
    let program = match shell.as_str() {
        "powershell.exe" | "pwsh.exe" | "cmd.exe" | "wsl.exe" => shell,
        _ => "powershell.exe".to_string(),
    };
    if state.sessions.lock().unwrap().contains_key(&id) {
        return Ok(()); // ta sesja już działa
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&program);
    // folder startowy: tylko istniejący katalog, inaczej shell wystartuje w domyślnym
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let generation = NEXT_GEN.fetch_add(1, Ordering::Relaxed);

    let thread_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("pty-output", Output { id: thread_id.clone(), data: buf[..n].to_vec() });
                }
            }
        }
        // shell się zakończył (np. `exit`): usuń sesję, ale tylko jeśli to wciąż ta sama
        let state = app.state::<PtyState>();
        let mut sessions = state.sessions.lock().unwrap();
        if sessions.get(&thread_id).is_some_and(|s| s.generation == generation) {
            sessions.remove(&thread_id);
        }
        drop(sessions);
        let _ = app.emit("pty-exit", Exit { id: thread_id });
    });

    state.sessions.lock().unwrap().insert(
        id,
        Session { generation, writer, master: pair.master, child },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("brak sesji terminala")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("brak sesji terminala")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Zamknięcie panelu: zabij shell i zwolnij pseudo-konsolę.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = state.sessions.lock().unwrap().remove(&id);
    if let Some(mut s) = removed {
        let _ = s.child.kill();
        // writer i master zwalniają się tutaj (drop), co zamyka ConPTY
    }
    Ok(())
}
