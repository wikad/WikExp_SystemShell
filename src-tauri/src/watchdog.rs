//! Watchdog: gdy WikExp jest powłoką systemu, w rejestrze stoi `"wikexp.exe" --watchdog`.
//! Ten tryb nie otwiera żadnego okna: uruchamia właściwy WikExp jako proces potomny i pilnuje go.
//!  - awaria potomka (kod wyjścia inny niż 0 i 3) → restart po chwili,
//!  - 3 awarie w ciągu 2 minut → uruchom `explorer.exe` i zakończ (żeby nie zostać bez pulpitu),
//!  - normalne zamknięcie (Ctrl+Q, kod 0) → też `explorer.exe`: bez powłoki zostałby czarny ekran,
//!  - kod 3 = druga kopia, która sama się wycofała → supervisor po prostu kończy.
//! Zabicie samego wikexp.exe w Menedżerze zadań liczy się jak awaria (supervisor go podniesie),
//! więc awaryjnie używaj `Ctrl+Alt+F12` albo zabij oba procesy.
use std::process::Command;
use std::time::{Duration, Instant};

pub use crate::safety::WATCHDOG_ARG as ARG;

/// Kod wyjścia kopii, która zobaczyła mutex pierwszej i się wycofała.
pub const EXIT_ALREADY_RUNNING: i32 = 3;
/// Tyle awarii w oknie czasowym oznacza "WikExp nie działa, oddaj pulpit explorerowi".
pub const MAX_CRASHES: usize = 3;
pub const CRASH_WINDOW_SECS: u64 = 120;
/// Zmienne środowiskowe dla potomka: wie, że jest nadzorowany, i czy to pierwszy start po logowaniu
/// (autostart programów uruchamiamy tylko wtedy, nie po restarcie po awarii).
pub const ENV_SUPERVISED: &str = "WIKEXP_SUPERVISED";
pub const ENV_FIRST_RUN: &str = "WIKEXP_FIRST_RUN";

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// uruchom WikExp jeszcze raz
    Restart,
    /// uruchom explorer.exe i zakończ (powód do logu)
    Explorer(String),
    /// zakończ bez explorera
    Stop,
}

/// Zapisuje czasy awarii i decyduje, co zrobić po wyjściu potomka. Czas podajemy z zewnątrz (sekundy),
/// dzięki czemu da się to przetestować bez czekania.
#[derive(Default)]
pub struct Tracker {
    crashes: Vec<u64>,
}

impl Tracker {
    pub fn on_exit(&mut self, now_secs: u64, code: Option<i32>) -> Decision {
        match code {
            Some(0) => return Decision::Explorer("WikExp zamknięty normalnie, oddaję pulpit explorerowi".into()),
            Some(EXIT_ALREADY_RUNNING) => return Decision::Stop,
            _ => {}
        }
        self.crashes.push(now_secs);
        self.crashes.retain(|t| now_secs.saturating_sub(*t) < CRASH_WINDOW_SECS);
        if self.crashes.len() >= MAX_CRASHES {
            Decision::Explorer(format!("{} awarie w ciągu {} s", self.crashes.len(), CRASH_WINDOW_SECS))
        } else {
            Decision::Restart
        }
    }
}

/// Pętla nadzorcy. Wraca dopiero, gdy trzeba skończyć (po ewentualnym uruchomieniu explorera).
pub fn run_supervisor() {
    crate::logi!("[watchdog] start nadzorcy (pid {})", std::process::id());
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            // bez własnej ścieżki nie ma czego pilnować: pulpit ma dostać explorer
            crate::loge!("[watchdog] brak ścieżki programu: {e}");
            let _ = crate::safety::start_explorer();
            return;
        }
    };
    let t0 = Instant::now();
    let mut tracker = Tracker::default();
    let mut first = true;
    loop {
        let mut cmd = Command::new(&exe);
        cmd.env(ENV_SUPERVISED, "1");
        if first {
            cmd.env(ENV_FIRST_RUN, "1");
        } else {
            cmd.env_remove(ENV_FIRST_RUN);
        }
        first = false;
        let code = match cmd.spawn().and_then(|mut c| c.wait()) {
            Ok(st) => {
                crate::logi!("[watchdog] WikExp zakończył się, kod {:?}", st.code());
                st.code()
            }
            Err(e) => {
                crate::loge!("[watchdog] nie udało się uruchomić WikExp: {e}");
                Some(-1)
            }
        };
        match tracker.on_exit(t0.elapsed().as_secs(), code) {
            Decision::Restart => {
                crate::logw!("[watchdog] awaria, restart za 1 s");
                std::thread::sleep(Duration::from_secs(1));
            }
            Decision::Explorer(why) => {
                crate::logw!("[watchdog] {why}: uruchamiam explorer.exe");
                if let Err(e) = crate::safety::start_explorer() {
                    crate::loge!("[watchdog] {e}");
                }
                return;
            }
            Decision::Stop => {
                crate::logi!("[watchdog] koniec nadzoru");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalne_zamkniecie_oddaje_explorera() {
        let mut t = Tracker::default();
        assert!(matches!(t.on_exit(10, Some(0)), Decision::Explorer(_)));
    }

    #[test]
    fn druga_kopia_konczy_bez_explorera() {
        let mut t = Tracker::default();
        assert_eq!(t.on_exit(1, Some(EXIT_ALREADY_RUNNING)), Decision::Stop);
    }

    #[test]
    fn trzy_awarie_szybko_to_explorer() {
        let mut t = Tracker::default();
        assert_eq!(t.on_exit(5, Some(-1073741819)), Decision::Restart); // 0xC0000005
        assert_eq!(t.on_exit(8, Some(1)), Decision::Restart);
        assert!(matches!(t.on_exit(12, None), Decision::Explorer(_)));  // None = zabity sygnałem
    }

    #[test]
    fn rzadkie_awarie_nie_kumuluja_sie() {
        let mut t = Tracker::default();
        assert_eq!(t.on_exit(0, Some(1)), Decision::Restart);
        assert_eq!(t.on_exit(100, Some(1)), Decision::Restart);
        assert_eq!(t.on_exit(200, Some(1)), Decision::Restart); // w oknie: 100 i 200
        assert_eq!(t.on_exit(330, Some(1)), Decision::Restart); // 100 i 200 wypadły z okna 120 s
        assert_eq!(t.on_exit(340, Some(1)), Decision::Restart);
        assert!(matches!(t.on_exit(345, Some(1)), Decision::Explorer(_)));
    }

    #[test]
    fn granica_okna() {
        let mut t = Tracker::default();
        assert_eq!(t.on_exit(0, Some(1)), Decision::Restart);
        assert_eq!(t.on_exit(1, Some(1)), Decision::Restart);
        // dokładnie 120 s po pierwszej: ta już się nie liczy
        assert_eq!(t.on_exit(CRASH_WINDOW_SECS, Some(1)), Decision::Restart);
    }
}
