import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Bar } from "./Bar";
import { Launcher } from "./Launcher";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SettingsProvider } from "./settings";

const label = getCurrentWindow().label;
const isBar = label === "bar";
const isLauncher = label === "launcher";
if (isBar) document.body.classList.add("is-bar");
if (isLauncher) document.body.classList.add("is-launcher");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      {/* to samo index.html ładują oba okna: "bar" dostaje pasek boczny, "main" resztę */}
      {isBar ? <Bar /> : isLauncher ? <Launcher /> : <App />}
    </SettingsProvider>
  </React.StrictMode>,
);
