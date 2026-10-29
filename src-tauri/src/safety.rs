//! Siatka bezpieczeństwa przed podmianą powłoki: blokada drugiej kopii (mutex), wpis powłoki w rejestrze
//! (`HKCU\...\Winlogon\Shell`), awaryjne uruchomienie `explorer.exe`.
//! Zasada: wszystko, co może zablokować start, kończy się "otwarciem" (start mimo błędu), nigdy odwrotnie.
use std::path::{Path, PathBuf};

pub const MUTEX_NAME: &str = "Local\\WikExp.SingleInstance";
/// Argument, z którym WikExp pracuje jako nadzorca (watchdog.rs); to on stoi w wartości `Shell`.
pub const WATCHDOG_ARG: &str = "--watchdog";
pub const WINLOGON_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------- jedna kopia ----------

/// true = jesteśmy jedyną kopią (albo mutexa nie dało się utworzyć: wtedy nie blokujemy startu).
/// Przy restarcie (np. `tauri dev`) stary proces może jeszcze chwilę żyć, więc próbujemy do 2 s.
#[cfg(windows)]
pub fn acquire_single_instance() -> bool {
    acquire_named(MUTEX_NAME)
}

/// To samo dla dowolnej nazwy mutexa (testy używają własnej, żeby nie zależeć od działającej aplikacji).
#[cfg(windows)]
fn acquire_named(mutex_name: &str) -> bool {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    // uchwyt musi żyć do końca procesu; Windows zwolni go sam przy wyjściu (też po awarii)
    static HELD: AtomicIsize = AtomicIsize::new(0);
    let name = wide(mutex_name);
    for attempt in 0..10 {
        unsafe {
            let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            let err = GetLastError();
            if h.is_null() {
                crate::logw!("[mutex] CreateMutexW nieudane (błąd {err}), start bez blokady");
                return true;
            }
            if err != ERROR_ALREADY_EXISTS {
                HELD.store(h as isize, Ordering::SeqCst);
                return true;
            }
            CloseHandle(h);
        }
        if attempt < 9 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    false
}
#[cfg(not(windows))]
pub fn acquire_single_instance() -> bool {
    true
}

/// Komunikat dla odrzuconej drugiej kopii: bez niego wyglądałoby to jak "nic się nie uruchamia"
/// (np. gdy pierwsza kopia się zawiesiła i nie widać jej okna).
#[cfg(windows)]
pub fn notify_already_running() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_TOPMOST};
    let text = wide(
        "WikExp już działa w tej sesji.\n\nJeśli nie widzisz jego okna: skrót Ctrl+Alt+F12 uruchomi explorer.exe, \
         a zawieszony proces wikexp.exe zamkniesz w Menedżerze zadań (Ctrl+Shift+Esc).\n\nLog: %APPDATA%\\WikExp\\log.txt",
    );
    let title = wide("WikExp");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
    }
}
#[cfg(not(windows))]
pub fn notify_already_running() {}

// ---------- czysta logika (testowana na każdym systemie) ----------

fn norm(p: &str) -> String {
    p.trim().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase()
}

/// Ścieżka programu z wartości `Shell`: w cudzysłowie albo (bez) do pierwszego ".exe".
pub fn command_exe(value: &str) -> String {
    let v = value.trim();
    if let Some(rest) = v.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    match v.to_ascii_lowercase().find(".exe") {
        Some(i) => v[..i + 4].to_string(),
        None => v.to_string(),
    }
}

/// Czy wartość `Shell` z rejestru wskazuje na ten program.
pub fn same_command(value: &str, exe: &str) -> bool {
    let a = norm(&command_exe(value));
    !a.is_empty() && a == norm(exe)
}

/// Build developerski ładuje UI z serwera Vite (localhost:1420), którego przy logowaniu nikt nie uruchomi.
pub fn is_dev_exe(exe: &str) -> bool {
    norm(exe).contains("\\target\\debug\\")
}

