//! Autostart programów. Gdy powłoką jest explorer.exe, to on odpala wpisy z kluczy `Run`/`RunOnce`
//! i z folderów Startup. Bez niego robi to WikExp: raz po zalogowaniu (pierwszy start potomka pod
//! watchdogiem), nigdy po restarcie po awarii. Szanuje wyłączenia z Menedżera zadań (`StartupApproved`).
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// skąd wpis: "HKCU Run", "HKLM Run", "HKLM Run (32-bit)", "RunOnce", "folder Startup" ...
    pub source: String,
    pub name: String,
    /// wiersz poleceń (Run) albo ścieżka pliku (folder)
    pub command: String,
    /// false = wyłączony w Menedżerze zadań
    pub enabled: bool,
    /// true = wpis z folderu (uruchamiany przez ShellExecute), false = wiersz poleceń z rejestru
    pub folder: bool,
    /// true = RunOnce z HKCU: po uruchomieniu wartość się usuwa, jak robi Windows
    #[serde(skip)]
    pub once: bool,
    #[serde(skip)]
    pub key: String,
}

// ---------- czysta logika ----------

/// `StartupApproved`: pierwszy bajt parzysty (02, 06) = włączony, nieparzysty (03, 07) = wyłączony.
/// Brak wartości = włączony (tak robi Menedżer zadań).
pub fn is_approved(data: Option<&[u8]>) -> bool {
    data.and_then(|d| d.first()).is_none_or(|b| b & 1 == 0)
}

/// Pliki w folderze Startup, których nie uruchamiamy.
pub fn is_noise_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "desktop.ini" || n == "thumbs.db"
}

/// Wiersz poleceń dla `cmd /C start "" <wiersz>`: `start` rozwiąże zmienne %VAR% i ścieżki z argumentami,
/// czyli zrobi to samo, co explorer z wartością z klucza Run.
pub fn cmd_line_for(command: &str) -> String {
    format!("/C start \"\" {}", command.trim())
}

// ---------- rejestr (Windows) ----------

