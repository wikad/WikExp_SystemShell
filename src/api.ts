import { invoke } from "@tauri-apps/api/core";

export type FileEntry = {
    name : string;
    path : string;
    isDir : boolean;
    size: number;
    modified: number | null;
}

//path  = paramentr w rustcie
export const readDir = (path:string) => invoke<FileEntry[]>("read_dir", {path});


export function formatSize(b: number){
    if(b<1024) return '${b} B';
    if(b< 1024 ** 2) return '${(b / 1024).toFixed(1)} KB';
    if(b<1024 ** 3) return '${(b/1024 **2).toFixed(1)} MB';
    return '${(b/1024 **3).toFixed(1)} GB';
}

export const parentDir = (path:string) => invoke<string | null>("parent_dir",{path});