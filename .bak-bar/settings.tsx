import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// ---------- motywy ----------
export type Palette = {
  name: string; light?: boolean;
  crust: string; mantle: string; base: string; surface: string; overlay: string;
  text: string; muted: string; accent: string;
  blue: string; green: string; yellow: string; red: string; cyan: string; pink: string; orange: string;
};

export const THEMES: Record<string, Palette> = {
  mocha: { name: "Catppuccin Mocha", crust: "#11111b", mantle: "#181825", base: "#1e1e2e", surface: "#313244", overlay: "#45475a",
    text: "#cdd6f4", muted: "#6c7086", accent: "#cba6f7", blue: "#89b4fa", green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8", cyan: "#94e2d5", pink: "#f5c2e7", orange: "#fab387" },
  macchiato: { name: "Catppuccin Macchiato", crust: "#181926", mantle: "#1e2030", base: "#24273a", surface: "#363a4f", overlay: "#494d64",
    text: "#cad3f5", muted: "#6e738d", accent: "#c6a0f6", blue: "#8aadf4", green: "#a6da95", yellow: "#eed49f", red: "#ed8796", cyan: "#8bd5ca", pink: "#f5bde6", orange: "#f5a97f" },
  latte: { name: "Catppuccin Latte (jasny)", light: true, crust: "#dce0e8", mantle: "#e6e9ef", base: "#eff1f5", surface: "#ccd0da", overlay: "#bcc0cc",
    text: "#4c4f69", muted: "#8c8fa1", accent: "#8839ef", blue: "#1e66f5", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39", cyan: "#179299", pink: "#ea76cb", orange: "#fe640b" },
  tokyo: { name: "Tokyo Night", crust: "#13131a", mantle: "#16161e", base: "#1a1b26", surface: "#292e42", overlay: "#3b4261",
    text: "#c0caf5", muted: "#565f89", accent: "#bb9af7", blue: "#7aa2f7", green: "#9ece6a", yellow: "#e0af68", red: "#f7768e", cyan: "#7dcfff", pink: "#ff75a0", orange: "#ff9e64" },
  gruvbox: { name: "Gruvbox Dark", crust: "#141617", mantle: "#1d2021", base: "#282828", surface: "#3c3836", overlay: "#504945",
    text: "#ebdbb2", muted: "#928374", accent: "#fe8019", blue: "#83a598", green: "#b8bb26", yellow: "#fabd2f", red: "#fb4934", cyan: "#8ec07c", pink: "#d3869b", orange: "#fe8019" },
  nord: { name: "Nord", crust: "#242933", mantle: "#292e39", base: "#2e3440", surface: "#3b4252", overlay: "#4c566a",
    text: "#eceff4", muted: "#7b88a1", accent: "#88c0d0", blue: "#81a1c1", green: "#a3be8c", yellow: "#ebcb8b", red: "#bf616a", cyan: "#8fbcbb", pink: "#b48ead", orange: "#d08770" },
  halloween: { name: "Halloween 🎃", crust: "#070b16", mantle: "#0c1222", base: "#10182c", surface: "#1b2742", overlay: "#2b3a5e",
    text: "#f1e9dc", muted: "#6f7ea3", accent: "#ff7a18", blue: "#5b8cff", green: "#a3e635", yellow: "#ffc145", red: "#ff4d5e", cyan: "#4fd1c5", pink: "#c084fc", orange: "#ff9a3c" },
  dracula: { name: "Dracula", crust: "#191a21", mantle: "#21222c", base: "#282a36", surface: "#343746", overlay: "#44475a",
    text: "#f8f8f2", muted: "#6272a4", accent: "#bd93f9", blue: "#a4b8ff", green: "#50fa7b", yellow: "#f1fa8c", red: "#ff5555", cyan: "#8be9fd", pink: "#ff79c6", orange: "#ffb86c" },
};

/** Kolory xterm (16 kolorów ANSI) z palety motywu. */
export function xtermTheme(p: Palette) {
  return {
    background: p.base, foreground: p.text, cursor: p.accent, cursorAccent: p.base, selectionBackground: p.overlay,
    black: p.light ? p.muted : p.overlay, brightBlack: p.muted,
    red: p.red, brightRed: p.red, green: p.green, brightGreen: p.green,
    yellow: p.yellow, brightYellow: p.yellow, blue: p.blue, brightBlue: p.blue,
    magenta: p.pink, brightMagenta: p.pink, cyan: p.cyan, brightCyan: p.cyan,
    white: p.light ? p.text : p.text, brightWhite: p.light ? p.crust : "#ffffff",
  };
}

// ---------- ustawienia ----------
export const FONTS = ['"JetBrains Mono"', '"Cascadia Mono"', '"Fira Code"', "Consolas"];
export const SHELLS = ["powershell.exe", "pwsh.exe", "cmd.exe"];

export type Settings = {
  theme: string;
  font: string;
  fontSize: number;
  gap: number;
  radius: number;
  shell: string;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  showHidden: boolean;
  monitorRefresh: number; // ms
};

export const DEFAULTS: Settings = {
  theme: "mocha", font: FONTS[0], fontSize: 13, gap: 8, radius: 6,
  shell: "powershell.exe", cursorStyle: "bar", cursorBlink: true, scrollback: 5000,
  showHidden: false, monitorRefresh: 1000,
};

const KEY = "wikexp.settings.v1";
function load(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

export const fontStack = (f: string) => `${f}, "Cascadia Mono", Consolas, monospace`;

type Ctx = {
  settings: Settings;
  palette: Palette;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  reset: () => void;
};
const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  const palette = THEMES[settings.theme] ?? THEMES.mocha;

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignoruj */ }
  }, [settings]);

  // motyw i wygląd → zmienne CSS na :root, z których korzysta cały App.css
  useEffect(() => {
    const st = document.documentElement.style;
    for (const k of ["crust", "mantle", "base", "surface", "overlay", "text", "muted", "accent",
      "blue", "green", "yellow", "red", "cyan", "pink", "orange"] as const) st.setProperty(`--${k}`, palette[k]);
    st.setProperty("--font", fontStack(settings.font));
    st.setProperty("--font-size", `${settings.fontSize}px`);
    st.setProperty("--gap", `${settings.gap}px`);
    st.setProperty("--radius", `${settings.radius}px`);
    st.colorScheme = palette.light ? "light" : "dark";
  }, [palette, settings.font, settings.fontSize, settings.gap, settings.radius]);

  const set: Ctx["set"] = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const reset = () => setSettings(DEFAULTS);
  return <SettingsContext.Provider value={{ settings, palette, set, reset }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings poza SettingsProvider");
  return c;
}
