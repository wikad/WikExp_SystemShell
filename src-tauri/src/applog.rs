//! Log do pliku `%APPDATA%\WikExp\log.txt` (bez explorera w release nie ma konsoli, więc to jedyny ślad
//! po błędach). Rotacja: po przekroczeniu ~1 MB plik trafia do `log.old.txt`, a log zaczyna się od nowa.
//! Użycie: `crate::logi!("[start] {}", x)`, `crate::logw!(..)`, `crate::loge!(..)`.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1_000_000;
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[macro_export]
macro_rules! logi { ($($arg:tt)*) => { $crate::applog::info(&format!($($arg)*)) }; }
#[macro_export]
macro_rules! logw { ($($arg:tt)*) => { $crate::applog::warn(&format!($($arg)*)) }; }
#[macro_export]
macro_rules! loge { ($($arg:tt)*) => { $crate::applog::error(&format!($($arg)*)) }; }

pub fn log_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(|a| PathBuf::from(a).join("WikExp"))
        .unwrap_or_else(|| std::env::temp_dir().join("WikExp"))
}

pub fn log_path() -> Option<PathBuf> {
    Some(log_dir().join("log.txt"))
}

/// "YYYY-MM-DD HH:MM:SS" (UTC) z sekund Uniksa; algorytm civil_from_days (H. Hinnant).
pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Czas lokalny z Windows (GetLocalTime); poza Windowsem UTC.
fn timestamp() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut st) };
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
        );
    }
    #[allow(unreachable_code)]
    {
        format_utc(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
    }
}

/// Jeśli plik jest większy niż `max` bajtów, przenosi go do `<nazwa>.old.txt` (nadpisując stary).
pub fn rotate_if_needed(path: &Path, max: u64) {
    if fs::metadata(path).map(|m| m.len() > max).unwrap_or(false) {
        let _ = fs::rename(path, path.with_extension("old.txt"));
    }
}

fn write_to(path: &Path, level: &str, msg: &str) {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        // kolejne linie wieloliniowego komunikatu (np. backtrace) wcięte, żeby wpisy dało się odróżnić
        let body = msg.replace('\n', "\n    ");
        let _ = writeln!(f, "{} [{}] {}", timestamp(), level, body);
    }
}

pub fn write(level: &str, msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
    if let Some(p) = log_path() {
        write_to(&p, level, msg);
    }
}
pub fn info(msg: &str) { write("INFO", msg); }
pub fn warn(msg: &str) { write("WARN", msg); }
pub fn error(msg: &str) { write("ERROR", msg); }

/// Wołane raz, na samym początku `run()`.
pub fn init() {
    if let Some(p) = log_path() {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        rotate_if_needed(&p, MAX_BYTES);
    }
    info(&format!(
        "=== WikExp {} start (pid {}, {}) ===",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        if cfg!(debug_assertions) { "debug" } else { "release" }
    ));
}

/// Panika też trafia do logu (razem z backtrace), potem działa domyślny hak.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        error(&format!("PANIKA: {info}\n{bt}"));
        prev(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wikexp-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn format_utc_znane_daty() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00"); // rok przestępny
        assert_eq!(format_utc(1_000_000_000), "2001-09-09 01:46:40");
        assert_eq!(format_utc(1_700_000_000), "2023-11-14 22:13:20");
        assert_eq!(format_utc(2_147_483_647), "2038-01-19 03:14:07");
        assert_eq!(format_utc(4_102_444_799), "2099-12-31 23:59:59");
        assert_eq!(format_utc(1_709_164_800), "2024-02-29 00:00:00");
    }

    #[test]
    fn zapis_dopisuje_i_wcina_wieloliniowe() {
        let d = tmp("zapis");
        let p = d.join("sub").join("log.txt"); // katalog nie istnieje, ma zostać utworzony
        write_to(&p, "INFO", "pierwszy");
        write_to(&p, "ERROR", "linia1\nlinia2");
        let s = fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines.len(), 3, "{s}");
        assert!(lines[0].ends_with("[INFO] pierwszy"));
        assert!(lines[1].ends_with("[ERROR] linia1"));
        assert_eq!(lines[2], "    linia2");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rotacja_tylko_gdy_za_duzy() {
        let d = tmp("rot");
        let p = d.join("log.txt");
        fs::write(&p, "x".repeat(20)).unwrap();
        rotate_if_needed(&p, 100); // mały plik: bez zmian
        assert!(p.exists() && !d.join("log.old.txt").exists());
        rotate_if_needed(&p, 10); // duży: do log.old.txt
        assert!(!p.exists());
        assert_eq!(fs::read_to_string(d.join("log.old.txt")).unwrap().len(), 20);
        // kolejna rotacja nadpisuje stary plik, nie wywala się
        fs::write(&p, "y".repeat(30)).unwrap();
        rotate_if_needed(&p, 10);
        assert_eq!(fs::read_to_string(d.join("log.old.txt")).unwrap().len(), 30);
        // brak pliku: nic się nie dzieje
        rotate_if_needed(&d.join("nie-ma.txt"), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn wspolbiezne_zapisy_nie_gubia_linii() {
        let d = tmp("watki");
        let p = d.join("log.txt");
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let p = p.clone();
                std::thread::spawn(move || for i in 0..50 { write_to(&p, "INFO", &format!("w{t}-{i}")); })
            })
            .collect();
        for h in handles { h.join().unwrap(); }
        assert_eq!(fs::read_to_string(&p).unwrap().lines().count(), 400);
        let _ = fs::remove_dir_all(&d);
    }
}
