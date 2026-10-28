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

export const ptySpawn = (id: string, cols: number, rows: number) => invoke<void>("pty_spawn", { id, cols, rows });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
export type ProcGroup = { name: string; pids: number[]; cpu: number; memory: number };
export const listProcesses = () => invoke<ProcGroup[]>("list_processes");
export const killProcesses = (pids: number[]) => invoke<number>("kill_processes", { pids });

export type Container = { id: string; name: string; image: string; state: string; status: string; ports: string };
export type DockerAction = "start" | "stop" | "restart" | "rm";
export const dockerList = () => invoke<Container[]>("docker_list");
export const dockerAction = (id: string, action: DockerAction) => invoke<void>("docker_action", { id, action });

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
