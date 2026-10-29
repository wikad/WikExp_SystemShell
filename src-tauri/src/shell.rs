//! Powłoka: pasek boczny (AppBar z lewej), główne okno na pełny ekran,
//! lista okien innych programów, ukrywanie paska zadań Windows.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Szerokość paska w pikselach logicznych (przy skali 150% będzie 60 px fizycznych).
/// Musi się zgadzać z "width" okna "bar" w tauri.conf.json.
pub const BAR_WIDTH: f64 = 40.0;

static APPBAR_HWND: Mutex<Option<isize>> = Mutex::new(None);
static TASKBAR_HIDDEN: Mutex<bool> = Mutex::new(false);
/// Prostokąt przydzielony paskowi przez Windows (x, y, szerokość, wysokość). Gdy pasek
/// zadań Windows jest widoczny, Windows skraca go tak, żeby kończył się nad paskiem Windows.
static BAR_RECT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

#[cfg(windows)]
pub use crate::win::{Battery, WinInfo};
#[cfg(not(windows))]
#[derive(serde::Serialize, Clone)]
pub struct WinInfo {}
#[cfg(not(windows))]
#[derive(serde::Serialize, Clone)]
pub struct Battery {}

struct Monitor { x: i32, y: i32, w: i32, h: i32, scale: f64 }

fn primary(win: &WebviewWindow) -> Option<Monitor> {
    let m = win.primary_monitor().ok().flatten()?;
    Some(Monitor { x: m.position().x, y: m.position().y, w: m.size().width as i32, h: m.size().height as i32, scale: m.scale_factor() })
}

/// Docelowe miejsce głównego okna: cały ekran poza paskiem bocznym (cover_taskbar = true)
/// albo obszar roboczy Windowsa, czyli też bez paska zadań Windows. (x, y, szer., wys.)
fn main_target(main: &WebviewWindow, cover_taskbar: bool) -> Option<(i32, i32, i32, i32)> {
    let m = primary(main)?;
    let bar = (BAR_WIDTH * m.scale).round() as i32;
    #[allow(unused_mut)]
    let (mut x, mut y, mut w, mut h) = (m.x + bar, m.y, m.w - bar, m.h);
    #[cfg(windows)]
    if !cover_taskbar {
        if let Some(rc) = crate::win::work_area() {
            (x, y, w, h) = (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
        }
    }
    let _ = cover_taskbar;
    Some((x, y, w.max(200), h.max(200)))
}

fn place_main(main: &WebviewWindow, cover_taskbar: bool) {
    let Some((x, y, w, h)) = main_target(main, cover_taskbar) else { return };
    let _ = main.unmaximize();
    let _ = main.set_position(PhysicalPosition::new(x, y));
    let _ = main.set_size(PhysicalSize::new(w as u32, h as u32));
}

static ENFORCING: AtomicBool = AtomicBool::new(false);

/// Główne okno jest pulpitem: po przesunięciu, przypięciu do boku (Win+strzałki),
/// zmianie rozmiaru albo minimalizacji wraca na swoje miejsce.
/// Wołane z lib.rs przy zdarzeniach Moved / Resized głównego okna.
pub fn enforce_main(app: &AppHandle) {
    // set_position sam wywołuje zdarzenie Moved, więc pilnujemy, żeby nie wpaść w pętlę
    if ENFORCING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        if main.is_minimized().unwrap_or(false) {
            let _ = main.unminimize();
        }
        let hidden = *TASKBAR_HIDDEN.lock().unwrap();
        if let (Some((x, y, w, h)), Ok(pos), Ok(size)) = (main_target(&main, hidden), main.outer_position(), main.outer_size()) {
            let off = (pos.x - x).abs() > 2 || (pos.y - y).abs() > 2
                || (size.width as i32 - w).abs() > 2 || (size.height as i32 - h).abs() > 2;
            if off || main.is_maximized().unwrap_or(false) {
                place_main(&main, hidden);
            }
        }
    }
    ENFORCING.store(false, Ordering::SeqCst);
}

/// Pasek boczny: przy ukrytym pasku Windows zawsze przy samej lewej krawędzi i na całą
/// wysokość (ignorujemy przesunięcia Windowsa, np. przez martwą rezerwację po zabitym
/// procesie), przy widocznym tak, jak przydzielił Windows (nad paskiem Windows).
fn place_bar(app: &AppHandle, cover_taskbar: bool) {
    let (Some(bar), Some(main)) = (app.get_webview_window("bar"), app.get_webview_window("main")) else { return };
    let Some(m) = primary(&main) else { return };
    let width = (BAR_WIDTH * m.scale).round() as i32;
    let (x, y, w, h) = match *BAR_RECT.lock().unwrap() {
        _ if cover_taskbar => (m.x, m.y, width, m.h),
        Some(r) => r,
        None => (m.x, m.y, width, m.h),
    };
    let _ = bar.set_position(PhysicalPosition::new(x, y));
    let _ = bar.set_size(PhysicalSize::new(w as u32, h as u32));
}

