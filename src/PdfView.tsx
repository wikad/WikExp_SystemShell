import { useEffect, useState } from "react";
import { readFileBytes } from "./api";

/** Podgląd PDF w panelu: bajty z Rusta → Blob → wbudowana przeglądarka PDF webview (iframe). */
export function PdfView({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    readFileBytes(path)
      .then((buf) => {
        if (cancelled) return;
        revoke = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
        setUrl(revoke);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [path]);

  if (error) return <div className="row red">{error}</div>;
  if (!url) return <div className="row muted">ładowanie PDF…</div>;
  return <iframe className="pdf-frame" src={url} title={path} />;
}
