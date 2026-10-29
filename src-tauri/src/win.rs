//! Wywołania Win32 dla powłoki WikExp: AppBar, lista okien, ikony programów, pasek zadań Windows.
// Edycja 2024 wymaga bloku `unsafe {}` także wewnątrz `unsafe fn`. Tu cały moduł to
// wywołania WinAPI, więc wyłączamy to ostrzeżenie dla tego pliku.
#![allow(unsafe_op_in_unsafe_fn)]
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT, TRUE};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{
    SHAppBarMessage, SHGetFileInfoW, ABE_LEFT, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA, SHFILEINFOW,
    SHGFI_ICON, SHGFI_LARGEICON,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, FindWindowExW, FindWindowW, GetForegroundWindow, GetIconInfo, GetWindow,
    GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    PostMessageW, SetForegroundWindow, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, GW_OWNER, ICONINFO,
    SPI_GETWORKAREA, SW_HIDE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, WM_CLOSE, WM_USER, WS_EX_TOOLWINDOW,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------- AppBar: zarezerwowany pas ekranu z lewej ----------

/// Rejestruje okno jako AppBar przy lewej krawędzi monitora `mon`.
/// Zwraca prostokąt, który Windows przydzielił (w pikselach fizycznych).
pub fn register_appbar(hwnd: isize, mon: RECT, width: i32) -> RECT {
    unsafe {
        let mut abd: APPBARDATA = std::mem::zeroed();
        abd.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        abd.hWnd = hwnd as HWND;
        abd.uCallbackMessage = WM_USER + 42;
        SHAppBarMessage(ABM_NEW, &mut abd);
        abd.uEdge = ABE_LEFT;
        abd.rc = RECT { left: mon.left, top: mon.top, right: mon.left + width, bottom: mon.bottom };
        SHAppBarMessage(ABM_QUERYPOS, &mut abd); // Windows może przesunąć (np. inny AppBar już tam jest)
        // zawsze przy samej lewej krawędzi: martwe rezerwacje po zabitych procesach (tauri dev)
        // nakładają się wtedy na ten sam pas, zamiast odsuwać obszar roboczy coraz dalej w prawo
        abd.rc.left = mon.left;
        abd.rc.right = mon.left + width;
        SHAppBarMessage(ABM_SETPOS, &mut abd); // od teraz zmaksymalizowane okna omijają ten pas
        abd.rc
    }
}

pub fn remove_appbar(hwnd: isize) {
    unsafe {
        let mut abd: APPBARDATA = std::mem::zeroed();
        abd.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        abd.hWnd = hwnd as HWND;
        SHAppBarMessage(ABM_REMOVE, &mut abd);
    }
}

/// Obszar roboczy głównego monitora (ekran minus paski: nasz i Windowsa).
pub fn work_area() -> Option<RECT> {
    unsafe {
        let mut rc: RECT = std::mem::zeroed();
        (SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut rc as *mut RECT as *mut c_void, 0) != 0).then_some(rc)
    }
}

/// Pokazuje / ukrywa pasek zadań Windows (główny i na pozostałych monitorach).
pub fn set_taskbar_visible(visible: bool) {
    let cmd = if visible { SW_SHOW } else { SW_HIDE };
    unsafe {
        let main = FindWindowW(wide("Shell_TrayWnd").as_ptr(), std::ptr::null());
        if !main.is_null() {
            ShowWindow(main, cmd);
        }
        let class = wide("Shell_SecondaryTrayWnd");
        let mut prev: HWND = std::ptr::null_mut();
        loop {
            let h = FindWindowExW(std::ptr::null_mut(), prev, class.as_ptr(), std::ptr::null());
            if h.is_null() {
                break;
            }
            ShowWindow(h, cmd);
            prev = h;
        }
    }
}

// ---------- lista okien ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WinInfo {
    pub hwnd: isize,
    pub title: String,
    pub exe: String,
    pub icon: Option<String>, // data:image/png;base64,...
    pub active: bool,
    pub minimized: bool,
}

