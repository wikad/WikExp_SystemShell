//! Zasilanie: zablokuj, wyloguj, uśpij, uruchom ponownie, wyłącz (przyciski na pasku).
//! Restart, wyłączenie i wylogowanie idą przez `shutdown.exe` (system sam załatwia uprawnienia
//! `SeShutdownPrivilege`, o które musielibyśmy prosić przy `ExitWindowsEx`).

#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Lock,
    Sleep,
    /// argumenty dla shutdown.exe
    Shutdown(&'static [&'static str]),
}

/// Zamienia nazwę akcji z interfejsu na plan. Tylko biała lista: nic z interfejsu nie trafia do wiersza poleceń.
pub fn plan(action: &str) -> Result<Plan, String> {
    match action {
        "lock" => Ok(Plan::Lock),
        "sleep" => Ok(Plan::Sleep),
        "logoff" => Ok(Plan::Shutdown(&["/l"])),
        "restart" => Ok(Plan::Shutdown(&["/r", "/t", "0"])),
        "shutdown" => Ok(Plan::Shutdown(&["/s", "/t", "0"])),
        other => Err(format!("nieznana akcja zasilania: {other}")),
    }
}

#[cfg(windows)]
fn run_plan(p: Plan) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    match p {
        Plan::Lock => std::process::Command::new("rundll32.exe")
            .args(["user32.dll,LockWorkStation"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Plan::Sleep => {
            // hibernate = 0 (uśpienie), force = 0, wakeup events disabled = 0
            let ok = unsafe { windows_sys::Win32::System::Power::SetSuspendState(0, 0, 0) };
            if ok == 0 { Err("SetSuspendState nie powiodło się".into()) } else { Ok(()) }
        }
        Plan::Shutdown(args) => std::process::Command::new("shutdown.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}
#[cfg(not(windows))]
fn run_plan(_p: Plan) -> Result<(), String> {
    Err("tylko Windows".into())
}

#[tauri::command]
pub fn power_action(action: String) -> Result<(), String> {
    let p = plan(&action)?;
    crate::logi!("[zasilanie] {action}");
    let r = run_plan(p);
    if let Err(e) = &r {
        crate::loge!("[zasilanie] {action} nie powiodło się: {e}");
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn biala_lista_akcji() {
        assert_eq!(plan("lock"), Ok(Plan::Lock));
        assert_eq!(plan("sleep"), Ok(Plan::Sleep));
        assert_eq!(plan("restart"), Ok(Plan::Shutdown(&["/r", "/t", "0"])));
        assert_eq!(plan("shutdown"), Ok(Plan::Shutdown(&["/s", "/t", "0"])));
        assert_eq!(plan("logoff"), Ok(Plan::Shutdown(&["/l"])));
        assert!(plan("").is_err());
        assert!(plan("shutdown /s & calc").is_err());
        assert!(plan("LOCK").is_err());
    }
}
