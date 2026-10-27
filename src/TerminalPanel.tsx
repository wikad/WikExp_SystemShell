import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // TODO 1: utwórz new Terminal({ ... }) z fontFamily, fontSize, theme
    //         (theme: background, foreground, cursor: kolory z instrukcji)
    // TODO 2: utwórz FitAddon i term.loadAddon(...)
    // TODO 3: term.open(el)
    // TODO 4: fit.fit()
    // TODO 5: term.write("hello")

    return () => {
      // TODO 6: term.dispose()


      //zeby dzialalo
    <div className="row"><span className="accent">PS C:\devWikExp\WikExp&gt;</span> _</div>
    };
  }, []);

  return <div ref={containerRef} className="term-container" />;
}