/// Czy to "prawdziwe" okno aplikacji, takie jakie Windows pokazuje na pasku zadań.
unsafe fn is_app_window(h: HWND) -> bool {
    if IsWindowVisible(h) == 0 || !GetWindow(h, GW_OWNER).is_null() {
        return false;
    }
    if (GetWindowLongW(h, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
        return false;
    }
    if GetWindowTextLengthW(h) == 0 {
        return false;
    }
    // okna "ukryte" przez system (np. aplikacje UWP w tle) są widoczne, ale zasłonięte
    let mut cloaked: u32 = 0;
    DwmGetWindowAttribute(h, DWMWA_CLOAKED as _, &mut cloaked as *mut u32 as *mut c_void, 4);
    cloaked == 0
}

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam as *mut Vec<HWND>);
    if is_app_window(h) {
        list.push(h);
    }
    TRUE
}

unsafe fn window_title(h: HWND) -> String {
    let len = GetWindowTextLengthW(h);
    let mut buf = vec![0u16; len as usize + 1];
    let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe fn window_exe(h: HWND) -> (u32, String) {
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, &mut pid);
    let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if proc.is_null() {
        return (pid, String::new());
    }
    let mut buf = vec![0u16; 1024];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
    CloseHandle(proc);
    (pid, if ok != 0 { String::from_utf16_lossy(&buf[..size as usize]) } else { String::new() })
}

static ICONS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// Ikona programu z pliku .exe jako PNG w base64 (z pamięcią podręczną).
fn exe_icon(exe: &str) -> Option<String> {
    if exe.is_empty() {
        return None;
    }
    let mut cache = ICONS.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(v) = cache.get(exe) {
        return v.clone();
    }
    let icon = unsafe { extract_icon_png(exe) }
        .map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)));
    cache.insert(exe.to_string(), icon.clone());
    icon
}

unsafe fn extract_icon_png(exe: &str) -> Option<Vec<u8>> {
    let mut info: SHFILEINFOW = std::mem::zeroed();
    let path = wide(exe);
    let r = if exe.starts_with("shell:") {
        // aplikacje ze Sklepu nie mają pliku .exe: ikonę bierzemy z obiektu powłoki
        // (shell:AppsFolder\<AppID>), przez jego PIDL, czyli „adres” w przestrzeni nazw Explorera
        use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
        use windows_sys::Win32::UI::Shell::{SHParseDisplayName, SHGFI_PIDL};
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32); // już zainicjowane = też OK
        let mut pidl = std::ptr::null_mut();
        if SHParseDisplayName(path.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) < 0 || pidl.is_null() {
            return None;
        }
        let r = SHGetFileInfoW(pidl as *const u16, 0, &mut info, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON | SHGFI_PIDL);
        CoTaskMemFree(pidl as *const c_void);
        r
    } else {
        SHGetFileInfoW(path.as_ptr(), 0, &mut info, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON)
    };
    if r == 0 || info.hIcon.is_null() {
        return None;
    }
    let hicon = info.hIcon;
    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        DestroyIcon(hicon);
        return None;
    }
    let mut bm: BITMAP = std::mem::zeroed();
    GetObjectW(ii.hbmColor as _, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut BITMAP as *mut c_void);
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    let mut out = None;
    if w > 0 && h > 0 {
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // ujemna wysokość = wiersze od góry
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let screen = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(screen);
        let lines = GetDIBits(dc, ii.hbmColor, 0, h as u32, px.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS);
        DeleteDC(dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        if lines > 0 {
            // BGRA → RGBA; stare ikony bez kanału alfa → nieprzezroczyste
            let no_alpha = px.chunks(4).all(|p| p[3] == 0);
            for p in px.chunks_mut(4) {
                p.swap(0, 2);
                if no_alpha {
                    p[3] = 255;
                }
            }
            let mut png_bytes = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
                enc.set_color(png::ColorType::Rgba);
                enc.set_depth(png::BitDepth::Eight);
                if let Ok(mut wr) = enc.write_header() {
                    if wr.write_image_data(&px).is_ok() {
                        out = Some(());
                    }
                }
            }
            if out.is_some() {
                DeleteObject(ii.hbmColor as _);
                DeleteObject(ii.hbmMask as _);
                DestroyIcon(hicon);
                return Some(png_bytes);
            }
        }
    }
    DeleteObject(ii.hbmColor as _);
    DeleteObject(ii.hbmMask as _);
    DestroyIcon(hicon);
    None
}

