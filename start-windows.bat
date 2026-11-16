@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
rem Open the charts in their own app window (no tabs or address bar). Chrome and Edge remember the
rem size and position of that window for next time. Set APPWINDOW=0 to open a normal browser tab instead.
set APPWINDOW=1
set URL=http://localhost:8787
set BROWSER=
rem If you installed the charts as an app (browser menu -> Install), open that instead, 2 seconds after the server starts.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Chrome Apps\Charts.lnk"
if not exist "%LNK%" set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Charts.lnk"
if exist "%LNK%" goto installed
if not "%APPWINDOW%"=="1" goto open
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
:open
if defined BROWSER (start "" "%BROWSER%" --app=%URL%) else start "" %URL%
goto server
:installed
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process -FilePath $env:LNK"
:server
node server.js
pause
