@echo off
rem Double-click to run Yonder. Builds the web app on first use, starts the server on port 3000
rem and opens it in your browser. Close this window to stop the server.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist dist\index.html (
  echo Building the web app...
  call npm run build
)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
npm start
