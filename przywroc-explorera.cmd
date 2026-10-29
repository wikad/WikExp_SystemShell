@echo off
rem Awaryjnie: przywraca explorer.exe jako powloke i uruchamia go od razu.
rem Usuwa wpis Shell z HKCU, wiec po nastepnym zalogowaniu wraca explorer.exe z ustawien systemu.
rem Gdy WikExp jako powloka nie dziala: Ctrl+Shift+Esc (Menedzer zadan), Uruchom nowe zadanie, cmd,
rem a w cmd wpisz sciezke do tego pliku.
reg delete "HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell /f >nul 2>&1
start "" explorer.exe
echo Gotowe: wpis powloki usuniety, explorer.exe uruchomiony.
pause
