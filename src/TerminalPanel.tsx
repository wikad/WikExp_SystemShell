import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { ptyKill, ptySpawn, ptyWrite, ptyResize } from "./api";
import { fontStack, useSettings, xtermTheme } from "./settings";

// sessionId = id panelu; każdy panel terminala ma własny shell w Ruście
export function TerminalPanel({ sessionId, active }: { sessionId: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // term w ref, żeby efekt fokusu (niżej) miał do niego dostęp
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { settings, palette } = useSettings();
  const cfgRef = useRef({ settings, palette });
  cfgRef.current = { settings, palette };

  // 1) tworzenie terminala + połączenie z PTY w Ruście (raz)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const cfg = cfgRef.current;
    const term = new Terminal({
      fontFamily: fontStack(cfg.settings.font),
      fontSize: cfg.settings.fontSize,
      cursorBlink: cfg.settings.cursorBlink,
      cursorStyle: cfg.settings.cursorStyle,
      scrollback: cfg.settings.scrollback,
      theme: xtermTheme(cfg.palette),
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
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
      ptySpawn(sessionId, term.cols, term.rows, cfgRef.current.settings.shell).catch((e) =>
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

  // zmiana ustawień → od razu w działającym terminalu
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(palette);
    term.options.fontFamily = fontStack(settings.font);
    term.options.fontSize = settings.fontSize;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.scrollback = settings.scrollback;
    fitRef.current?.fit();   // inny rozmiar fontu = inna liczba kolumn i wierszy
  }, [palette, settings.font, settings.fontSize, settings.cursorStyle, settings.cursorBlink, settings.scrollback]);

  // 2) fokus: aktywny panel = kursor w terminalu
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) term.focus(); else term.blur();
  }, [active]);

  return <div ref={containerRef} className="term-container" />;
}