/// Wołane raz przy starcie aplikacji (lib.rs → setup).
pub fn setup(app: &AppHandle) {
    let main = app.get_webview_window("main");
    if let (Some(bar), Some(main)) = (app.get_webview_window("bar"), main.as_ref()) {
        if let Some(m) = primary(main) {
            crate::logi!("[shell] monitor {}x{} @ {},{} skala {}", m.w, m.h, m.x, m.y, m.scale);
            let width = (BAR_WIDTH * m.scale).round() as i32;
            #[allow(unused_mut)]
            let mut rect = (m.x, m.y, width, m.h);
            #[cfg(windows)]
            if let Ok(h) = bar.hwnd() {
                use windows_sys::Win32::Foundation::RECT;
                let hwnd = h.0 as isize;
                let mon = RECT { left: m.x, top: m.y, right: m.x + m.w, bottom: m.y + m.h };
                let rc = crate::win::register_appbar(hwnd, mon, width);
                rect = (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top);
                *APPBAR_HWND.lock().unwrap() = Some(hwnd);
                crate::logi!("[shell] AppBar zarejestrowany: {:?}", rect);
            }
            *BAR_RECT.lock().unwrap() = Some(rect);
            let _ = bar.set_position(PhysicalPosition::new(rect.0, rect.1));
            let _ = bar.set_size(PhysicalSize::new(rect.2 as u32, rect.3 as u32));
        }
        let _ = bar.show();
        place_main(main, false);
    }
    start_hotkeys(app);
    crate::logi!("[shell] start gotowy");
    // główne okno pokazujemy zawsze, nawet gdy coś wyżej się nie udało
    if let Some(main) = main {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

// ---------- okna innych programów w panelach ----------

/// Zadokowane okna: hwnd → stan sprzed zadokowania (do przywrócenia przy oddaniu).
#[cfg(windows)]
static DOCKED: Mutex<Option<std::collections::HashMap<isize, crate::win::Saved>>> = Mutex::new(None);

/// Stan zadokowanego okna dla frontu (rozmiar w pikselach CSS, jak getBoundingClientRect).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockInfo {
    alive: bool,
    visible: bool,
    minimized: bool,
    maximized: bool,
    w: f64,
    h: f64,
}

/// Wkłada okno programu w panel i ustawia je na prostokącie panelu.
/// x, y, w, h: piksele CSS względem głównego okna WikExp (getBoundingClientRect).
/// Zwraca stan okna: czy żyje, czy je schowano / zminimalizowano / zmaksymalizowano
/// i jaki ma naprawdę rozmiar (programy z minimalnym rozmiarem bywają większe niż panel).
#[tauri::command]
pub fn dock_window(app: AppHandle, hwnd: isize, x: f64, y: f64, w: f64, h: f64) -> Result<DockInfo, String> {
    let main = app.get_webview_window("main").ok_or("brak głównego okna")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let px = |v: f64| (v * scale).round() as i32;
    #[cfg(windows)]
    {
        if !crate::win::is_window(hwnd) {
            DOCKED.lock().unwrap().get_or_insert_with(Default::default).remove(&hwnd);
            return Ok(DockInfo { alive: false, visible: false, minimized: false, maximized: false, w: 0.0, h: 0.0 });
        }
        {
            let mut docked = DOCKED.lock().unwrap();
            let docked = docked.get_or_insert_with(Default::default);
            if !docked.contains_key(&hwnd) {
                let main_hwnd = main.hwnd().map_err(|e| e.to_string())?.0 as isize;
                docked.insert(hwnd, crate::win::dock(hwnd, main_hwnd));
            }
        }
        let st = crate::win::place(hwnd, origin.x + px(x), origin.y + px(y), px(w), px(h));
        return Ok(DockInfo {
            alive: st.alive,
            visible: st.visible,
            minimized: st.minimized,
            maximized: st.maximized,
            w: st.w as f64 / scale,
            h: st.h as f64 / scale,
        });
    }
    #[allow(unreachable_code)]
    {
        let _ = (hwnd, origin, px(x), px(y));
        Ok(DockInfo { alive: true, visible: true, minimized: false, maximized: false, w, h })
    }
}

/// Oddaje okno: wraca jego ramka, pasek tytułu i normalne zachowanie.
#[tauri::command]
pub fn undock_window(hwnd: isize) {
    #[cfg(windows)]
    if let Some(saved) = DOCKED.lock().unwrap().get_or_insert_with(Default::default).remove(&hwnd) {
        crate::win::unstyle_window(hwnd);
        crate::win::undock(hwnd, &saved);
    }
    let _ = hwnd;
}

/// Ramka zadokowanego okna w kolorach WikExp (kolory "#rrggbb", Windows 11).
#[tauri::command]
pub fn style_docked(hwnd: isize, border: String, caption: String, text: String, dark: bool) {
    #[cfg(windows)]
    if DOCKED.lock().unwrap().as_ref().is_some_and(|m| m.contains_key(&hwnd)) {
        crate::win::style_window(hwnd, &border, &caption, &text, dark);
    }
    let _ = (hwnd, border, caption, text, dark);
}

/// Lupka na pasku / Alt+Spacja: pokaż launcher obok paska albo go schowaj.
#[tauri::command]
pub fn toggle_launcher(app: AppHandle) {
    let Some(win) = app.get_webview_window("launcher") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        if let Some(m) = primary(&main) {
            let bar = (BAR_WIDTH * m.scale).round() as i32;
            let gap = (6.0 * m.scale).round() as i32;
            let _ = win.set_position(PhysicalPosition::new(m.x + bar + gap, m.y + gap));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("launcher", "launcher-open", ());
}

/// Przycisk zasilania na pasku: wysuwany panel nad dolną krawędzią, tuż obok paska.
#[tauri::command]
pub fn toggle_flyout(app: AppHandle) {
    let Some(win) = app.get_webview_window("flyout") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        if let Some(m) = primary(&main) {
            let bar = (BAR_WIDTH * m.scale).round() as i32;
            let gap = (6.0 * m.scale).round() as i32;
            let h = win.outer_size().map(|s| s.height as i32).unwrap_or((330.0 * m.scale) as i32);
            // dół panelu równo z dołem ekranu (minus przerwa), bo przycisk zasilania jest na dole paska
            let _ = win.set_position(PhysicalPosition::new(m.x + bar + gap, (m.y + m.h - h - gap).max(m.y)));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("flyout", "flyout-open", ());
}

#[tauri::command]
pub fn hide_flyout(app: AppHandle) {
    if let Some(win) = app.get_webview_window("flyout") {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn hide_launcher(app: AppHandle) {
    if let Some(win) = app.get_webview_window("launcher") {
        let _ = win.hide();
    }
}

#[tauri::command]
pub fn focus_main(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
}

/// Globalne Alt+H/J/K/L: działają też wtedy, gdy fokus jest w zadokowanym programie.
/// Wysyła do frontu event "global-nav" z kierunkiem.
pub fn start_hotkeys(app: &AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            crate::win::hotkey_loop(|c| {
                if c == ' ' {
                    toggle_launcher(app.clone()); // Alt+Spacja
                } else if c == '!' {
                    // Ctrl+Alt+F12: skrót awaryjny, działa też gdy interfejs WikExp się zawiesił
                    if let Err(e) = emergency_restore() {
                        crate::loge!("[awaryjnie] {e}");
                    }
                } else {
                    let _ = app.emit("global-nav", c.to_string());
                }
            });
        });
    }
    let _ = app;
}

/// Awaryjne przywrócenie klasycznego pulpitu: zwolnij pas AppBara, pokaż pasek Windows, uruchom explorer.exe.
/// Gdy żadna powłoka nie działa, explorer.exe zostaje nową powłoką; WikExp dalej działa obok.
pub fn emergency_restore() -> Result<(), String> {
    crate::logw!("[awaryjnie] przywracam pasek Windows i uruchamiam explorer.exe");
    #[cfg(windows)]
    {
        if let Some(h) = APPBAR_HWND.lock().unwrap_or_else(|e| e.into_inner()).take() {
            crate::win::remove_appbar(h);
        }
        crate::win::set_taskbar_visible(true);
        *TASKBAR_HIDDEN.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
    crate::safety::start_explorer()
}

/// Wołane przy wyjściu: oddaj zarezerwowany pas ekranu i przywróć pasek Windows.
pub fn cleanup() {
    crate::logi!("[shell] sprzątanie przy wyjściu");
    #[cfg(windows)]
    {
        // zadokowane okna wracają do normalności
        if let Some(map) = DOCKED.lock().unwrap().take() {
            for (hwnd, saved) in map {
                crate::win::unstyle_window(hwnd);
                crate::win::undock(hwnd, &saved);
            }
        }
        if let Some(h) = APPBAR_HWND.lock().unwrap().take() {
            crate::win::remove_appbar(h);
        }
        if *TASKBAR_HIDDEN.lock().unwrap() {
            crate::win::set_taskbar_visible(true);
        }
    }
}

#[tauri::command]
pub fn apply_shell_layout(app: AppHandle, hide_taskbar: bool) {
    #[cfg(windows)]
    crate::win::set_taskbar_visible(!hide_taskbar);
    *TASKBAR_HIDDEN.lock().unwrap() = hide_taskbar;
    crate::logi!("[shell] pasek Windows {}", if hide_taskbar { "ukryty" } else { "widoczny" });
    place_bar(&app, hide_taskbar);
    if let Some(main) = app.get_webview_window("main") {
        place_main(&main, hide_taskbar);
    }
}

#[tauri::command]
pub fn list_windows() -> Vec<WinInfo> {
    #[cfg(windows)]
    return crate::win::list_windows();
    #[cfg(not(windows))]
    return Vec::new();
}

#[tauri::command]
pub fn window_action(hwnd: isize, action: String) -> Result<(), String> {
    #[cfg(windows)]
    match action.as_str() {
        "focus" => crate::win::focus_window(hwnd),
        "minimize" => crate::win::minimize_window(hwnd),
        "close" => crate::win::close_window(hwnd),
        _ => return Err(format!("nieznana akcja: {action}")),
    }
    let _ = (hwnd, action);
    Ok(())
}

/// Stan baterii dla paska; null na komputerze bez baterii.
#[tauri::command]
pub fn battery_status() -> Option<Battery> {
    #[cfg(windows)]
    return crate::win::battery();
    #[cfg(not(windows))]
    return None;
}

/// Warstwa pulpitu: główne okno leży pod wszystkimi programami, jak tapeta.
static DESKTOP_LAYER: AtomicBool = AtomicBool::new(false);

/// Które okna zminimalizować, żeby odsłonić pulpit: wszystkie nieschowane już, poza zadokowanymi
/// w panelach WikExp (to część układu). Wejście: (hwnd, zminimalizowane).
fn to_minimize(windows: &[(isize, bool)], docked: &[isize]) -> Vec<isize> {
    windows.iter().filter(|(h, min)| !*min && !docked.contains(h)).map(|(h, _)| *h).collect()
}

/// Włącza / wyłącza warstwę pulpitu (przełącznik w ustawieniach).
#[tauri::command]
pub fn set_desktop_layer(app: AppHandle, enabled: bool) {
    DESKTOP_LAYER.store(enabled, Ordering::SeqCst);
    crate::logi!("[shell] warstwa pulpitu {}", if enabled { "włączona" } else { "wyłączona" });
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_always_on_bottom(enabled);
        if enabled {
            keep_bottom(&app);
        }
    }
}

/// Po aktywacji okna Windows wynosi je na wierzch; w trybie pulpitu zsuwamy je z powrotem na spód.
pub fn keep_bottom(app: &AppHandle) {
    if !DESKTOP_LAYER.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(windows)]
    if let Some(Ok(h)) = app.get_webview_window("main").map(|m| m.hwnd()) {
        crate::win::lower_window(h.0 as isize);
    }
    let _ = app;
}

/// Przycisk WikExp na pasku: pokaż główne okno. W trybie pulpitu najpierw chowa (minimalizuje)
/// pozostałe programy, bo samo okno leży na spodzie i inaczej nie byłoby widać.
#[tauri::command]
pub fn show_main(app: AppHandle) {
    let layer = DESKTOP_LAYER.load(Ordering::SeqCst);
    #[cfg(windows)]
    if layer {
        let docked: Vec<isize> = DOCKED.lock().unwrap().as_ref().map(|m| m.keys().copied().collect()).unwrap_or_default();
        let wins: Vec<(isize, bool)> = crate::win::list_windows().iter().map(|w| (w.hwnd, w.minimized)).collect();
        let list = to_minimize(&wins, &docked);
        crate::logi!("[shell] pokaż pulpit: minimalizuję {} okien", list.len());
        for h in list {
            crate::win::minimize_window(h);
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    if layer {
        keep_bottom(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::to_minimize;

    #[test]
    fn minimalizuje_tylko_widoczne_niezadokowane() {
        let wins = [(1, false), (2, true), (3, false), (4, false)];
        assert_eq!(to_minimize(&wins, &[3]), vec![1, 4]);
        assert!(to_minimize(&[], &[]).is_empty());
        assert!(to_minimize(&[(5, true)], &[]).is_empty());
    }
}
