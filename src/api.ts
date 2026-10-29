import { invoke } from "@tauri-apps/api/core";

export type FileEntry = {
    name : string;
    path : string;
    isDir : boolean;
    size: number;
    modified: number | null;
    hidden: boolean;
}

//path  = paramentr w rustcie
export const readDir = (path:string) => invoke<FileEntry[]>("read_dir", {path});


export function formatSize(b: number){
    if(b<1024) return `${b} B`;
    if(b< 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if(b<1024 ** 3) return `${(b/1024 **2).toFixed(1)} MB`;
    return `${(b/1024 **3).toFixed(1)} GB`;
}

export const parentDir = (path:string) => invoke<string | null>("parent_dir",{path});

export const ptySpawn = (id: string, cols: number, rows: number, shell: string, cwd: string | null = null) => invoke<void>("pty_spawn", { id, cols, rows, shell, cwd });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
export type ProcGroup = { name: string; pids: number[]; cpu: number; memory: number };
// źródło danych panelu: "win" (Windows), "wsl" (domyślna dystrybucja) albo "wsl:Nazwa"
export type Source = string;
export const listProcesses = (backend: Source = "win") => invoke<ProcGroup[]>("list_processes", { backend });
export const killProcesses = (pids: number[], backend: Source = "win") => invoke<number>("kill_processes", { pids, backend });

export type Container = { id: string; name: string; image: string; state: string; status: string; ports: string };
export type DockerAction = "start" | "stop" | "restart" | "rm";
export const dockerList = (backend: Source = "win") => invoke<Container[]>("docker_list", { backend });
export const dockerAction = (id: string, action: DockerAction, backend: Source = "win") => invoke<void>("docker_action", { id, action, backend });

export type Distro = { name: string; running: boolean; version: number; isDefault: boolean };
export type WslInfo = { distros: Distro[]; vmmem: number };
export const wslList = () => invoke<WslInfo>("wsl_list");
export const wslAction = (distro: string, action: "terminate" | "default" | "shutdown") => invoke<void>("wsl_action", { distro, action });

export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
export const writeTextFile = (path: string, content: string) => invoke<void>("write_text_file", { path, content });

export type GpuInfo = { name: string; util: number; vramUsed: number; vramTotal: number | null; temp: number | null };
export type Stats = {
  cpuName: string; cpuTotal: number; cpus: number[];
  memUsed: number; memTotal: number; swapUsed: number; swapTotal: number;
  netRx: number; netTx: number;
  disks: { mount: string; used: number; total: number }[];
  uptime: number;
  gpu: GpuInfo | null;
};
export const systemStats = () => invoke<Stats>("system_stats");

// ---------- powłoka: pasek boczny ----------
export type WinInfo = { hwnd: number; title: string; exe: string; icon: string | null; active: boolean; minimized: boolean };
export const listWindows = () => invoke<WinInfo[]>("list_windows");
export const windowAction = (hwnd: number, action: "focus" | "minimize" | "close") => invoke<void>("window_action", { hwnd, action });
export const showMain = () => invoke<void>("show_main");
export const setDesktopLayer = (enabled: boolean) => invoke<void>("set_desktop_layer", { enabled });
export const applyShellLayout = (hideTaskbar: boolean) => invoke<void>("apply_shell_layout", { hideTaskbar });

export type Battery = { percent: number; charging: boolean; plugged: boolean; secondsLeft: number | null; saver: boolean };
export const batteryStatus = () => invoke<Battery | null>("battery_status");
export type DockInfo = { alive: boolean; visible: boolean; minimized: boolean; maximized: boolean; w: number; h: number };
export const dockWindow = (hwnd: number, x: number, y: number, w: number, h: number) => invoke<DockInfo>("dock_window", { hwnd, x, y, w, h });
export const undockWindow = (hwnd: number) => invoke<void>("undock_window", { hwnd });
export const focusMain = () => invoke<void>("focus_main");
export const styleDocked = (hwnd: number, border: string, caption: string, text: string, dark: boolean) =>
  invoke<void>("style_docked", { hwnd, border, caption, text, dark });

// ---------- launcher ----------
export type AppEntry = { name: string; target: string };
export const listApps = (refresh = false) => invoke<AppEntry[]>("list_apps", { refresh });
export const appIcons = (targets: string[]) => invoke<(string | null)[]>("app_icons", { targets });
export const logWrite = (level: "info" | "warn" | "error", msg: string) => invoke<void>("log_write", { level, msg });
export const getLogPath = () => invoke<string | null>("get_log_path");
export type ShellStatus = { enabled: boolean; value: string | null; exe: string; dev: boolean };
export type AutostartEntry = { source: string; name: string; command: string; enabled: boolean; folder: boolean };
export const autostartList = () => invoke<AutostartEntry[]>("autostart_list");
export type PowerAction = "lock" | "logoff" | "sleep" | "restart" | "shutdown";
export const powerAction = (action: PowerAction) => invoke<void>("power_action", { action });
export const shellStatus = () => invoke<ShellStatus>("shell_status");
export const shellSet = (enabled: boolean) => invoke<void>("shell_set", { enabled });
export const emergencyExplorer = () => invoke<void>("emergency_explorer");
export const readFileBytes = (path: string) => invoke<ArrayBuffer>("read_file_bytes", { path });
export const openPath = (path: string, withDialog = false) => invoke<void>("open_path", { path, withDialog });
export const launchApp = (target: string) => invoke<void>("launch_app", { target });
export const toggleLauncher = () => invoke<void>("toggle_launcher");
export const hideLauncher = () => invoke<void>("hide_launcher");
export const toggleFlyout = () => invoke<void>("toggle_flyout");
export const hideFlyout = () => invoke<void>("hide_flyout");

// ---------- git ----------
export type GitFile = { path: string; status: string; staged: boolean; unstaged: boolean };
export type GitStatus = {
  isRepo: boolean; root: string; branch: string; upstream: string | null;
  ahead: number; behind: number; files: GitFile[]; fileMap: Record<string, string>;
};
export type GitBranch = { name: string; current: boolean; upstream: string | null; ahead: number; behind: number };
export const gitStatus = (path: string) => invoke<GitStatus>("git_status", { path });
export const gitDiff = (path: string, file: string, staged: boolean) => invoke<string>("git_diff", { path, file, staged });
export const gitStage = (path: string, file: string, stage: boolean) => invoke<void>("git_stage", { path, file, stage });
export const gitStageAll = (path: string, stage: boolean) => invoke<void>("git_stage_all", { path, stage });
export const gitCommit = (path: string, message: string) => invoke<string>("git_commit", { path, message });
export const gitSync = (path: string, action: "pull" | "push" | "fetch") => invoke<string>("git_sync", { path, action });
export const gitBranches = (path: string) => invoke<GitBranch[]>("git_branches", { path });
export const gitCheckout = (path: string, branch: string) => invoke<string>("git_checkout", { path, branch });
export type GitCommit = { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string[] };
export const gitLog = (path: string, limit: number) => invoke<GitCommit[]>("git_log", { path, limit });
export const gitShow = (path: string, hash: string) => invoke<string>("git_show", { path, hash });

// ---------- szukanie w projekcie ----------
export type SearchHit = { line: number; col: number; len: number; text: string; hl: number };
export type SearchFile = { path: string; rel: string; hits: SearchHit[] };
export type SearchResult = { files: SearchFile[]; total: number; scanned: number; truncated: boolean; cancelled: boolean };
export const searchFiles = (root: string, query: string, caseSensitive: boolean, wholeWord: boolean, regex: boolean) =>
  invoke<SearchResult>("search_files", { root, query, caseSensitive, wholeWord, regex });
