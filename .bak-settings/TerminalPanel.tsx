import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { ptyKill, ptySpawn, ptyWrite, ptyResize } from "./api";

// sessionId = id panelu; każdy panel terminala ma własny shell w Ruście
export function TerminalPanel({ sessionId, active }: { sessionId: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // term w ref, żeby efekt fokusu (niżej) miał do niego dostęp
  const termRef = useRef<Terminal | null>(null);

  // 1) tworzenie terminala + połączenie z PTY w Ruście (raz)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#cba6f7",
        selectionBackground: "#45475a",
        black: "#45475a",   brightBlack: "#585b70",
        red: "#f38ba8",     brightRed: "#f38ba8",
        green: "#a6e3a1",   brightGreen: "#a6e3a1",
        yellow: "#f9e2af",  brightYellow: "#f9e2af",
        blue: "#89b4fa",    brightBlue: "#89b4fa",
        magenta: "#f5c2e7", brightMagenta: "#f5c2e7",
        cyan: "#94e2d5",    brightCyan: "#94e2d5",
        white: "#bac2de",   brightWhite: "#a6adc8",
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    // skróty WikExp nie mogą trafić do shella
    term.attachCustomKeyEventHandler((e) => {
      if (e.altKey && !e.ctrlKey && ["KeyH", "KeyJ", "KeyK", "KeyL"].includes(e.code)) return false;
      if (e.ctrlKey && !e.altKey && e.code === "KeyQ") return false;
      if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.shiftKey) return false; // zamyka panel (App)
      return true;
    });

    let disposed = false;
    let exited = false;
    let unlisteners: Array<() => void> = [];

    const spawn = () =>
      ptySpawn(sessionId, term.cols, term.rows).catch((e) =>
        term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`));

    // wejście: każdy klawisz prosto do shella; po zakończeniu shella Enter startuje nowy
    const onData = term.onData((d) => {
      if (exited) {
        if (d === "\r") { exited = false; term.reset(); spawn(); }
        return;
      }
      ptyWrite(sessionId, d).catch(() => {});
    });
    const onResize = term.onResize(({ cols, rows }) => { ptyResize(sessionId, cols, rows).catch(() => {}); });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    (async () => {
      // jeden wspólny event dla wszystkich terminali, filtrujemy po id
      const un1 = await listen<{ id: string; data: number[] }>("pty-output", (e) => {
        if (e.payload.id === sessionId) term.write(new Uint8Array(e.payload.data));
      });
      const un2 = await listen<{ id: string }>("pty-exit", (e) => {
        if (e.payload.id !== sessionId || disposed) return;
        exited = true;
        term.write("\r\n\x1b[90m[proces zakończony, Enter = nowy shell]\x1b[0m\r\n");
      });
      // StrictMode: pierwsze zamontowanie zostaje odmontowane, zanim tu dojdzie
      if (disposed) { un1(); un2(); return; }
      unlisteners = [un1, un2];
      await spawn();
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      term.dispose();
      termRef.current = null;
      ptyKill(sessionId).catch(() => {});   // zamknięty panel = zabity shell
    };
  }, [sessionId]);

  // 2) fokus: aktywny panel = kursor w terminalu
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) term.focus(); else term.blur();
  }, [active]);

  return <div ref={containerRef} className="term-container" />;
}
