import { useEffect, useState, type ReactNode } from "react";
import ErrorBoundary from "./ErrorBoundary";
import { hasRootSave, runRootSave } from "./rootSave";
import { RAMP } from "./theme/theme";
import { btnBase } from "./ribbon/tokens";

/** Full-window fallback for a throw in `App` itself (everything inside it has its own smaller
 *  boundary). The world and undo stack live in Rust and are still alive, so this keeps Save
 *  reachable (button and ⌘S / Ctrl+S) before Retry remounts a fresh `App`. */
export function RootFallback({ error, retry }: { error: Error; retry: () => void }) {
  const canSave = hasRootSave();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const save = async () => {
    if (!canSave || status === "saving") return;
    setStatus("saving");
    try { setStatus((await runRootSave()) ? "saved" : "failed"); } catch { setStatus("failed"); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div role="alert" style={{
      position: "fixed", inset: 0, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 10, padding: 24, boxSizing: "border-box", textAlign: "center",
      background: RAMP.mapBg, color: RAMP.dim,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: RAMP.textDanger }}>Something went wrong</div>
      <div style={{ fontSize: 11, color: RAMP.meta, maxWidth: 420, wordBreak: "break-word" }}>
        {error.message || String(error)}
      </div>
      <div style={{ fontSize: 11, color: RAMP.meta, maxWidth: 420 }}>
        {canSave
          ? "Your world and its undo history are still in memory. Save now (Ctrl/⌘+S) before retrying."
          : "No world was open, so there is nothing to save."}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {canSave && (
          <button type="button" className="rbn-btn" onClick={() => void save()} disabled={status === "saving"}
            style={btnBase({ padding: "0 14px", height: 26 })}>
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "failed" ? "Save failed, retry" : "Save"}
          </button>
        )}
        <button type="button" className="rbn-btn" onClick={retry}
          style={btnBase({ padding: "0 14px", height: 26 })}>Reload editor</button>
      </div>
    </div>
  );
}

export default function RootErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary label="Editor" fallback={(error, retry) => <RootFallback error={error} retry={retry} />}>
      {children}
    </ErrorBoundary>
  );
}