/// Wartość do wpisania w `Shell` albo powód odmowy. Odmawia dla buildów developerskich.
pub fn shell_command_for(exe: &Path, debug_build: bool) -> Result<String, String> {
    let s = exe.to_string_lossy().into_owned();
    if debug_build || is_dev_exe(&s) {
        return Err("To build developerski (npm run tauri dev): bez serwera Vite dostałbyś puste okno zamiast pulpitu. \
                    Zbuduj wersję release (npm run tauri build) i ustaw powłokę z niej.".into());
    }
    if !exe.is_file() {
        return Err(format!("Nie ma pliku programu: {s}"));
    }
    if s.contains('"') {
        return Err("Ścieżka programu zawiera cudzysłów".into());
    }
    Ok(format!("\"{}\" {WATCHDOG_ARG}", s.trim_start_matches(r"\\?\")))
}

// ---------- rejestr: HKCU\...\Winlogon\Shell ----------

/// Odczyt wartości tekstowej z HKCU\<key>. None = brak klucza albo wartości.
#[cfg(windows)]
fn reg_read(key_path: &str, name: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_EXPAND_SZ, REG_SZ,
    };
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        let rc = RegOpenKeyExW(HKEY_CURRENT_USER, wide(key_path).as_ptr(), 0, KEY_READ, &mut key);
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyExW: kod błędu {rc}"));
        }
        let name = wide(name);
        let mut ty: u32 = 0;
        let mut size: u32 = 0;
        let rc = RegQueryValueExW(key, name.as_ptr(), std::ptr::null(), &mut ty, std::ptr::null_mut(), &mut size);
        if rc == ERROR_FILE_NOT_FOUND {
            RegCloseKey(key);
            return Ok(None);
        }
        if rc != ERROR_SUCCESS {
            RegCloseKey(key);
            return Err(format!("RegQueryValueExW: kod błędu {rc}"));
        }
        let mut buf: Vec<u16> = vec![0; (size as usize) / 2 + 2];
        let mut size2 = (buf.len() * 2) as u32;
        let rc = RegQueryValueExW(key, name.as_ptr(), std::ptr::null(), &mut ty, buf.as_mut_ptr() as *mut u8, &mut size2);
        RegCloseKey(key);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegQueryValueExW: kod błędu {rc}"));
        }
        if ty != REG_SZ && ty != REG_EXPAND_SZ {
            return Err("wartość w rejestrze nie jest tekstem".into());
        }
        buf.truncate((size2 as usize) / 2);
        while buf.last() == Some(&0) {
            buf.pop();
        }
        Ok(Some(String::from_utf16_lossy(&buf)))
    }
}

#[cfg(windows)]
fn reg_write(key_path: &str, name: &str, value: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER, wide(key_path).as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut(),
        );
        if rc != ERROR_SUCCESS {
            return Err(format!("RegCreateKeyExW: kod błędu {rc}"));
        }
        let data = wide(value);
        let rc = RegSetValueExW(key, wide(name).as_ptr(), 0, REG_SZ, data.as_ptr() as *const u8, (data.len() * 2) as u32);
        RegCloseKey(key);
        if rc != ERROR_SUCCESS {
            return Err(format!("RegSetValueExW: kod błędu {rc}"));
        }
        Ok(())
    }
}

/// Usuwa wartość z HKCU\<key>. Brak klucza albo wartości to nie błąd.
#[cfg(windows)]
fn reg_delete(key_path: &str, name: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE};
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        let rc = RegOpenKeyExW(HKEY_CURRENT_USER, wide(key_path).as_ptr(), 0, KEY_SET_VALUE, &mut key);
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("RegOpenKeyExW: kod błędu {rc}"));
        }
        let rc = RegDeleteValueW(key, wide(name).as_ptr());
        RegCloseKey(key);
        if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
            return Err(format!("RegDeleteValueW: kod błędu {rc}"));
        }
        Ok(())
    }
}

