@echo off
rem Przywraca pasek zadan Windows i zwalnia miejsce po pasku WikExp
rem (gdy WikExp zostal zabity bez sprzatania, np. Ctrl+C w "npm run tauri dev").
taskkill /f /im explorer.exe >nul 2>&1
start explorer.exe
