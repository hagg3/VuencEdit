import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";

interface WorldSearchResult {
  id: string;
  name: string;
  timestamp: number;
}

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

interface Props {
  onClose: () => void;
  onOpenWorld: (path: string) => void;
}

const FILES_BASE: Record<"current" | "legacy", string> = {
  current: "http://files2.edengame.net",
  legacy:  "http://files.edengame.net",
};

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function scoreWorld(name: string, timestamp: number): number {
  const lname = name.toLowerCase();
  if (lname.includes("'red'")) return -10;
  let score = 0;
  const negTerms = ["test", "asdf", "qwer", "xxxx", "lol"];
  if (negTerms.some(w => lname.includes(w))) score -= 3;
  const structure = ["city","station","base","facility","complex","zone","sector","district",
    "hub","port","terminal","outpost","bunker","vault","lab","laboratory","factory","plant",
    "tower","bridge","arena","stadium","castle","fortress","palace","temple","dungeon",
    "citadel","stronghold","colony","ruins","museum","stadt","basis","komplex","hafen",
    "fabrik","turm","ville","secteur","ciudad","complejo","laboratorio"];
  score += Math.min(structure.filter(w => lname.includes(w)).length, 3);
  const gameplay = ["adventure","quest","puzzle","parkour","story","campaign","mission","maze",
    "challenge","rpg","survival","course","race","trial","gauntlet","battle","boss","raid"];
  score += Math.min(gameplay.filter(w => lname.includes(w)).length, 3);
  if (/\bv\d+\b/.test(lname) || ["alpha","beta","wip","redux","remake","final","rev"].some(w => lname.includes(w))) score += 1;
  const words = lname.split(/\s+/).filter(Boolean);
  if (words.length >= 3) score += 1;
  if (/[A-Z]/.test(name)) score += 1;
  if (/^[a-z0-9_]{6,}$/.test(lname.replace(/\s/g, ""))) score -= 2;
  const year = new Date(timestamp * 1000).getFullYear();
  if (year <= 2014) score += 1;
  if (year <= 2012) score += 1;
  if (/\bby\s+[a-z0-9]+$/i.test(name)) score += 1;
  return score;
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
  const [previewStatus, setPreviewStatus] = useState<"empty" | "loading" | "loaded" | "error">("empty");
  const [sortBy, setSortBy] = useState<"relevance" | "date_desc" | "date_asc" | "quality">("relevance");
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [hideJunk, setHideJunk] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  // Reset preview whenever selection or server changes
  useEffect(() => {
    setPreviewStatus(selectedId ? "loading" : "empty");
  }, [selectedId, server]);

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
    setDownloadProgress({ downloaded: 0, total: null });
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
      if (openAfter) onOpenWorld(destPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  const fromTs = fromDate ? new Date(fromDate + "T00:00:00").getTime() / 1000 : null;
  const toTs   = toDate   ? new Date(toDate   + "T23:59:59").getTime() / 1000 : null;
  const activeFilters = [fromDate, toDate, hideJunk ? "1" : ""].filter(Boolean).length;

  let filteredResults = results.filter(r => {
    if (fromTs !== null && r.timestamp < fromTs) return false;
    if (toTs   !== null && r.timestamp > toTs)   return false;
    if (hideJunk && scoreWorld(r.name, r.timestamp) < 0) return false;
    return true;
  });
  if (sortBy === "date_desc") filteredResults = [...filteredResults].sort((a, b) => b.timestamp - a.timestamp);
  else if (sortBy === "date_asc") filteredResults = [...filteredResults].sort((a, b) => a.timestamp - b.timestamp);
  else if (sortBy === "quality") filteredResults = [...filteredResults].sort((a, b) => scoreWorld(b.name, b.timestamp) - scoreWorld(a.name, a.timestamp));

  const selectedResult = results.find(r => r.id === selectedId) ?? null;
  const previewUrl = selectedResult
    ? `${FILES_BASE[server]}/${selectedResult.id}.eden.png`
    : null;

  return (
    <div style={overlay} onClick={onClose}>
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 10,
          padding: "18px 20px",
          width: 900,
          maxWidth: "96vw",
          maxHeight: "88vh",
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

        {/* Sort + filter controls */}
        {(() => {
          const sortModes = [
            { key: "relevance", label: "Relevance" },
            { key: "date_desc", label: "Newest" },
            { key: "date_asc", label: "Oldest" },
            { key: "quality",  label: "Quality" },
          ] as const;
          const fi: React.CSSProperties = {
            background: "rgba(0,0,0,0.4)", border: "1px solid #334155",
            color: "#e2e8f0", borderRadius: 5, padding: "3px 7px", fontSize: 11,
            colorScheme: "dark",
          } as React.CSSProperties;
          const fl: React.CSSProperties = {
            fontSize: 9, color: "#475569", textTransform: "uppercase",
            letterSpacing: "0.06em", fontWeight: 600,
          };
          return (
            <div style={{ borderTop: "1px solid #1e293b", borderBottom: "1px solid #1e293b", padding: "5px 0", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={fl}>Sort</span>
                {sortModes.map(m => (
                  <button key={m.key} onClick={() => setSortBy(m.key)} style={{
                    background: sortBy === m.key ? "rgba(59,130,246,0.15)" : "transparent",
                    border: "1px solid " + (sortBy === m.key ? "#3b82f6" : "transparent"),
                    color: sortBy === m.key ? "#93c5fd" : "#64748b",
                    padding: "2px 7px", borderRadius: 5, cursor: "pointer", fontSize: 11,
                    display: "flex", alignItems: "center", gap: 4,
                  }}>
                    {m.label}
                    {m.key === "quality" && (
                      <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                    )}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <button onClick={() => setShowFilters(!showFilters)} style={{
                  ...btn, fontSize: 11, padding: "2px 9px",
                  background: (activeFilters > 0 || showFilters) ? "rgba(59,130,246,0.1)" : "rgba(0,0,0,0.3)",
                  borderColor: activeFilters > 0 ? "#3b82f6" : "#475569",
                  color: activeFilters > 0 ? "#93c5fd" : "#e2e8f0",
                }}>
                  Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}
                </button>
              </div>
              {showFilters && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "4px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={fl}>Date</span>
                    <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={fi} />
                    <span style={{ color: "#475569", fontSize: 11 }}>→</span>
                    <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={fi} />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                    <input type="checkbox" checked={hideJunk} onChange={e => setHideJunk(e.target.checked)} />
                    <span style={fl}>Hide junk</span>
                    <span style={{ fontSize: 9, color: "#f59e0b", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 3, padding: "0 3px", lineHeight: "14px" }}>exp</span>
                  </label>
                  {activeFilters > 0 && (
                    <button onClick={() => { setFromDate(""); setToDate(""); setHideJunk(false); }}
                      style={{ ...btn, fontSize: 11, padding: "2px 8px", marginLeft: "auto" }}>
                      Clear filters
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Filter count */}
        {results.length > 0 && filteredResults.length !== results.length && (
          <div style={{ fontSize: 11, color: "#64748b", textAlign: "right" }}>
            Showing {filteredResults.length} of {results.length}
          </div>
        )}

        {/* Body: results table + sidebar */}
        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>

          {/* Results table */}
          <div style={{ flex: 1, overflowY: "auto", border: "1px solid #1e293b", borderRadius: 6, minWidth: 0, minHeight: 200 }}>
            {filteredResults.length > 0 ? (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#0d1829", borderBottom: "1px solid #1e293b", position: "sticky", top: 0, zIndex: 1 }}>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>Name</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>ID</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "#475569", fontWeight: 600 }}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((r, i) => {
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
                          {isSelected ? "▶ " : "  "}{r.name}
                        </td>
                        <td style={{ padding: "6px 10px", color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{r.id}</td>
                        <td style={{ padding: "6px 10px", color: "#94a3b8" }}>{formatDate(r.timestamp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 120, color: "#475569", fontSize: 13 }}>
                {searching ? "Searching…" :
                 results.length > 0 ? "No results match your filters" :
                 error ?? "Search to browse worlds"}
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Preview image — fixed height */}
            <div style={{
              height: 200,
              background: "#0d1829",
              border: "1px solid #1e293b",
              borderRadius: 8,
              overflow: "hidden",
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}>
              {/* Placeholder / error state */}
              {(previewStatus === "empty" || previewStatus === "error") && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#1e293b" }}>
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <span style={{ fontSize: 11, color: "#334155" }}>
                    {previewStatus === "error" ? "No preview available" : "No world selected"}
                  </span>
                </div>
              )}

              {/* Loading spinner */}
              {previewStatus === "loading" && (
                <div style={{
                  position: "absolute", inset: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <div style={{
                    width: 20, height: 20,
                    border: "2px solid #1e293b",
                    borderTopColor: "#3b82f6",
                    borderRadius: "50%",
                    animation: "spin 0.7s linear infinite",
                  }} />
                </div>
              )}

              {/* Actual image — always rendered when URL exists so onLoad/onError fire */}
              {previewUrl && (
                <img
                  key={previewUrl}
                  src={previewUrl}
                  alt="World preview"
                  onLoad={() => setPreviewStatus("loaded")}
                  onError={() => setPreviewStatus("error")}
                  style={{
                    position: "absolute", inset: 0,
                    width: "100%", height: "100%",
                    objectFit: "cover",
                    display: previewStatus === "loaded" ? "block" : "none",
                  }}
                />
              )}
            </div>

            {/* World details card */}
            <div style={{
              background: "#0d1829",
              border: "1px solid #1e293b",
              borderRadius: 8,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              flex: 1,
            }}>
              {selectedResult ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", lineHeight: 1.3, wordBreak: "break-word" }}>
                    {selectedResult.name}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Date</span>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>{formatDate(selectedResult.timestamp)}</span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>ID</span>
                    <span style={{ fontSize: 11, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>{selectedResult.id}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: "#334155", textAlign: "center", marginTop: 8 }}>
                  Select a world to see details
                </div>
              )}
            </div>

            {/* Download buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                onClick={() => startDownload(false)}
                disabled={!selectedId || downloading}
                style={{
                  ...btn,
                  width: "100%",
                  opacity: (!selectedId || downloading) ? 0.4 : 1,
                  cursor: (!selectedId || downloading) ? "not-allowed" : "pointer",
                  background: "rgba(59,130,246,0.15)",
                  borderColor: (!selectedId || downloading) ? "#475569" : "#3b82f6",
                  color: "#93c5fd",
                }}
              >
                Save to File
              </button>
              <button
                onClick={() => startDownload(true)}
                disabled={!selectedId || downloading}
                style={{
                  ...btn,
                  width: "100%",
                  borderColor: (!selectedId || downloading) ? "#475569" : "#22c55e",
                  color: (!selectedId || downloading) ? "#e2e8f0" : "#86efac",
                  opacity: (!selectedId || downloading) ? 0.4 : 1,
                  cursor: (!selectedId || downloading) ? "not-allowed" : "pointer",
                }}
              >
                Save &amp; Open
              </button>

              {/* Progress bar */}
              {downloading && downloadProgress && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, background: "#1e293b", borderRadius: 4, height: 5, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      background: "#3b82f6",
                      width: downloadProgress.total
                        ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100).toFixed(0)}%`
                        : "40%",
                      transition: "width 0.2s",
                    }} />
                  </div>
                  <span style={{ color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>
                    {downloadProgress.total
                      ? `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} / ${(downloadProgress.total / 1_048_576).toFixed(1)} MB`
                      : `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} MB`}
                  </span>
                </div>
              )}

              {error && (
                <span style={{ color: "#f87171", fontSize: 11 }}>{error}</span>
              )}
            </div>

          </div>{/* /sidebar */}
        </div>{/* /body row */}

      </div>
    </div>
  );
}
