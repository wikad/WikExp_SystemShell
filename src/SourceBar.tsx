import { useEffect, useState } from "react";
import { wslList, type Distro, type Source } from "./api";

/**
 * Pasek wyboru źródła w panelu (Windows albo dystrybucja WSL). Klik w chip albo klawisz `w`
 * (kolejne źródło). Lista dystrybucji pobierana raz przy otwarciu panelu i po każdym `w`.
 */
export function SourceBar({ source, onSource, active }: { source: Source; onSource: (s: Source) => void; active: boolean }) {
  const [distros, setDistros] = useState<Distro[] | null>(null);
  // docker-desktop to ukryta dystrybucja silnika Dockera: nie ma w niej shella ani klienta docker, więc nie jest źródłem
  const load = () => wslList()
    .then((i) => setDistros(i.distros.filter((d) => !d.name.startsWith("docker-desktop"))))
    .catch(() => setDistros([]));
  useEffect(() => { load(); }, []);

  // zapamiętany wybór ukrytej dystrybucji (z czasów, gdy chip był widoczny) → wróć na Windows
  useEffect(() => {
    if (source.startsWith("wsl:docker-desktop")) onSource("win");
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // "wsl" (bez nazwy) = domyślna dystrybucja; pokazujemy ją jako zaznaczoną po nazwie
  const def = distros?.find((d) => d.isDefault)?.name;
  const current = source === "wsl" && def ? `wsl:${def}` : source;
  const options: { id: Source; label: string }[] = [
    { id: "win", label: "Windows" },
    ...(distros ?? []).map((d) => ({ id: `wsl:${d.name}`, label: d.name })),
  ];

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.key !== "w") return;
      e.preventDefault();
      const i = options.findIndex((o) => o.id === current);
      onSource(options[(i + 1) % options.length].id);
      load();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, current, options.map((o) => o.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="src-bar">
      <span className="muted">źródło (w):</span>
      {options.map((o) => (
        <span key={o.id} className={`src-chip ${o.id === current ? "on" : ""}`} onClick={() => onSource(o.id)}>
          {o.label}
        </span>
      ))}
    </div>
  );
}