/// Usuwa wartość z HKCU\<key> (np. RunOnce po uruchomieniu wpisu).
#[cfg(windows)]
pub fn delete_hkcu_value(key_path: &str, name: &str) -> Result<(), String> { reg_delete(key_path, name) }

/// Aktualna wartość `Shell` użytkownika (None = brak wpisu, czyli domyślnie explorer.exe z HKLM).
#[cfg(windows)]
pub fn shell_value() -> Result<Option<String>, String> { reg_read(WINLOGON_KEY, "Shell") }
#[cfg(windows)]
pub fn set_shell_value(value: &str) -> Result<(), String> { reg_write(WINLOGON_KEY, "Shell", value) }
/// Usuwa wpis `Shell` użytkownika (powrót do explorer.exe). Brak wpisu to nie błąd.
#[cfg(windows)]
pub fn clear_shell_value() -> Result<(), String> { reg_delete(WINLOGON_KEY, "Shell") }

#[cfg(not(windows))]
pub fn shell_value() -> Result<Option<String>, String> { Ok(None) }
#[cfg(not(windows))]
pub fn set_shell_value(_value: &str) -> Result<(), String> { Err("tylko Windows".into()) }
#[cfg(not(windows))]
pub fn clear_shell_value() -> Result<(), String> { Err("tylko Windows".into()) }

// ---------- awaryjny explorer ----------

/// Ścieżka do explorer.exe: `%SystemRoot%\explorer.exe`, a gdy jej nie ma, samo "explorer.exe" z PATH.
pub fn explorer_path() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let exe = root.join("explorer.exe");
    if exe.is_file() { exe } else { PathBuf::from("explorer.exe") }
}

