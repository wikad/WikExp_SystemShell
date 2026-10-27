// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;

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
        out.push(FileEntry{
            name: entry.file_name().to_string_lossy().into_owned(),
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

#[tauri::command]
fn parent_dir(path: String) -> Option<String> {
    let path = std::path::Path::new(&path);
    path.parent().map(|p| p.to_string_lossy().into_owned())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet,read_dir,parent_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