/// Okna aplikacji w kolejności Z (najwyżej leżące pierwsze), bez okien WikExp.
pub fn list_windows() -> Vec<WinInfo> {
    let me = std::process::id();
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut hwnds as *mut Vec<HWND> as LPARAM);
        let fg = GetForegroundWindow();
        hwnds
            .into_iter()
            .filter_map(|h| {
                let (pid, exe) = window_exe(h);
                (pid != me).then(|| WinInfo {
                    hwnd: h as isize,
                    title: window_title(h),
                    icon: exe_icon(&exe),
                    exe,
                    active: h == fg,
                    minimized: IsIconic(h) != 0,
                })
            })
            .collect()
    }
}

pub fn focus_window(hwnd: isize) {
    let h = hwnd as HWND;
    unsafe {
        if IsIconic(h) != 0 {
            ShowWindow(h, SW_RESTORE);
        }
        SetForegroundWindow(h);
    }
}

pub fn minimize_window(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd as HWND, SW_MINIMIZE);
    }
}

/// Zsuwa okno na sam spód kolejności Z, bez aktywowania go (warstwa pulpitu).
pub fn lower_window(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::HWND_BOTTOM;
    unsafe {
        SetWindowPos(hwnd as HWND, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

pub fn close_window(hwnd: isize) {
    unsafe {
        PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
    }
}

// ---------- bateria ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
    pub plugged: bool,
    pub seconds_left: Option<u32>, // szacowany czas pracy na baterii (Windows nie zawsze go zna)
    pub saver: bool,               // oszczędzanie baterii włączone
}

/// Stan baterii; None, gdy komputer nie ma baterii (np. stacjonarny).
pub fn battery() -> Option<Battery> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    unsafe {
        let mut s: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut s) == 0 {
            return None;
        }
        // BatteryFlag: 128 = brak baterii, 255 = stan nieznany; procent 255 = nieznany
        if s.BatteryFlag == 128 || s.BatteryFlag == 255 || s.BatteryLifePercent > 100 {
            return None;
        }
        Some(Battery {
            percent: s.BatteryLifePercent,
            charging: s.BatteryFlag & 8 != 0,
            plugged: s.ACLineStatus == 1,
            seconds_left: (s.BatteryLifeTime != u32::MAX).then_some(s.BatteryLifeTime),
            saver: s.SystemStatusFlag == 1,
        })
    }
}

// ---------- dokowanie okien innych programów w panelach WikExp ----------

use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, IsWindow, SetWindowLongPtrW, SetWindowPos, GWLP_HWNDPARENT, GWL_STYLE, HWND_TOP,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZE, WS_THICKFRAME,
};

/// Zapamiętany stan okna sprzed zadokowania (do przywrócenia).
pub struct Saved {
    style: isize,
    owner: isize,
}

pub fn is_window(hwnd: isize) -> bool {
    unsafe { IsWindow(hwnd as HWND) != 0 }
}