/// Uruchamia explorer.exe. Gdy żadna powłoka nie działa, to on staje się pulpitem i paskiem zadań.
pub fn start_explorer() -> Result<(), String> {
    std::process::Command::new(explorer_path())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("nie udało się uruchomić explorer.exe: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_exe_cudzyslow_i_argumenty() {
        assert_eq!(command_exe(r#""C:\Program Files\WikExp\wikexp.exe""#), r"C:\Program Files\WikExp\wikexp.exe");
        assert_eq!(command_exe(r#""C:\a b\w.exe" --flaga"#), r"C:\a b\w.exe");
        assert_eq!(command_exe(r"explorer.exe"), "explorer.exe");
        assert_eq!(command_exe(r"C:\Program Files\x\W.EXE /s"), r"C:\Program Files\x\W.EXE");
        assert_eq!(command_exe("  "), "");
        assert_eq!(command_exe(r#""niezamkniety"#), "niezamkniety");
    }

    #[test]
    fn same_command_ignoruje_wielkosc_liter_ukosniki_prefiks() {
        let exe = r"C:\devWikExp\WikExp\src-tauri\target\release\wikexp.exe";
        assert!(same_command(&format!("\"{exe}\""), exe));
        assert!(same_command(&format!("\"{}\"", exe.to_uppercase()), exe));
        assert!(same_command(&format!("\"{}\"", exe.replace('\\', "/")), exe));
        assert!(same_command(&format!("\"\\\\?\\{exe}\" --x"), exe));
        assert!(!same_command("explorer.exe", exe));
        assert!(!same_command("", exe));
        assert!(!same_command("", ""));                       // puste nigdy nie "pasuje"
        assert!(!same_command(r#""C:\inne\wikexp.exe""#, exe));
    }

    #[test]
    fn is_dev_exe_tylko_debug() {
        assert!(is_dev_exe(r"C:\x\src-tauri\target\debug\wikexp.exe"));
        assert!(is_dev_exe(r"C:\X\SRC-TAURI\TARGET\DEBUG\WIKEXP.EXE"));
        assert!(is_dev_exe("C:/x/target/debug/wikexp.exe"));
        assert!(!is_dev_exe(r"C:\x\src-tauri\target\release\wikexp.exe"));
        assert!(!is_dev_exe(r"C:\Program Files\WikExp\wikexp.exe"));
        assert!(!is_dev_exe(r"C:\debug\wikexp.exe"));
    }

    #[test]
    fn shell_command_for_odmowy_i_sukces() {
        let dir = std::env::temp_dir().join(format!("wikexp-safety-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("target").join("debug")).unwrap();
        std::fs::create_dir_all(dir.join("target").join("release")).unwrap();
        let dbg = dir.join("target").join("debug").join("w.exe");
        let rel = dir.join("target").join("release").join("w.exe");
        std::fs::write(&dbg, b"x").unwrap();
        std::fs::write(&rel, b"x").unwrap();

        assert!(shell_command_for(&rel, true).unwrap_err().contains("developerski"));  // flaga debug
        assert!(shell_command_for(&dbg, false).unwrap_err().contains("developerski")); // ścieżka debug
        assert!(shell_command_for(&dir.join("target").join("release").join("brak.exe"), false).unwrap_err().contains("Nie ma pliku"));
        assert!(shell_command_for(&dir, false).is_err());                               // katalog to nie program
        let ok = shell_command_for(&rel, false).unwrap();
        assert!(ok.starts_with('"') && ok.ends_with(" --watchdog") && ok.contains("w.exe\""));
        assert!(same_command(&ok, &rel.to_string_lossy()));                             // pętla: zapis → odczyt zgodny
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn explorer_path_zawsze_cos_zwraca() {
        let p = explorer_path();
        assert!(p.to_string_lossy().to_lowercase().ends_with("explorer.exe"));
    }
}

/// Testy kodu WinAPI: uruchamiaj na Windowsie (`cargo test` w src-tauri). Rejestr tylko w tymczasowym
/// kluczu HKCU\\Software\\WikExpTest\\<pid>, prawdziwego wpisu Winlogon\\Shell testy nie dotykają.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn cleanup(key: &str) {
        use windows_sys::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};
        unsafe {
            RegDeleteKeyW(HKEY_CURRENT_USER, wide(key).as_ptr());
            RegDeleteKeyW(HKEY_CURRENT_USER, wide(r"Software\WikExpTest").as_ptr());
        }
    }

    #[test]
    fn rejestr_zapis_odczyt_nadpisanie_usuwanie() {
        let key = format!(r"Software\WikExpTest\{}", std::process::id());
        cleanup(&key);
        assert_eq!(reg_read(&key, "Shell").unwrap(), None, "brak klucza = None");
        reg_delete(&key, "Shell").unwrap(); // usuwanie z nieistniejącego klucza nie jest błędem

        let unicode = r#""C:\Zażółć gęślą jaźń\wikexp.exe""#;
        reg_write(&key, "Shell", unicode).unwrap();
        assert_eq!(reg_read(&key, "Shell").unwrap().as_deref(), Some(unicode));
        reg_write(&key, "Shell", "explorer.exe").unwrap(); // nadpisanie
        assert_eq!(reg_read(&key, "Shell").unwrap().as_deref(), Some("explorer.exe"));
        assert_eq!(reg_read(&key, "Inna").unwrap(), None, "klucz jest, wartości nie ma");

        reg_delete(&key, "Shell").unwrap();
        reg_delete(&key, "Shell").unwrap(); // idempotentne
        assert_eq!(reg_read(&key, "Shell").unwrap(), None);
        cleanup(&key);
    }

    #[test]
    fn mutex_druga_proba_w_tym_samym_procesie_odpada() {
        // własna nazwa: prawdziwy mutex może akurat trzymać działający WikExp (np. `npm run tauri dev`)
        let name = format!("Local\\WikExp.Test.{}", std::process::id());
        assert!(acquire_named(&name), "pierwsza kopia musi przejść");
        // ten sam proces otwiera już istniejący mutex, więc po ~2 s ponowień dostaje false
        assert!(!acquire_named(&name), "druga kopia nie może przejść");
    }
}
