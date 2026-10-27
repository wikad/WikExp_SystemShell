# SYSTEM SHELL 
my own take on system shell that would be the best for programing and using staff corelated with it as docker cubernetes and other

# Stage 
* mockup look and style DONE
* TODO : read_dir(path)



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
git clone <adres-repo> C:\dev\WikExp
cd C:\dev\WikExp
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