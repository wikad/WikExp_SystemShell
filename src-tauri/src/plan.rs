//! Plik planu (kanban + kalendarz): `%APPDATA%\WikExp\plan\plan.json`. Zwykły JSON, żeby Claude Code
//! (i człowiek) mógł go czytać i edytować. Obok leżą CLAUDE.md z opisem schematu, walidator i dzienne kopie.
//! Zapis jest atomowy (plik tymczasowy + zamiana), a przed zapisem sprawdzamy, że to poprawny JSON.
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const CLAUDE_MD: &str = include_str!("plan_claude.md");
const VALIDATE_MJS: &str = include_str!("plan_validate.mjs");
pub const KEEP_BACKUPS: usize = 14;
const MAX_PLAN_BYTES: u64 = 20 * 1024 * 1024;

pub fn plan_dir() -> PathBuf {
    crate::applog::log_dir().join("plan")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    /// None = plik jeszcze nie istnieje (pierwsze uruchomienie)
    pub text: Option<String>,
    /// czas modyfikacji w ms od 1970 (0 = brak pliku)
    pub mtime: u64,
    pub dir: String,
    pub path: String,
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tag kopii dziennej: tylko cyfry i myślniki ("2026-10-29"), bo trafia do nazwy pliku.
pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 10 && tag.chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn backup_name(tag: &str) -> String {
    format!("plan.bak-{tag}.json")
}

/// Które kopie skasować: zostaje `keep` najnowszych (nazwy z datą sortują się chronologicznie).
pub fn backups_to_delete(names: &[String], keep: usize) -> Vec<String> {
    let mut b: Vec<String> = names.iter().filter(|n| n.starts_with("plan.bak-") && n.ends_with(".json")).cloned().collect();
    b.sort();
    let n = b.len().saturating_sub(keep);
    b.into_iter().take(n).collect()
}

fn write_if_changed(path: &Path, content: &str) {
    if fs::read_to_string(path).map(|c| c == content).unwrap_or(false) {
        return;
    }
    if let Err(e) = fs::write(path, content) {
        crate::logw!("[plan] nie udało się zapisać {}: {e}", path.display());
    }
}

/// Folder + pliki pomocnicze (instrukcja dla Claude Code, walidator). Błędy tylko do logu.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("nie można utworzyć {}: {e}", dir.display()))?;
    write_if_changed(&dir.join("CLAUDE.md"), CLAUDE_MD);
    write_if_changed(&dir.join("validate.mjs"), VALIDATE_MJS);
    Ok(())
}

pub fn load_in(dir: &Path) -> Result<PlanFile, String> {
    ensure_dir(dir)?;
    let path = dir.join("plan.json");
    let text = if path.is_file() {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_PLAN_BYTES {
            return Err("plan.json jest większy niż 20 MB".into());
        }
        Some(fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?)
    } else {
        None
    };
    Ok(PlanFile { text, mtime: mtime_ms(&path), dir: dir.to_string_lossy().into_owned(), path: path.to_string_lossy().into_owned() })
}

pub fn save_in(dir: &Path, text: &str, backup_tag: &str) -> Result<u64, String> {
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        return Err("odmowa zapisu: dane planu nie są poprawnym JSON".into());
    }
    ensure_dir(dir)?;
    let path = dir.join("plan.json");
    // dzienna kopia poprzedniej wersji (raz na dzień, pierwszy zapis tego dnia)
    if valid_tag(backup_tag) && path.is_file() {
        let bak = dir.join(backup_name(backup_tag));
        if !bak.exists() {
            if let Err(e) = fs::copy(&path, &bak) {
                crate::logw!("[plan] kopia dzienna nie powiodła się: {e}");
            }
            if let Ok(rd) = fs::read_dir(dir) {
                let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                for old in backups_to_delete(&names, KEEP_BACKUPS) {
                    let _ = fs::remove_file(dir.join(old));
                }
            }
        }
    }
    let tmp = dir.join("plan.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("zapis {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("zamiana {}: {e}", path.display())
    })?;
    Ok(mtime_ms(&path))
}

#[tauri::command]
pub fn plan_load() -> Result<PlanFile, String> {
    load_in(&plan_dir())
}

/// `backup_tag` = dzisiejsza data lokalna "RRRR-MM-DD" (kopia poprzedniej wersji raz dziennie).
#[tauri::command]
pub fn plan_save(text: String, backup_tag: String) -> Result<u64, String> {
    save_in(&plan_dir(), &text, &backup_tag)
}