#[cfg(windows)]
mod reg {
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_EXPAND_SZ, REG_SZ,
    };

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(root: HKEY, path: &str) -> Option<HKEY> {
        let mut key: HKEY = std::ptr::null_mut();
        let rc = unsafe { RegOpenKeyExW(root, wide(path).as_ptr(), 0, KEY_READ, &mut key) };
        (rc == ERROR_SUCCESS).then_some(key)
    }

    /// Wszystkie wartości tekstowe klucza: (nazwa, dane). Brak klucza = pusta lista.
    pub fn values(root: HKEY, path: &str) -> Vec<(String, String)> {
        let Some(key) = open(root, path) else { return Vec::new() };
        let mut out = Vec::new();
        let mut index = 0u32;
        loop {
            let mut name = vec![0u16; 16384];
            let mut name_len = name.len() as u32;
            let mut data = vec![0u8; 32768];
            let mut data_len = data.len() as u32;
            let mut ty = 0u32;
            let rc = unsafe {
                RegEnumValueW(key, index, name.as_mut_ptr(), &mut name_len, std::ptr::null(), &mut ty, data.as_mut_ptr(), &mut data_len)
            };
            index += 1;
            if rc == ERROR_NO_MORE_ITEMS {
                break;
            }
            if rc == ERROR_MORE_DATA || rc != ERROR_SUCCESS {
                if index > 4096 { break; }
                continue; // za duży albo uszkodzony wpis: pomijamy
            }
            if ty != REG_SZ && ty != REG_EXPAND_SZ {
                continue;
            }
            let units: Vec<u16> = data[..data_len as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            let text = String::from_utf16_lossy(&units).trim_end_matches('\0').to_string();
            out.push((String::from_utf16_lossy(&name[..name_len as usize]), text));
        }
        unsafe { RegCloseKey(key) };
        out
    }

    /// Surowe bajty wartości (np. StartupApproved). None = brak klucza albo wartości.
    pub fn binary(root: HKEY, path: &str, name: &str) -> Option<Vec<u8>> {
        let key = open(root, path)?;
        let mut size = 0u32;
        let n = wide(name);
        let rc = unsafe { RegQueryValueExW(key, n.as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
        let mut out = None;
        if rc == ERROR_SUCCESS {
            let mut buf = vec![0u8; size as usize];
            let rc = unsafe { RegQueryValueExW(key, n.as_ptr(), std::ptr::null(), std::ptr::null_mut(), buf.as_mut_ptr(), &mut size) };
            if rc == ERROR_SUCCESS {
                buf.truncate(size as usize);
                out = Some(buf);
            }
        }
        unsafe { RegCloseKey(key) };
        out
    }
}

/// Zbiera wszystkie wpisy autostartu (także wyłączone, z flagą `enabled`), bez wpisu samego WikExp.
#[cfg(windows)]
pub fn list() -> Vec<Entry> {
    use windows_sys::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    const CV: &str = r"Software\Microsoft\Windows\CurrentVersion";
    let me = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out: Vec<Entry> = Vec::new();

    // (źródło, korzeń, klucz Run, klucz StartupApproved, wartości RunOnce?)
    let run: [(&str, HKEY, String, Option<String>, bool); 5] = [
        ("HKCU Run", HKEY_CURRENT_USER, format!(r"{CV}\Run"), Some(format!(r"{CV}\Explorer\StartupApproved\Run")), false),
        ("HKLM Run", HKEY_LOCAL_MACHINE, format!(r"{CV}\Run"), Some(format!(r"{CV}\Explorer\StartupApproved\Run")), false),
        ("HKLM Run (32-bit)", HKEY_LOCAL_MACHINE, format!(r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"), Some(format!(r"{CV}\Explorer\StartupApproved\Run32")), false),
        ("HKCU RunOnce", HKEY_CURRENT_USER, format!(r"{CV}\RunOnce"), None, true),
        ("HKLM RunOnce", HKEY_LOCAL_MACHINE, format!(r"{CV}\RunOnce"), None, true),
    ];
    for (source, root, key, approved, once) in run {
        for (name, command) in reg::values(root, &key) {
            if command.trim().is_empty() || crate::safety::same_command(&command, &me) {
                continue;
            }
            let enabled = match &approved {
                Some(ak) => is_approved(reg::binary(root, ak, &name).as_deref()),
                None => true,
            };
            let delete_after = once && root == HKEY_CURRENT_USER;
            out.push(Entry { source: source.into(), name, command, enabled, folder: false, once: delete_after, key: key.clone() });
        }
    }

    // foldery Startup
    let folders: [(&str, HKEY, Option<std::path::PathBuf>); 2] = [
        ("folder Startup", HKEY_CURRENT_USER, std::env::var_os("APPDATA").map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\Startup"))),
        ("folder Startup (wspólny)", HKEY_LOCAL_MACHINE, std::env::var_os("ProgramData").map(|p| std::path::PathBuf::from(p).join(r"Microsoft\Windows\Start Menu\Programs\StartUp"))),
    ];
    for (source, root, dir) in folders {
        let Some(dir) = dir else { continue };
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<_> = rd.flatten().collect();
        files.sort_by_key(|e| e.file_name());
        for e in files {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_noise_file(&name) || e.path().is_dir() {
                continue;
            }
            let ak = format!(r"{CV}\Explorer\StartupApproved\StartupFolder");
            let enabled = is_approved(reg::binary(root, &ak, &name).as_deref());
            out.push(Entry { source: source.into(), name, command: e.path().to_string_lossy().into_owned(), enabled, folder: true, once: false, key: String::new() });
        }
    }
    out
}
#[cfg(not(windows))]
pub fn list() -> Vec<Entry> {
    Vec::new()
}

#[cfg(windows)]
fn start(e: &Entry) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if e.folder {
        return crate::win::launch(&e.command);
    }
    std::process::Command::new("cmd.exe")
        .raw_arg(cmd_line_for(&e.command))
        .env_remove(crate::watchdog::ENV_FIRST_RUN)
        .env_remove(crate::watchdog::ENV_SUPERVISED)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Wołane przy starcie aplikacji. Robi coś tylko dla pierwszego startu potomka watchdoga, czyli po
/// zalogowaniu, gdy WikExp jest powłoką. W osobnym wątku, z przerwami, żeby nie zalać systemu naraz.
#[cfg(windows)]
pub fn run_if_first_start() {
    if std::env::var(crate::watchdog::ENV_FIRST_RUN).as_deref() != Ok("1") {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2)); // pasek i pulpit mają się najpierw pokazać
        let entries = list();
        crate::logi!("[autostart] {} wpisów, uruchamiam włączone", entries.len());
        for e in entries {
            if !e.enabled {
                crate::logi!("[autostart] pomijam (wyłączony w Menedżerze zadań): {} [{}]", e.name, e.source);
                continue;
            }
            match start(&e) {
                Ok(()) => crate::logi!("[autostart] uruchomiono: {} [{}] {}", e.name, e.source, e.command),
                Err(err) => crate::loge!("[autostart] {} nie wystartował: {err}", e.name),
            }
            if e.once {
                let _ = crate::safety::delete_hkcu_value(&e.key, &e.name);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    });
}
#[cfg(not(windows))]
pub fn run_if_first_start() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_approved_bajt_pierwszy() {
        assert!(is_approved(None));
        assert!(is_approved(Some(&[])));
        assert!(is_approved(Some(&[0x02, 0, 0, 0])));
        assert!(is_approved(Some(&[0x06, 0, 0, 0])));
        assert!(!is_approved(Some(&[0x03, 0, 0, 0])));
        assert!(!is_approved(Some(&[0x07, 0, 0, 0])));
    }

    #[test]
    fn pliki_smieciowe() {
        assert!(is_noise_file("desktop.ini"));
        assert!(is_noise_file("Desktop.INI"));
        assert!(!is_noise_file("Discord.lnk"));
    }

    #[test]
    fn wiersz_poleceń_start() {
        assert_eq!(cmd_line_for(r#""C:\a b\x.exe" -silent"#), r#"/C start "" "C:\a b\x.exe" -silent"#);
        assert_eq!(cmd_line_for("  notepad  "), r#"/C start "" notepad"#);
    }
}
