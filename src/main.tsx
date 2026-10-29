import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Bar } from "./Bar";
import { Launcher } from "./Launcher";
import { Flyout } from "./Flyout";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SettingsProvider } from "./settings";
import { logWrite } from "./api";

const label = getCurrentWindow().label;
const isBar = label === "bar";
const isLauncher = label === "launcher";
const isFlyout = label === "flyout";
// błędy interfejsu trafiają do %APPDATA%\WikExp\log.txt (w wersji release nie ma konsoli)
window.addEventListener("error", (e) => {
  logWrite("error", `[ui:${label}] ${e.message} (${e.filename}:${e.lineno})`).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  logWrite("error", `[ui:${label}] nieobsłużone odrzucenie: ${String(e.reason)}`).catch(() => {});
});
if (isBar) document.body.classList.add("is-bar");
if (isLauncher) document.body.classList.add("is-launcher");
if (isFlyout) document.body.classList.add("is-flyout");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      {/* to samo index.html ładują oba okna: "bar" dostaje pasek boczny, "main" resztę */}
      {isBar ? <Bar /> : isLauncher ? <Launcher /> : isFlyout ? <Flyout /> : <App />}
    </SettingsProvider>
  </React.StrictMode>,
);
