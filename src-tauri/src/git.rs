//! Git: status repozytorium (branch, ahead/behind, zmienione pliki), diff, commit, pull/push/fetch.
//! Wszystko przez CLI `git` (jest zainstalowany, bo użytkownik go używa), bez okna konsoli.
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Uruchamia `git -C <dir> <args>` bez migającego okna konsoli. Zwraca (stdout, sukces, stderr).
fn git_raw(dir: &str, args: &[&str]) -> Result<(String, bool, String), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    // commity bez skonfigurowanego edytora / pagera nie mogą blokować
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat").env("GIT_EDITOR", "true");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|_| "git nie jest zainstalowany albo nie ma go w PATH".to_string())?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        out.status.success(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

/// Jak wyżej, ale błąd (niezerowy kod) zamienia na Err ze stderr.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let (out, ok, err) = git_raw(dir, args)?;
    if ok { Ok(out) } else { Err(if err.is_empty() { "błąd git".into() } else { err }) }
}

/// Katalog główny repozytorium. Ścieżki z `git status` są względem niego,
/// więc diff/stage muszą działać w nim, a nie w podfolderze otwartym w panelu.
fn repo_root(dir: &str) -> Result<String, String> {
    Ok(git(dir, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict"
    status: String,
    staged: bool,      // zmiana jest w indeksie (do commita)
    unstaged: bool,    // zmiana jest też w katalogu roboczym
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    root: String,          // katalog główny repozytorium
    branch: String,        // nazwa brancha albo skrócony hash przy "detached HEAD"
    upstream: Option<String>,
    ahead: u32,            // commity do wypchnięcia
    behind: u32,           // commity do pobrania
    files: Vec<GitFile>,
    /// szybka mapa ścieżka → status, dla kolorowania plików i drzewa
    file_map: std::collections::HashMap<String, String>,
}

fn classify(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "added",
        'U' => "conflict",
        _ => "modified",
    }
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    let empty = |is_repo: bool| GitStatus {
        is_repo, root: String::new(), branch: String::new(), upstream: None,
        ahead: 0, behind: 0, files: vec![], file_map: Default::default(),
    };
    // katalog główny repozytorium (albo: to nie jest repo)
    let root = match git_raw(&path, &["rev-parse", "--show-toplevel"]) {
        Ok((out, true, _)) => out.trim().replace('/', "\\"),
        _ => return Ok(empty(false)),
    };

    let raw = git(&path, &["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"])?;
    // -z: rekordy rozdzielone znakiem \0 (bezpieczne dla nazw ze spacjami/polskimi znakami)
    let mut parts = raw.split('\0');
    let mut branch = String::new();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut file_map = std::collections::HashMap::new();

    if let Some(head) = parts.next() {
        // "## main...origin/main [ahead 2, behind 1]"  albo  "## No commits yet on main"
        let h = head.trim_start_matches("## ");
        if let Some(rest) = h.strip_prefix("No commits yet on ") {
            branch = rest.to_string();
        } else {
            // nazwa kończy się na "..." (upstream) albo spacji; sama kropka może być w nazwie
            let name = h.split("...").next().unwrap_or("");
            branch = name.split(' ').next().unwrap_or("").to_string();
            if let Some(u) = h.split("...").nth(1) {
                upstream = Some(u.split(' ').next().unwrap_or("").to_string());
            }
            if let Some(b) = h.split('[').nth(1) {
                for seg in b.trim_end_matches(']').split(", ") {
                    if let Some(n) = seg.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = seg.strip_prefix("behind ") { behind = n.parse().unwrap_or(0); }
                }
            }
        }
    }

    while let Some(entry) = parts.next() {
        if entry.len() < 3 { continue; }
        let bytes: Vec<char> = entry.chars().collect();
        let (x, y) = (bytes[0], bytes[1]);
        let mut name: String = entry[3..].to_string();
        // zmiana nazwy: po \0 jest stara ścieżka — pomijamy ją
        if x == 'R' || x == 'C' { parts.next(); }
        let status = if x == '?' && y == '?' {
            "untracked"
        } else if x == 'U' || y == 'U' {
            "conflict"
        } else {
            classify(if x != ' ' && x != '?' { x } else { y })
        };
        name = name.trim_end_matches('/').replace('/', "\\");
        file_map.insert(name.clone(), status.to_string());
        files.push(GitFile {
            path: name,
            status: status.to_string(),
            staged: x != ' ' && x != '?',
            unstaged: y != ' ',
        });
    }

    Ok(GitStatus { is_repo: true, root, branch, upstream, ahead, behind, files, file_map })
}

/// Diff jednego pliku. staged=true → zmiany w indeksie, false → w katalogu roboczym.
#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    let path = repo_root(&path)?;
    let mut args = vec!["diff"];
    if staged { args.push("--staged"); }
    args.push("--");
    args.push(&file);
    let out = git(&path, &args)?;
    if out.trim().is_empty() && !staged {
        // nowy nieśledzony plik: pokaż jego treść jako „dodane”
        let full = Path::new(&path).join(&file);
        if let Ok(c) = std::fs::read_to_string(&full) {
            return Ok(c.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_stage(path: String, file: String, stage: bool) -> Result<(), String> {
    let path = repo_root(&path)?;
    if stage {
        git(&path, &["add", "--", &file])?;
    } else {
        // wyjmij z indeksu, działa też gdy nie ma jeszcze żadnego commita
        let _ = git_raw(&path, &["reset", "-q", "HEAD", "--", &file])?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stage_all(path: String, stage: bool) -> Result<(), String> {
    if stage { git(&path, &["add", "-A"])?; } else { let _ = git_raw(&path, &["reset", "-q"])?; }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("pusta wiadomość commita".into());
    }
    git(&path, &["commit", "-m", &message])
}

#[tauri::command]
pub async fn git_sync(path: String, action: String) -> Result<String, String> {
    let args: &[&str] = match action.as_str() {
        "pull" => &["pull", "--ff-only"],
        "push" => &["push"],
        "fetch" => &["fetch", "--all"],
        _ => return Err(format!("nieznana akcja: {action}")),
    };
    let (out, ok, err) = git_raw(&path, args)?;
    if ok { Ok(if out.trim().is_empty() { err } else { out }) } else { Err(err) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    name: String,
    current: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<Branch>, String> {
    // format: aktualny|nazwa|upstream|ahead behind
    let fmt = "%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track,nobracket)";
    let out = git(&path, &["branch", "--format", fmt])?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.splitn(4, '|').collect();
        if f.len() < 4 { continue; }
        let mut ahead = 0;
        let mut behind = 0;
        for seg in f[3].split(", ") {
            if let Some(n) = seg.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0); }
            if let Some(n) = seg.strip_prefix("behind ") { behind = n.parse().unwrap_or(0); }
        }
        branches.push(Branch {
            current: f[0] == "*",
            name: f[1].to_string(),
            upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
            ahead, behind,
        });
    }
    Ok(branches)
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<String, String> {
    let (out, ok, err) = git_raw(&path, &["checkout", &branch])?;
    if ok { Ok(if err.is_empty() { out } else { err }) } else { Err(err) }
}

// ---------- historia (graf branchy) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    date: String,      // względna, np. "3 godziny temu" / "3 hours ago"
    subject: String,
    refs: Vec<String>, // np. "HEAD -> main", "origin/main", "tag: v1.0"
}

/// Ostatnie commity ze wszystkich branchy w kolejności topologicznej (do rysowania grafu).
#[tauri::command]
pub async fn git_log(path: String, limit: u32) -> Result<Vec<Commit>, String> {
    // pola rozdzielone \x1f, rekordy \x1e — bezpieczne dla dowolnych wiadomości commitów
    let n = format!("-n{}", limit.clamp(10, 2000));
    let out = match git_raw(&path, &["log", "--all", "--topo-order", &n, "--format=%H%x1f%P%x1f%an%x1f%ar%x1f%s%x1f%D%x1e"])? {
        (out, true, _) => out,
        (_, false, err) if err.contains("does not have any commits") => return Ok(vec![]),
        (_, false, err) => return Err(err),
    };
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 6 || f[0].is_empty() {
                return None;
            }
            Some(Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                date: f[3].to_string(),
                subject: f[4].to_string(),
                refs: f[5].split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
            })
        })
        .collect())
}

/// Szczegóły commita: pełna wiadomość i lista zmienionych plików ze statystyką.
#[tauri::command]
pub async fn git_show(path: String, hash: String) -> Result<String, String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("niepoprawny hash".into());
    }
    git(&path, &["show", "--stat", "--format=%H%n%an <%ae>%n%ad%n%n%B", "--date=format:%Y-%m-%d %H:%M", &hash])
}
