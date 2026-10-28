# WikExp: System Shell

WikExp to mój własny pulpit dla Windows, zbudowany pod programowanie. Działa w stylu terminala (TUI) i docelowo ma zastąpić `explorer.exe`. Pliki, edytor, terminal, git, procesy, Docker i monitor systemu są panelami na jednej siatce, którą układasz po swojemu i obsługujesz głównie klawiaturą (skróty w stylu vima). Backend jest w Ruście (Tauri 2), interfejs w React + TypeScript.

![WikExp](docs/screenshot.png)

## Funkcje

- **Układ paneli** na siatce 24×16: przeciąganie, zmiana rozmiaru, dzielenie, wiele instancji tego samego panelu; układ zapisuje się sam. Przełączanie paneli: `Alt+h/j/k/l`.
- **Pliki i drzewo**: nawigacja `h/j/k/l`, historia `H/L`, ukryte pliki (atrybuty Windows), podświetlanie otwartych plików.
- **Edytor** (CodeMirror 6): kolorowanie składni, `Ctrl+S` / `Ctrl+W`, zachowanie końców linii CRLF, `Ctrl+F` szukaj i zamień w pliku.
- **Szukanie w projekcie** (`Ctrl+Shift+F`): całe repozytorium z pominięciem `.gitignore`, regex, całe słowa, wielkość liter; klik w wynik otwiera plik na tej linii.
- **Git**: status, diff, stage, commit, pull/push/fetch, przełączanie branchy, historia z grafem; kolory zmienionych plików w drzewie i liście.
- **Terminal** (xterm.js + ConPTY): osobny shell w każdym panelu.
- **Procesy i Docker**: lista procesów z zabijaniem, kontenery (start/stop/restart/usuń).
- **Monitor** w stylu btop: CPU, RAM, GPU, sieć, dyski.
- **Pasek boczny** zamiast paska zadań: otwarte programy z ikonami, zegar, launcher; programy można wkładać w panele WikExp.
- **Ustawienia**: 8 motywów (Catppuccin, Tokyo Night, Gruvbox, Nord, Dracula…), font, odstępy, shell terminala.

## Stan prac

- [x] Panele, układ i nawigacja klawiaturą
- [x] `read_dir`, drzewo, edytor plików
- [x] Terminal, procesy, Docker, monitor
- [x] Pasek boczny, okno na pełny ekran, ukrywanie paska zadań Windows
- [x] Git i szukanie w projekcie
- [ ] Warstwa pulpitu, operacje na plikach (kopiuj/wklej/kosz), zasobnik systemowy, autostart
- [ ] Pełna podmiana `explorer.exe` (wpis `Shell` w rejestrze), testy w VM

## Jak odpalić projekt

### Wymagania (jednorazowo, Windows 10/11)

Otwórz PowerShell i wpisz po kolei:

```powershell
# 1. Kompilator C++ i Windows SDK (wymagane przez Rusta)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2. Rust
winget install Rustlang.Rustup

# 3. Node.js LTS
winget install OpenJS.NodeJS.LTS

# 4. Git
winget install Git.Git
```

**Zamknij i otwórz PowerShell ponownie**, potem:

```powershell
# 5. Domyślny toolchain Rusta (MSVC)
rustup default stable-msvc

# 6. Pozwolenie na uruchamianie skryptów npm w PowerShellu
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Sprawdzenie, czy wszystko działa:

```powershell
rustc --version
cargo --version
node --version
npm --version
```

> WebView2 jest wbudowany w Windows 11. Na Windows 10 może być potrzebny: `winget install Microsoft.EdgeWebView2Runtime`.

### Pobranie i uruchomienie

```powershell
git clone https://github.com/wikad/WikExp_SystemShell.git C:\devWikExp\WikExp
cd C:\devWikExp\WikExp
npm install
npm run tauri dev
```

Pierwsza kompilacja trwa kilka minut, kolejne kilka sekund.

### Przydatne komendy

| Komenda | Co robi |
|---|---|
| `npm run tauri dev` | tryb deweloperski z hot-reloadem |
| `npm run tauri build` | build produkcyjny → `src-tauri/target/release/` |
| `npx tsc --noEmit` | sprawdzenie typów TypeScript |
| `Ctrl+Shift+I` (w oknie aplikacji) | DevTools |
| `Ctrl+Q` (w oknie aplikacji) | zamknięcie aplikacji |

### Problemy

- **`npm.ps1 cannot be loaded`**: nie wykonano kroku 6. Alternatywnie użyj `npm.cmd` zamiast `npm`.
- **`linker link.exe not found`**: Build Tools bez workloadu C++. Powtórz krok 1.
- **Bardzo wolna kompilacja**: dodaj w Defenderze wyjątek dla folderu projektu i `%USERPROFILE%\.cargo`.