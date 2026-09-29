import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { MODAL_TEXT, recessedWell, spinnerStyle, expBadge } from "./designTokens";
import { ACCENTS, DANGER_HEX, RAMP, armedRecipe, mix, rgba } from "./theme/theme";
import { btnBase, btnDisabled, FONT } from "./ribbon/tokens";
import { Check, Select } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";

interface WorldSearchResult {
  id: string;
  name: string;
  timestamp: number;
}

interface LegacyFeaturedList {
  filename: string;
  date: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

interface Props {
  onClose: () => void;
  onOpenWorld: (path: string) => void;
}

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

// Lightened tints for text on the warm modal surface (mechanical hex-literal migration, Stage
// 14.15) — plain accent/danger hex fails AA there; these clear it with margin.
const TEAL_LIGHT = mix(RAMP.white, ACCENTS.primary, 0.5);
const RED_LIGHT = mix(RAMP.white, DANGER_HEX, 0.5);

const SERVER_OPTIONS: { id: "current" | "legacy"; label: string }[] = [
  { id: "current", label: "Current Server" },
  { id: "legacy", label: "Legacy Server" },
];

const NAV_ITEMS: DialogNavItem[] = [
  { id: "featured", icon: "sparkle", label: "Featured", description: "Curated popular worlds" },
  { id: "browse", icon: "history", label: "Browse", description: "Latest worlds from the server" },
  { id: "search", icon: "search", label: "Search", description: "Find a world by name" },
];

/** "Save & Open" is `ACCENTS.clipboard` (green — an "open" action), distinct from "Save to File"'s
 *  `DialogButton variant="primary"` teal. `DialogButton` only ships neutral/primary/danger, so this
 *  mirrors its own armed-recipe recipe for the one extra accent this dialog needs. */
function accentButtonStyle(accent: string, disabled: boolean): React.CSSProperties {
  const armed = armedRecipe(accent);
  return btnBase({
    height: 28, width: "100%", padding: "0 16px", fontSize: FONT.body, fontWeight: 600,
    color: armed.text, background: armed.bg, boxShadow: armed.shadow,
    textShadow: "0 1px 0 rgba(0,0,0,.35)",
    ...(disabled ? btnDisabled : null),
  });
}

export default function WorldBrowserModal({ onClose, onOpenWorld }: Props) {
  const [server, setServer] = useState<"current" | "legacy">("current");
  // True once a search/browse/featured fetch has come back — distinguishes "no matches" from
  // "you haven't looked yet".
  const [searched, setSearched] = useState(false);
  // Featured (server-published popularlist.txt, or one of the bundled historic snapshots) is the
  // default view; Browse and Search are reachable via their own nav rows.
  const [viewMode, setViewMode] = useState<"featured" | "browse" | "search">("featured");
  const switchServer = (s: "current" | "legacy") => {
    if (s === server) return;
    setServer(s);
    setResults([]);
    setSelectedId(null);
    setSearched(false);
    setError(null);
  };
  const switchMode = (m: "featured" | "browse" | "search") => {
    if (m === viewMode) return;
    setViewMode(m);
    setResults([]);
    setSelectedId(null);
    setSearched(false);
    setError(null);
  };
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorldSearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // Browse mode (C2 of the 256z-format plan): `list_worlds(start, sort)` with no search term,
  // the real client's own default listing. `hasMore` is a heuristic (an empty page means done) —
  // the server never advertises a total count or page size.
  const [browsing, setBrowsing] = useState(false);
  const [hasMoreToBrowse, setHasMoreToBrowse] = useState(true);
  // Featured tab: "live" pulls the server's current popularlist.txt; anything else is the
  // filename of a bundled historic snapshot under eden-leaderboards/ (list from the backend).
  const [featuredSource, setFeaturedSource] = useState<string>("live");
  const [legacyLists, setLegacyLists] = useState<LegacyFeaturedList[]>([]);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<"empty" | "loading" | "loaded" | "error">("empty");
  const [sortBy, setSortBy] = useState<"relevance" | "date_desc" | "date_asc" | "quality">("relevance");
  const [showFilters, setShowFilters] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [hideJunk, setHideJunk] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  // Gates onOpenWorld: even with dismissal blocked mid-download, the parent can still unmount us,
  // and a world-switch firing into a dead modal would be a surprise world change for the user.
  const mountedRef = useRef(true);

  useEffect(() => {
    // Strict Mode runs a development-only setup → cleanup → setup cycle. Re-arm the guard in
    // setup so that cycle does not make every later Save & Open silently skip its callback.
    mountedRef.current = true;
    return () => { mountedRef.current = false; unlistenRef.current?.(); };
  }, []);

  // Fetch the preview thumbnail whenever selection or server changes. The image is proxied through
  // Rust (`fetch_world_preview`) and wrapped in a blob: URL rather than pointed straight at the
  // HTTP-only Eden file host — a remote `<img src>` is blocked by the release build's CSP (it only
  // worked under `tauri dev`, where `devCsp` is null).
  useEffect(() => {
    if (!selectedId) { setPreviewUrl(null); setPreviewStatus("empty"); return; }
    setPreviewStatus("loading");
    let cancelled = false;
    let objUrl: string | null = null;
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("fetch_world_preview", { id: selectedId, server });
        if (cancelled) return;
        objUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        setPreviewUrl(objUrl);
      } catch {
        if (!cancelled) { setPreviewUrl(null); setPreviewStatus("error"); }
      }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [selectedId, server]);

  async function doSearch() {
    if (!query.trim()) return;
    setViewMode("search");
    setSearching(true);
    setError(null);
    setResults([]);
    setSelectedId(null);
    try {
      const res = await invoke<WorldSearchResult[]>("search_worlds", { query: query.trim(), server });
      setResults(res);
      setSearched(true);
      // "No results" is an empty state, not an error: routing it through setError painted it red
      // *and* rendered it twice (once in the table's empty slot, once in the sidebar error line).
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  // Browse mode (C2 of the 256z-format plan): the real client's own default listing —
  // `GET /list2.php?start=<start>&sort=2`, paginated via `start`. Reachable via its own nav row
  // (Featured is the default view now — see `doFeatured` below).
  const BROWSE_SORT = 2; // the value the real client sent when captured (Part C2/C6); unconfirmed beyond that

  async function doBrowse(reset: boolean) {
    if (browsing) return;
    setBrowsing(true);
    setError(null);
    if (reset) setSelectedId(null);
    const startAt = reset ? 0 : results.length;
    try {
      const res = await invoke<WorldSearchResult[]>("list_worlds", { start: startAt, sort: BROWSE_SORT, server });
      setResults(prev => reset ? res : [...prev, ...res]);
      setHasMoreToBrowse(res.length > 0);
      setSearched(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBrowsing(false);
    }
  }

  // Featured tab: the server's live popularlist.txt (files{,2}.edengame.net/popularlist.txt), or
  // one of the bundled historic snapshots under eden-leaderboards/ when `featuredSource` names one.
  async function doFeatured() {
    setFeaturedLoading(true);
    setError(null);
    setSelectedId(null);
    try {
      const res = featuredSource === "live"
        ? await invoke<WorldSearchResult[]>("fetch_featured_worlds", { server })
        : await invoke<WorldSearchResult[]>("load_legacy_featured_list", { filename: featuredSource });
      setResults(res);
      setSearched(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setFeaturedLoading(false);
    }
  }

  // Load the archive of bundled historic snapshots once, for the Featured nav row's dropdown.
  useEffect(() => {
    invoke<LegacyFeaturedList[]>("list_legacy_featured_lists").then(setLegacyLists).catch(() => {});
  }, []);

  // Fetch whenever the active tab, server, or (for Featured) the chosen snapshot changes.
  useEffect(() => {
    if (viewMode === "featured") doFeatured();
    else if (viewMode === "browse") doBrowse(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, server, featuredSource]);

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
      if (openAfter && mountedRef.current) onOpenWorld(destPath);
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

  const fl: React.CSSProperties = {
    fontSize: 9, color: MODAL_TEXT.secondary, textTransform: "uppercase",
    letterSpacing: "0.06em", fontWeight: 600,
  };
  const fi: React.CSSProperties = {
    ...recessedWell,
    color: MODAL_TEXT.primary, borderRadius: 5, padding: "3px 7px", fontSize: 11,
    colorScheme: "dark",
  } as React.CSSProperties;

  return (
    // Dismissal is blocked while a download runs: closing wouldn't stop it, and "Save & Open"
    // would still fire onOpenWorld when it lands — switching worlds (and raising an unsaved-changes
    // prompt) long after the user thought they'd backed out.
    <Dialog
      size="lg" icon="world" title="World Browser" onClose={onClose} busy={downloading}
      nav={
        <DialogNav
          items={NAV_ITEMS}
          value={viewMode}
          onChange={id => switchMode(id as "featured" | "browse" | "search")}
          footer={
            <Select<"current" | "legacy">
              value={server} ariaLabel="Server" options={SERVER_OPTIONS}
              onChange={switchServer} width={172}
            />
          }
        />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>

        {/* Content header — per-tab controls. The search field lives here (Search only), moved out
            of an always-visible top strip per the modal redesign (plan §3.4). */}
        {viewMode === "search" && (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") doSearch(); }}
              placeholder="Search worlds…"
              autoFocus
              style={{
                ...recessedWell,
                flex: 1,
                color: MODAL_TEXT.primary,
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 13,
                outline: "none",
              }}
            />
            <DialogButton variant="primary" onClick={doSearch} disabled={searching || !query.trim()}>
              {searching ? "Searching…" : "Search"}
            </DialogButton>
          </div>
        )}
        {viewMode === "featured" && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={fl}>Snapshot</span>
            <Select<string>
              ariaLabel="Snapshot" width={170}
              value={featuredSource}
              onChange={setFeaturedSource}
              options={[
                { id: "live", label: "Live (current)" },
                ...legacyLists.map(l => ({ id: l.filename, label: l.date })),
              ]}
            />
          </div>
        )}

        {/* Sort + filter controls */}
        <div style={{ borderTop: `1px solid ${RAMP.mbtn1}`, borderBottom: `1px solid ${RAMP.mbtn1}`, padding: "5px 0", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={fl}>Sort</span>
            {([
              { key: "relevance", label: "Relevance" },
              { key: "date_desc", label: "Newest" },
              { key: "date_asc", label: "Oldest" },
              { key: "quality",  label: "Quality" },
            ] as const).map(m => (
              <button key={m.key} onClick={() => setSortBy(m.key)} style={{
                background: sortBy === m.key ? rgba(ACCENTS.primary, 0.15) : "transparent",
                border: "1px solid " + (sortBy === m.key ? TEAL_LIGHT : "transparent"),
                color: sortBy === m.key ? TEAL_LIGHT : MODAL_TEXT.label,
                padding: "2px 7px", borderRadius: 5, cursor: "pointer", fontSize: 11,
                display: "flex", alignItems: "center", gap: 4,
              }}>
                {m.label}
                {m.key === "quality" && (
                  <span style={expBadge({ fontSize: 9 })}>exp</span>
                )}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <DialogButton
              onClick={() => setShowFilters(!showFilters)}
              style={activeFilters > 0 ? {
                boxShadow: `inset 0 0 0 1px ${TEAL_LIGHT}, 0 .5px .5px rgba(255,255,255,.2)`,
                color: TEAL_LIGHT,
              } : undefined}
            >
              Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}
            </DialogButton>
          </div>
          {showFilters && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "4px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={fl}>Date</span>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={fi} />
                <span style={{ color: MODAL_TEXT.secondary, fontSize: 11 }}>→</span>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={fi} />
              </div>
              <Check
                checked={hideJunk} onChange={setHideJunk}
                label={<><span style={fl}>Hide junk</span><span style={expBadge({ fontSize: 9, marginLeft: 5 })}>exp</span></>}
              />
              {activeFilters > 0 && (
                <DialogButton
                  onClick={() => { setFromDate(""); setToDate(""); setHideJunk(false); }}
                  style={{ marginLeft: "auto" }}
                >
                  Clear filters
                </DialogButton>
              )}
            </div>
          )}
        </div>

        {/* Filter count */}
        {results.length > 0 && filteredResults.length !== results.length && (
          <div style={{ fontSize: 11, color: MODAL_TEXT.label, textAlign: "right" }}>
            Showing {filteredResults.length} of {results.length}
          </div>
        )}

        {/* Body: results table + sidebar */}
        <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>

          {/* Results table */}
          <div style={{ flex: 1, overflowY: "auto", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)", borderRadius: 6, minWidth: 0, minHeight: 200 }}>
            {filteredResults.length > 0 ? (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: RAMP.modal1, borderBottom: `1px solid ${RAMP.mbtn1}`, position: "sticky", top: 0, zIndex: 1 }}>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: MODAL_TEXT.secondary, fontWeight: 600 }}>Name</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: MODAL_TEXT.secondary, fontWeight: 600 }}>ID</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: MODAL_TEXT.secondary, fontWeight: 600 }}>Date</th>
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
                          background: isSelected ? rgba(ACCENTS.primary, 0.18) : i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                          cursor: "pointer",
                          borderBottom: `1px solid ${RAMP.mbtn1}`,
                        }}
                      >
                        <td style={{ padding: "6px 10px", color: isSelected ? TEAL_LIGHT : MODAL_TEXT.primary }}>
                          {isSelected ? "▶ " : "  "}{r.name}
                        </td>
                        <td style={{ padding: "6px 10px", color: MODAL_TEXT.label, fontVariantNumeric: "tabular-nums" }}>{r.id}</td>
                        <td style={{ padding: "6px 10px", color: MODAL_TEXT.secondary }}>{formatDate(r.timestamp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 120, color: MODAL_TEXT.secondary, fontSize: 13 }}>
                {searching ? "Searching…" :
                 browsing || featuredLoading ? "Loading worlds…" :
                 results.length > 0 ? "No results match your filters" :
                 searched ? (viewMode === "search" ? "No worlds found — try a different search term" : "No worlds found") :
                 "Loading worlds…"}
              </div>
            )}
            {viewMode === "browse" && hasMoreToBrowse && filteredResults.length > 0 && !searching && (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
                <DialogButton onClick={() => doBrowse(false)} disabled={browsing}>
                  {browsing ? "Loading…" : "Load more"}
                </DialogButton>
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Preview image — fixed height */}
            <div style={{
              height: 200,
              background: RAMP.modal1,
              boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)",
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
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: RAMP.mbtn1 }}>
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <span style={{ fontSize: 11, color: MODAL_TEXT.secondary }}>
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
                  <div style={spinnerStyle(20)} />
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
              background: RAMP.modal1,
              boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)",
              borderRadius: 8,
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              flex: 1,
            }}>
              {selectedResult ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: MODAL_TEXT.primary, lineHeight: 1.3, wordBreak: "break-word" }}>
                    {selectedResult.name}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 9, color: MODAL_TEXT.secondary, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Date</span>
                    <span style={{ fontSize: 12, color: MODAL_TEXT.secondary }}>{formatDate(selectedResult.timestamp)}</span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 9, color: MODAL_TEXT.secondary, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>ID</span>
                    <span style={{ fontSize: 11, color: MODAL_TEXT.label, fontVariantNumeric: "tabular-nums" }}>{selectedResult.id}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: MODAL_TEXT.secondary, textAlign: "center", marginTop: 8 }}>
                  Select a world to see details
                </div>
              )}
            </div>

            {/* Download buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <DialogButton
                variant="primary"
                onClick={() => startDownload(false)}
                disabled={!selectedId || downloading}
                style={{ width: "100%", fontSize: 13 }}
              >
                Save to File
              </DialogButton>
              <button
                type="button"
                onClick={() => startDownload(true)}
                disabled={!selectedId || downloading}
                style={accentButtonStyle(ACCENTS.clipboard, !selectedId || downloading)}
              >
                Save &amp; Open
              </button>

              {/* Progress bar */}
              {downloading && downloadProgress && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, background: RAMP.mbtn1, borderRadius: 4, height: 5, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      background: `linear-gradient(90deg, ${ACCENTS.primary} 0%, ${TEAL_LIGHT} 100%)`,
                      width: downloadProgress.total
                        ? `${Math.min(100, (downloadProgress.downloaded / downloadProgress.total) * 100).toFixed(0)}%`
                        : "40%",
                      transition: "width 0.2s",
                    }} />
                  </div>
                  <span style={{ color: MODAL_TEXT.secondary, fontSize: 11, whiteSpace: "nowrap" }}>
                    {downloadProgress.total
                      ? `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} / ${(downloadProgress.total / 1_048_576).toFixed(1)} MB`
                      : `${(downloadProgress.downloaded / 1_048_576).toFixed(1)} MB`}
                  </span>
                </div>
              )}

              {error && (
                <span style={{ color: RED_LIGHT, fontSize: 11 }}>{error}</span>
              )}
            </div>

          </div>{/* /sidebar */}
        </div>{/* /body row */}

      </div>
    </Dialog>
  );
}
