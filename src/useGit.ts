import { useEffect, useState } from "react";
import { gitStatus } from "./api";

export type GitMap = { root: string; branch: string; map: Record<string, string>; ahead: number; behind: number } | null;

/**
 * Status gita dla folderu `cwd`, odświeżany co 4 s. Zwraca mapę ścieżek względem
 * katalogu repozytorium → status, do kolorowania plików i drzewa. null = nie repo.
 */
export function useGit(cwd: string | null): GitMap {
  const [git, setGit] = useState<GitMap>(null);
  useEffect(() => {
    if (!cwd) { setGit(null); return; }
    let alive = true;
    const tick = () => gitStatus(cwd)
      .then((s) => { if (alive) setGit(s.isRepo ? { root: s.root, branch: s.branch, map: s.fileMap, ahead: s.ahead, behind: s.behind } : null); })
      .catch(() => { if (alive) setGit(null); });
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [cwd]);
  return git;
}

/** Status pliku/folderu o ścieżce absolutnej `path` wg mapy gita; "" = brak zmian. */
export function gitStatusOf(git: GitMap, path: string, isDir: boolean): string {
  if (!git) return "";
  // Windows: wielkość liter w ścieżkach nie ma znaczenia (c:\ vs C:\)
  const root = git.root.replace(/\\+$/, "");
  if (path.length <= root.length || path.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return "";
  const rel = path.slice(root.length + 1);
  if (git.map[rel]) return git.map[rel];
  // folder zawierający zmiany w środku
  if (isDir && Object.keys(git.map).some((k) => k.startsWith(rel + "\\"))) return "inside";
  return "";
}