/// Wkłada okno w panel: właścicielem zostaje główne okno WikExp (okno zawsze jest nad nim,
/// ale pod innymi programami), bez paska tytułu i ramki do zmiany rozmiaru.
pub fn dock(hwnd: isize, main: isize) -> Saved {
    unsafe {
        let h = hwnd as HWND;
        if IsIconic(h) != 0 || (GetWindowLongPtrW(h, GWL_STYLE) as u32) & WS_MAXIMIZE != 0 {
            ShowWindow(h, SW_RESTORE);
        }
        let style = GetWindowLongPtrW(h, GWL_STYLE);
        let owner = GetWindowLongPtrW(h, GWLP_HWNDPARENT);
        SetWindowLongPtrW(h, GWLP_HWNDPARENT, main);
        SetWindowLongPtrW(h, GWL_STYLE, style & !((WS_CAPTION | WS_THICKFRAME) as isize));
        SetWindowPos(h, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Saved { style, owner }
    }
}

/// Stan zadokowanego okna po próbie ustawienia go w panelu.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockState {
    pub alive: bool,     // okno jeszcze istnieje
    pub visible: bool,   // nie zostało schowane (np. do zasobnika po kliknięciu ×)
    pub minimized: bool, // użytkownik kliknął „—”
    pub maximized: bool, // użytkownik kliknął „□” (okno jest już z powrotem w panelu)
    pub w: i32,          // rzeczywisty rozmiar okna (piksele fizyczne): większy niż panel,
    pub h: i32,          //   gdy program ma minimalny rozmiar
}

/// Ustawia zadokowane okno na prostokącie panelu (piksele fizyczne ekranu) i zwraca jego stan.
/// Zminimalizowanego nie rusza (panel pokazuje „przywróć”), zmaksymalizowane cofa do panelu
/// i zgłasza to, żeby front mógł powiększyć panel.
pub fn place(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> DockState {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    unsafe {
        let hw = hwnd as HWND;
        let mut st = DockState { alive: IsWindow(hw) != 0, visible: false, minimized: false, maximized: false, w: 0, h: 0 };
        if !st.alive {
            return st;
        }
        st.visible = IsWindowVisible(hw) != 0;
        st.minimized = IsIconic(hw) != 0;
        st.maximized = (GetWindowLongPtrW(hw, GWL_STYLE) as u32) & WS_MAXIMIZE != 0;
        if !st.visible || st.minimized {
            return st;
        }
        if st.maximized {
            ShowWindow(hw, SW_RESTORE);
        }
        SetWindowPos(hw, HWND_TOP, x, y, w.max(50), h.max(50), SWP_NOACTIVATE);
        let mut rc: RECT = std::mem::zeroed();
        GetWindowRect(hw, &mut rc);
        st.w = rc.right - rc.left;
        st.h = rc.bottom - rc.top;
        st
    }
}

/// Oddaje okno: przywraca ramkę, pasek tytułu i właściciela, lekko je odsuwa.
pub fn undock(hwnd: isize, saved: &Saved) {
    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) == 0 {
            return;
        }
        SetWindowLongPtrW(h, GWLP_HWNDPARENT, saved.owner);
        SetWindowLongPtrW(h, GWL_STYLE, saved.style);
        SetWindowPos(h, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }
}

// ---------- globalne skróty Alt+H/J/K/L ----------

/// Rejestruje Alt+H/J/K/L i Alt+Spacja dla całego systemu i blokuje wątek w pętli komunikatów.
/// `on_key` dostaje 'h' / 'j' / 'k' / 'l' / ' '. Uruchamiać w osobnym wątku.
pub fn hotkey_loop(on_key: impl Fn(char)) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
    unsafe {
        // Alt+H/J/K/L = panele, Alt+Spacja = launcher, Ctrl+Alt+F12 = awaryjny explorer ('!').
        // Ctrl+Alt+F12 zamiast litery, bo na polskiej klawiaturze Ctrl+Alt to AltGr (Ctrl+Alt+E = "ę").
        let keys = [
            ('h', 0x48u32, MOD_ALT), ('j', 0x4A, MOD_ALT), ('k', 0x4B, MOD_ALT), ('l', 0x4C, MOD_ALT),
            (' ', 0x20, MOD_ALT), ('!', 0x7B, MOD_CONTROL | MOD_ALT),
        ];
        for (i, (c, vk, mods)) in keys.iter().enumerate() {
            // null jako okno: WM_HOTKEY trafia do kolejki tego wątku
            if RegisterHotKey(std::ptr::null_mut(), i as i32 + 1, *mods | MOD_NOREPEAT, *vk) == 0 {
                crate::logw!("[hotkey] nie udało się zarejestrować skrótu {:?} (błąd {})", c, GetLastError());
            }
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_HOTKEY {
                if let Some((c, _, _)) = keys.get(msg.wParam.wrapping_sub(1)) {
                    on_key(*c);
                }
            }
        }
    }
}