/// Czas modyfikacji pliku (ms), 0 gdy go nie ma. Tani odczyt do wykrywania zmian zrobionych poza WikExp.
#[tauri::command]
pub fn plan_stat() -> u64 {
    mtime_ms(&plan_dir().join("plan.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wikexp-plan-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn tag_tylko_cyfry_i_myslniki() {
        assert!(valid_tag("2026-10-29"));
        assert!(!valid_tag(""));
        assert!(!valid_tag("..\\x"));
        assert!(!valid_tag("2026/10/29"));
        assert!(!valid_tag("2026-10-29-extra"));
    }

    #[test]
    fn przycinanie_kopii_zostawia_najnowsze() {
        let names: Vec<String> = ["plan.bak-2026-10-01.json", "plan.bak-2026-10-03.json", "plan.bak-2026-10-02.json", "plan.json", "CLAUDE.md"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(backups_to_delete(&names, 2), vec!["plan.bak-2026-10-01.json"]);
        assert!(backups_to_delete(&names, 3).is_empty());
        assert_eq!(backups_to_delete(&names, 0).len(), 3);
    }

    #[test]
    fn pierwszy_start_tworzy_folder_i_pliki_pomocnicze() {
        let d = tmp("first");
        let f = load_in(&d).unwrap();
        assert!(f.text.is_none());
        assert_eq!(f.mtime, 0);
        assert!(d.join("CLAUDE.md").is_file() && d.join("validate.mjs").is_file());
        assert!(fs::read_to_string(d.join("CLAUDE.md")).unwrap().contains("plan.json"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn zapis_odczyt_nadpisanie_i_odmowa_zlego_json() {
        let d = tmp("save");
        let m1 = save_in(&d, r#"{"a":1}"#, "2026-10-29").unwrap();
        assert!(m1 > 0);
        assert_eq!(load_in(&d).unwrap().text.as_deref(), Some(r#"{"a":1}"#));
        // zły JSON nie nadpisuje dobrego pliku
        assert!(save_in(&d, "{nie json", "2026-10-29").is_err());
        assert_eq!(load_in(&d).unwrap().text.as_deref(), Some(r#"{"a":1}"#));
        // nie zostaje plik tymczasowy
        assert!(!d.join("plan.json.tmp").exists());
        save_in(&d, r#"{"a":2}"#, "2026-10-29").unwrap();
        assert_eq!(load_in(&d).unwrap().text.as_deref(), Some(r#"{"a":2}"#));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn kopia_dzienna_raz_dziennie_z_poprzednia_wersja() {
        let d = tmp("bak");
        save_in(&d, r#"{"v":1}"#, "2026-10-29").unwrap();           // brak poprzedniego pliku: bez kopii
        assert!(!d.join("plan.bak-2026-10-29.json").exists());
        save_in(&d, r#"{"v":2}"#, "2026-10-29").unwrap();           // pierwsza zmiana dnia: kopia wersji 1
        assert_eq!(fs::read_to_string(d.join("plan.bak-2026-10-29.json")).unwrap(), r#"{"v":1}"#);
        save_in(&d, r#"{"v":3}"#, "2026-10-29").unwrap();           // kolejne tego dnia nie nadpisują kopii
        assert_eq!(fs::read_to_string(d.join("plan.bak-2026-10-29.json")).unwrap(), r#"{"v":1}"#);
        save_in(&d, r#"{"v":4}"#, "zły/tag").unwrap();              // zły tag: bez kopii, zapis działa
        assert!(!d.join("plan.bak-zły").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stare_kopie_sa_usuwane() {
        let d = tmp("prune");
        save_in(&d, "{}", "2026-01-01").unwrap();
        for day in 1..=20 {
            save_in(&d, &format!("{{\"d\":{day}}}"), &format!("2026-02-{day:02}")).unwrap();
        }
        let n = fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("plan.bak-")).count();
        assert_eq!(n, KEEP_BACKUPS);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn instrukcja_dla_claude_zawiera_kluczowe_zasady() {
        for s in ["node validate.mjs", "plan.json", "exceptions", "scheduled", "link"] {
            assert!(CLAUDE_MD.contains(s), "brakuje: {s}");
        }
    }
}
