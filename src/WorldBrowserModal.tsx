import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

interface WorldSearchResult {
  id: string;
  name: string;
  timestamp: number;
  file_size: number | null;
}

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

interface Props {
  onClose: () => void;
  onOpenWorld: (path: string) => void;
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  return (n / 1_048_576).toFixed(1) + " MB";
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.75)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000,
};

const btn: React.CSSProperties = {
  background: "rgba(0,0,0,0.5)",
  border: "1px solid #475569",
  color: "#e2e8f0",
  padding: "5px 13px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};

const btnActive: React.CSSProperties = {
  ...btn,
  background: "rgba(59,130,246,0.4)",
  borderColor: "#3b82f6",
  color: "#93c5fd",
};

export default function WorldBrowserModal({ onClose, onOpenWorld }: Props) {
  const [server, setServer] = useState<"current" | "legacy">("current");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorldSearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  async function doSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setResults([]);
    setSelectedId(null);
    try {
      const res = await invoke<WorldSearchResult[]>("search_worlds", { query: query.trim(), server });
      setResults(res);
      if (res.length === 0) setError("No results found.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function startDownload(openAfter: boolean) {
    const result = results.find(r => r.id === selectedId);
    if (!result) return;
    const defaultName = `${result.name} ${result.id}.eden`;
    const destPath = await save({
      filters: [{ name: "Eden World", extensions: ["eden"] }],
      defaultPath: defaultName,
    });
    if (!destPath) return;

    setDownloading(true);
    setDownloadProgress({ downloaded: 0, total: result.file_size });
    setError(null);

    unlistenRef.current?.();
    const unlisten = await listen<DownloadProgress>("download-progress", e => {
      setDownloadProgress(e.payload);
    });
    unlistenRef.current = unlisten;

    try {
      await invoke("download_world", { id: selectedId, server, destPath });
      unlisten();
      unlistenRef.current = null;
      if (openAfter) {
        onOpenWorld(destPath);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  const selectedResult = results.find(r => r.id === selectedId) ?? null;

  return (
    <div style={overlay} onClick={onClose}>
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 10,
          padding: "18px 20px",
          width: 680,
          maxWidth: "95vw",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 24px 48px rgba(0,0,0,0.7)",
          color: "#e2e8f0",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>World Browser</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#475569", fontSize: 20, cursor: "pointer", lineHeight: 1 }}
          >×</button>
        </div>

        {/* Server tabs */}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setServer("current")} style={server === "current" ? btnActive : btn}>
            Current Server
          </button>
          <button onClick={() => setServer("legacy")} style={server === "legacy" ? btnActive : btn}>
            Legacy Server
          </button>
        </div>

        {/* Search bar */}
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") doSearch(); }}
            placeholder="Search worlds…"
            style={{
              flex: 1,
              background: "rgba(0,0,0,0.5)",
              border: "1px solid #475569",
              color: "#e2e8f0",
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            onClick={doSearch}
            disabled={searching || !query.trim()}
            style={{
              ...btn,
              opacity: (!query.trim() || searching) ? 0.5 : 1,
              cursor: (!query.trim() || searching) ? "not-allowed" : "pointer",
            }}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {/* Results table */}
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid #1e293b", borderRadius: 6, minHeight: 200 }}>
          {results.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#0d1829", borderBottom: "1px solid #1e293b" }}>
                  <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>Name</th>
                  <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>ID</th>
                  <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>Date</th>
                  <th style={{ textAlign: "right", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const isSelected = r.id === selectedId;
                  return (
                    <tr
                      key={`${r.id}-${i}`}
                      onClick={() => setSelectedId(r.id)}
                      style={{
                        background: isSelected ? "rgba(59,130,246,0.18)" : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                        cursor: "pointer",
                        borderBottom: "1px solid #1e293b",
                      }}
                    >
                      <td style={{ padding: "6px 10px", color: isSelected ? "#93c5fd" : "#e2e8f0" }}>
                        {isSelected ? "▶ " : "  "}{r.name}
                      </td>
                      <td style={{ padding: "6px 10px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{r.id}</td>
                      <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{formatDate(r.timestamp)}</td>
                      <td style={{ padding: "6px 10px", color: "#94a3b8", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatBytes(r.file_size)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 120, color: "#475569", fontSize: 13 }}>
              {searching ? "Searching…" : "Search to browse worlds"}
            </div>
          )}
        </div>

        {/* Download bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => startDownload(false)}
            disabled={!selectedId || downloading}
            style={{
              ...btn,
              opacity: (!selectedId || downloading) ? 0.4 : 1,
              cursor: (!selectedId || downloading) ? "not-allowed" : "pointer",
            }}
          >
            Save to File
          </button>
          <button
            onClick={() => startDownload(true)}
            disabled={!selectedId || downloading}
            style={{
              ...btn,
              borderColor: (!selectedId || downloading) ? "#475569" : "#22c55e",
              color: (!selectedId || downloading) ? "#e2e8f0" : "#86efac",
              opacity: (!selectedId || downloading) ? 0.4 : 1,
              cursor: (!selectedId || downloading) ? "not-allowed" : "pointer",
            }}
          >
            Save &amp; Open
          </button>

          {selectedResult && !downloading && (
            <span style={{ color: "#64748b", fontSize: 12 }}>
              {selectedResult.name} — {formatBytes(selectedResult.file_size)}
            </span>
          )}

          {downloading && downloadProgress && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <div style={{ flex: 1, background: "#1e293b", borderRadius: 4, height: 6, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  background: "#3b82f6",
                  width: downloadProgress.total
                    ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100).toFixed(0)}%`
                    : "40%",
                  transition: "width 0.2s",
                }} />
              </div>
              <span style={{ color: "#94a3b8", fontSize: 12, whiteSpace: "nowrap" }}>
                {downloadProgress.total
                  ? `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} / ${(downloadProgress.total / 1_048_576).toFixed(1)} MB`
                  : `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} MB`}
              </span>
            </div>
          )}

          {error && (
            <span style={{ color: "#f87171", fontSize: 12, flex: 1 }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}