// ---------- wygląd zadokowanego okna (Windows 11) ----------

/// Kolor w formacie COLORREF (0x00BBGGRR) z "#rrggbb".
fn colorref(hex: &str) -> Option<u32> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    let (r, g, b) = ((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    Some(b << 16 | g << 8 | r)
}

/// Dopasowuje ramkę okna do WikExp: kolor ramki, ciemny pasek tytułu, kolor paska
/// (tylko programy z systemowym paskiem tytułu) i małe zaokrąglenie rogów.
/// Na Windows 10 te atrybuty są po prostu ignorowane.
pub fn style_window(hwnd: isize, border: &str, caption: &str, text: &str, dark: bool) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUNDSMALL,
    };
    unsafe {
        let h = hwnd as HWND;
        let set = |attr: i32, val: u32| {
            DwmSetWindowAttribute(h, attr as _, &val as *const u32 as *const c_void, 4);
        };
        set(DWMWA_USE_IMMERSIVE_DARK_MODE as i32, dark as u32);
        set(DWMWA_WINDOW_CORNER_PREFERENCE as i32, DWMWCP_ROUNDSMALL as u32);
        if let Some(c) = colorref(border) { set(DWMWA_BORDER_COLOR as i32, c); }
        if let Some(c) = colorref(caption) { set(DWMWA_CAPTION_COLOR as i32, c); }
        if let Some(c) = colorref(text) { set(DWMWA_TEXT_COLOR as i32, c); }
    }
}

/// Przywraca domyślny wygląd ramki (przy oddawaniu okna).
pub fn unstyle_window(hwnd: isize) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT,
    };
    const DEFAULT_COLOR: u32 = 0xFFFF_FFFF; // DWMWA_COLOR_DEFAULT
    unsafe {
        let h = hwnd as HWND;
        let set = |attr: i32, val: u32| {
            DwmSetWindowAttribute(h, attr as _, &val as *const u32 as *const c_void, 4);
        };
        set(DWMWA_BORDER_COLOR as i32, DEFAULT_COLOR);
        set(DWMWA_CAPTION_COLOR as i32, DEFAULT_COLOR);
        set(DWMWA_TEXT_COLOR as i32, DEFAULT_COLOR);
        set(DWMWA_WINDOW_CORNER_PREFERENCE as i32, DWMWCP_DEFAULT as u32);
    }
}

// ---------- launcher ----------

/// Ikona dowolnego pliku (np. skrótu .lnk z menu Start) jako PNG w base64, z pamięcią podręczną.
pub fn file_icon(path: &str) -> Option<String> {
    exe_icon(path)
}

/// Uruchamia program, skrót, plik albo adres (np. "ms-settings:") tak jak dwuklik w Windows.
/// Aplikacje ze Sklepu ("shell:AppsFolder\\<AppID>") idą przez explorer.exe: tak robi menu Start.
pub fn launch(target: &str) -> Result<(), String> {
    launch_verb(target, "open")
}

/// To samo z wybraną czynnością: "open" = domyślny program, "openas" = okno „Otwórz za pomocą”.
pub fn launch_verb(target: &str, verb: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = wide(verb);
    let (file, params) = if target.starts_with("shell:") { (wide("explorer.exe"), Some(wide(target))) } else { (wide(target), None) };
    let params_ptr = params.as_ref().map_or(std::ptr::null(), |p| p.as_ptr());
    let r = unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), params_ptr, std::ptr::null(), SW_SHOWNORMAL)
    };
    // ShellExecute zwraca wartość > 32 przy sukcesie
    if (r as isize) > 32 { Ok(()) } else { Err(format!("nie udało się uruchomić: {target}")) }
}
