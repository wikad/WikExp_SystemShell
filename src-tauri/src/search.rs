//! Szukanie tekstu w całym folderze projektu (Ctrl+Shift+F).
//! Przechodzenie po plikach: crate `ignore` (ten sam co w ripgrepie), więc
//! pomija to, co jest w `.gitignore`, ukryte pliki i typowe śmietniki (node_modules, target).
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

/// Numer bieżącego wyszukiwania. Każde nowe zapytanie go zwiększa, a stare,
/// które jeszcze trwają, widzą zmianę i przerywają pracę (nie liczą na marne).
static GENERATION: AtomicU64 = AtomicU64::new(0);

const MAX_FILE: u64 = 2 * 1024 * 1024; // większych plików nie przeszukujemy
const MAX_TOTAL: usize = 2000;         // limit trafień w sumie
const MAX_PER_FILE: usize = 200;       // limit trafień w jednym pliku
const PREVIEW: usize = 200;            // ile znaków linii pokazać w wynikach

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    line: u32,     // numer linii, od 1
    col: u32,      // kolumna początku trafienia w linii (jednostki UTF-16, jak w JS/CodeMirror)
    len: u32,      // długość trafienia (UTF-16)
    text: String,  // podgląd linii (bez wcięcia, przycięty)
    hl: u32,       // początek trafienia w `text` (UTF-16)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHits {
    path: String, // ścieżka pełna
    rel: String,  // ścieżka względem folderu, w którym szukamy
    hits: Vec<Hit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    files: Vec<FileHits>,
    total: usize,
    scanned: usize,   // ile plików przejrzano
    truncated: bool,  // true = doszliśmy do limitu, wyników jest więcej
    cancelled: bool,  // true = w międzyczasie przyszło nowsze zapytanie
}

/// Długość tekstu w jednostkach UTF-16 (tak liczy JavaScript i CodeMirror).
fn u16len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Podgląd linii: bez wcięcia, przycięty tak, żeby trafienie było widać.
/// `start` to bajt początku trafienia w `line`. Zwraca (tekst, początek trafienia w tekście).
fn preview(line: &str, start: usize) -> (String, u32) {
    let trimmed = line.trim_start();
    let off = line.len() - trimmed.len();
    let s = start.saturating_sub(off);
    // za długa linia: zacznij ~40 znaków przed trafieniem
    let mut from = 0;
    if trimmed[..s].chars().count() > 40 {
        from = trimmed[..s].char_indices().rev().nth(39).map(|(i, _)| i).unwrap_or(0);
    }
    let mut text: String = trimmed[from..].chars().take(PREVIEW).collect();
    if from > 0 { text.insert(0, '…'); }
    let hl = u16len(&trimmed[from..s]) + if from > 0 { 1 } else { 0 };
    (text, hl)
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResult, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if query.is_empty() {
        return Ok(SearchResult { files: vec![], total: 0, scanned: 0, truncated: false, cancelled: false });
    }
    // zwykły tekst zamieniamy na regex z „uciekniętymi” znakami specjalnymi
    let mut pattern = if regex { query.clone() } else { regex::escape(&query) };
    if whole_word { pattern = format!(r"\b(?:{pattern})\b"); }
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("zły regex: {e}"))?;

    // przeszukiwanie dysku blokuje wątek, więc idzie do puli wątków „blokujących”,
    // żeby nie zatrzymać reszty komend Tauri
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = std::path::Path::new(&root);
        let mut res = SearchResult { files: vec![], total: 0, scanned: 0, truncated: false, cancelled: false };
        let walker = WalkBuilder::new(&root)
            .hidden(true)        // pomijaj ukryte (.git, .vscode…)
            .git_ignore(true)
            .require_git(false)  // .gitignore działa też poza repozytorium
            .filter_entry(|e| {
                let n = e.file_name().to_string_lossy();
                !matches!(n.as_ref(), "node_modules" | "target" | ".git" | "dist")
            })
            .build();

        for entry in walker {
            if GENERATION.load(Ordering::SeqCst) != generation {
                res.cancelled = true;
                return res;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
            if entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(true) { continue; }
            let Ok(bytes) = std::fs::read(entry.path()) else { continue };
            res.scanned += 1;
            // plik binarny (bajt zerowy na początku) pomijamy
            if bytes[..bytes.len().min(8000)].contains(&0) { continue; }
            let content = String::from_utf8_lossy(&bytes);

            let mut hits = Vec::new();
            // lines() obsługuje i \n, i \r\n (pliki z Windowsa)
            for (i, line) in content.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.start() == m.end() { continue; } // puste dopasowanie (np. regex "a*")
                    let (text, hl) = preview(line, m.start());
                    hits.push(Hit {
                        line: i as u32 + 1,
                        col: u16len(&line[..m.start()]),
                        len: u16len(m.as_str()),
                        text,
                        hl,
                    });
                    if hits.len() >= MAX_PER_FILE { break; }
                }
                if hits.len() >= MAX_PER_FILE { res.truncated = true; break; }
            }
            if hits.is_empty() { continue; }

            res.total += hits.len();
            let path = entry.path().to_string_lossy().into_owned();
            let rel = entry.path().strip_prefix(root_path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.clone());
            res.files.push(FileHits { path, rel, hits });
            if res.total >= MAX_TOTAL { res.truncated = true; break; }
        }
        // stała kolejność: alfabetycznie po ścieżce
        res.files.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        res
    })
    .await
    .map_err(|e| format!("wyszukiwanie przerwane: {e}"))
}
