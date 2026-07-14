import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { decodeU8 } from "./codec";
import { EDEN_TEAL_READABLE, glassPanel, chromeButton, accentRing } from "./designTokens";
import type { ClipboardInfo, PreviewDataRaw } from "./types";

interface PrefabEntry {
  name: string;
  path: string;
  width: number;
  height: number;
  depth: number;
  modified: number; // ms since epoch; 0 if unavailable
}

type SortKey = "name" | "newest" | "size";
type ViewMode = "list" | "grid";

const SORT_LS = "eden_prefab_sort";
const VIEW_LS = "eden_prefab_view";

/** Resolve the active prefab library folder: user-set `prefabDirectory` in Settings, else the
 * app-default `<app_data_dir>/prefabs`. Shared by this panel and App.tsx's "Save Prefab" flow so
 * both write/read the same place. Returns null only if the default dir can't be resolved. */
export async function resolvePrefabDir(): Promise<string | null> {
  let settingsDir: string | null = null;
  try {
    const raw = localStorage.getItem("eden_settings");
    settingsDir = raw ? JSON.parse(raw).prefabDirectory ?? null : null;
  } catch { /* ignore malformed settings */ }
  return settingsDir ?? await invoke<string>("get_default_prefab_dir").catch(() => null);
}

function Thumbnail({ url, failed, size }: { url: string | null; failed: boolean; size: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 4, flexShrink: 0, overflow: "hidden",
      background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {url ? (
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }} />
      ) : (
        <span style={{ color: failed ? "#7f1d1d" : "#4b443d", fontSize: 16 }}>{failed ? "!" : "…"}</span>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", fontSize: 12, lineHeight: 1,
  padding: "0 4px", flexShrink: 0,
};

export default function PrefabLibraryPanel({
  onClose, onArmPaste, onSaveAs, refreshToken, topPx,
}: {
  onClose: () => void;
  /** Receives the loaded prefab's ClipboardInfo — App must set clipboard state from it,
   *  or paste mode arms with no ghost/dimensions and the first click lands blind. */
  onArmPaste: (info: ClipboardInfo) => void;
  /** Native "save anywhere" fallback — wired to App's savePrefabAs(). */
  onSaveAs: () => void;
  /** Bumped by App after a prefab is saved into the library so the gallery re-lists. */
  refreshToken?: number;
  topPx?: number;
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<PrefabEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // path -> data URL (null on failure, undefined = still pending). Fetched one at a time (see effect
  // below) — firing one invoke() per entry in parallel on mount was flooding the backend with
  // simultaneous full-file gzip decodes and freezing the app on folders with many/large prefabs.
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const thumbEpochRef = useRef(0);
  // Persistent decoded-thumbnail cache keyed by `${path}::${mtime}`, so re-listing (Refresh, save,
  // reopen) doesn't re-render unchanged files. Survives across list resets; invalidated per-file
  // whenever a file's mtime changes.
  const thumbCacheRef = useRef<Map<string, string | null>>(new Map());
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem(SORT_LS) as SortKey) || "name");
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem(VIEW_LS) as ViewMode) || "list");

  useEffect(() => { localStorage.setItem(SORT_LS, sort); }, [sort]);
  useEffect(() => { localStorage.setItem(VIEW_LS, view); }, [view]);

  const cacheKey = (e: PrefabEntry) => `${e.path}::${e.modified}`;

  const q = query.trim().toLowerCase();
  const shown = (q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries)
    .slice()
    .sort((a, b) => {
      if (sort === "newest") return b.modified - a.modified;
      if (sort === "size") return (b.width * b.height * b.depth) - (a.width * a.height * a.depth);
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const refresh = useCallback(async (targetDir: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<PrefabEntry[]>("list_prefabs", { dir: targetDir });
      setEntries(list);
      // Seed thumbnails from cache so unchanged files paint instantly; the loader fetches the rest.
      const seeded: Record<string, string | null> = {};
      const live = new Set<string>();
      for (const e of list) {
        const key = `${e.path}::${e.modified}`;
        live.add(key);
        const cached = thumbCacheRef.current.get(key);
        if (cached !== undefined) seeded[e.path] = cached;
      }
      // Evict data URLs for entries no longer in the listing — deleted, renamed, edited (the mtime
      // is part of the key), or from a previously-browsed folder. The cache is keyed by
      // `path::mtime` and never expired otherwise, so a long session over a big library only grew.
      for (const key of thumbCacheRef.current.keys()) {
        if (!live.has(key)) thumbCacheRef.current.delete(key);
      }
      setThumbs(seeded);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const target = await resolvePrefabDir();
      if (cancelled || !target) return;
      setDir(target);
      await refresh(target);
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  // Re-list when App bumps refreshToken (a prefab was just saved into the library). Skipped on the
  // initial mount (dir is still null then; the effect above owns the first listing). Re-fetching on
  // an external token bump is a legitimate effect (same category as the codebase's other "sync on
  // external change" effects); refresh() sets loading state internally, hence the disables.
  useEffect(() => {
    if (dir) refresh(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // Sequential thumbnail loader: one invoke() in flight at a time. `epoch` is bumped whenever
  // `entries` changes (including on Refresh) so a stale loop from a prior listing stops early.
  // Cache hits are skipped (already seeded in refresh()).
  useEffect(() => {
    const epoch = ++thumbEpochRef.current;
    (async () => {
      for (const entry of entries) {
        if (thumbEpochRef.current !== epoch) return;
        if (thumbCacheRef.current.has(cacheKey(entry))) continue;
        try {
          const raw = await invoke<PreviewDataRaw>("render_prefab_thumbnail", { path: entry.path });
          if (thumbEpochRef.current !== epoch) return;
          const pixels = decodeU8(raw.pixels);
          const canvas = document.createElement("canvas");
          canvas.width = raw.width; canvas.height = raw.height;
          const ctx = canvas.getContext("2d");
          const url = ctx ? (ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), raw.width, raw.height), 0, 0), canvas.toDataURL()) : null;
          thumbCacheRef.current.set(cacheKey(entry), url);
          setThumbs(t => ({ ...t, [entry.path]: url }));
        } catch {
          if (thumbEpochRef.current !== epoch) return;
          thumbCacheRef.current.set(cacheKey(entry), null);
          setThumbs(t => ({ ...t, [entry.path]: null }));
        }
      }
    })();
  }, [entries]);

  async function handleClick(entry: PrefabEntry) {
    try {
      const info = await invoke<ClipboardInfo>("load_prefab", { path: entry.path });
      onArmPaste(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(entry: PrefabEntry) {
    setConfirmDelete(null);
    try {
      await invoke("delete_prefab", { path: entry.path });
      setEntries((list) => list.filter((e) => e.path !== entry.path));
      setThumbs((t) => { const { [entry.path]: _drop, ...rest } = t; return rest; });
    } catch (e) {
      setError(String(e));
    }
  }

  function startRename(entry: PrefabEntry) {
    setConfirmDelete(null);
    setRenameInput(entry.name);
    setRenaming(entry.path);
  }

  async function commitRename(entry: PrefabEntry) {
    const name = renameInput.trim();
    setRenaming(null);
    if (!name || name === entry.name) return;
    try {
      const newPath = await invoke<string>("rename_prefab", { path: entry.path, newName: name });
      // Migrate the cached thumbnail to the new path so it doesn't re-render.
      const old = thumbCacheRef.current.get(cacheKey(entry));
      if (old !== undefined) thumbCacheRef.current.set(`${newPath}::${entry.modified}`, old);
      setEntries((list) => list.map((e) => e.path === entry.path ? { ...e, path: newPath, name } : e));
      setThumbs((t) => {
        const { [entry.path]: url, ...rest } = t;
        return url !== undefined ? { ...rest, [newPath]: url } : rest;
      });
    } catch (e) {
      setError(String(e));
    }
  }

  // Delete-confirm / rename-start controls, shared by both views.
  function actions(entry: PrefabEntry) {
    if (confirmDelete === entry.path) {
      return (
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button onClick={() => handleDelete(entry)} title="Confirm delete" style={{ ...iconBtn, color: "#f87171", fontSize: 13 }}>✓</button>
          <button onClick={() => setConfirmDelete(null)} title="Cancel" style={{ ...iconBtn, color: "#afa69d", fontSize: 13 }}>✗</button>
        </div>
      );
    }
    if (hovered !== entry.path) return null;
    return (
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
        <button onClick={() => startRename(entry)} title="Rename" style={{ ...iconBtn, color: "#afa69d" }}>✎</button>
        <button onClick={() => setConfirmDelete(entry.path)} title="Delete" style={{ ...iconBtn, color: "#afa69d" }}>🗑</button>
      </div>
    );
  }

  const renameInputEl = (entry: PrefabEntry) => (
    <input
      autoFocus
      value={renameInput}
      onChange={(e) => setRenameInput(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") commitRename(entry); if (e.key === "Escape") setRenaming(null); }}
      onBlur={() => commitRename(entry)}
      style={{
        width: "100%", background: "rgba(0,0,0,0.6)", border: "1px solid #61584f", borderRadius: 4,
        color: "#ebe9e7", padding: "2px 5px", fontSize: 12, outline: "none",
      }}
    />
  );

  const panelStyle: React.CSSProperties = glassPanel({
    position: "fixed", top: topPx ?? 108, left: 12, width: 232, maxHeight: "72vh",
    padding: "10px 10px 8px", display: "flex", flexDirection: "column", gap: 8,
    color: "#ebe9e7", fontSize: 12, zIndex: 60,
  });

  const selectStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.4)", border: "1px solid #4b443d", borderRadius: 5,
    color: "#dad6d2", padding: "4px 6px", fontSize: 11, outline: "none", cursor: "pointer",
  };

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700, color: EDEN_TEAL_READABLE, fontSize: 12 }}>Prefab Library</span>
        <button onClick={onClose}
          style={{ background: "none", border: "none", color: "#83786c", fontSize: 14, cursor: "pointer", lineHeight: 1 }}
        >×</button>
      </div>
      <div style={{ fontSize: 10, color: "#61584f", wordBreak: "break-all" }}>{dir ?? "…"}</div>
      {entries.length > 0 && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prefabs…"
            style={{
              background: "rgba(0,0,0,0.4)", border: "1px solid #4b443d", borderRadius: 5,
              color: "#ebe9e7", padding: "5px 8px", fontSize: 11, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="Sort by" style={{ ...selectStyle, flex: 1 }}>
              <option value="name">Name</option>
              <option value="newest">Newest</option>
              <option value="size">Size</option>
            </select>
            <button
              onClick={() => setView((v) => (v === "list" ? "grid" : "list"))}
              title={view === "list" ? "Switch to grid view" : "Switch to list view"}
              style={chromeButton({ padding: "4px 9px", fontSize: 12 })}
            >{view === "list" ? "▦" : "☰"}</button>
          </div>
        </>
      )}
      {error && <div style={{ color: "#f87171", fontSize: 11 }}>{error}</div>}

      <div style={{ overflowY: "auto", flex: 1 }}>
        {loading && <div style={{ color: "#83786c" }}>Loading…</div>}
        {!loading && entries.length === 0 && !error && (
          <div style={{ color: "#61584f", fontSize: 11 }}>No .epfab files found. Save a prefab from a selection to populate this folder.</div>
        )}
        {!loading && entries.length > 0 && shown.length === 0 && (
          <div style={{ color: "#61584f", fontSize: 11 }}>No prefabs match “{query}”.</div>
        )}

        {view === "list" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {shown.map((entry) => {
              const isRenaming = renaming === entry.path;
              return (
                <div
                  key={entry.path}
                  onMouseEnter={() => setHovered(entry.path)}
                  onMouseLeave={() => setHovered((h) => (h === entry.path ? null : h))}
                  onClick={() => { if (!isRenaming) handleClick(entry); }}
                  title={isRenaming ? undefined : `${entry.width}×${entry.height}×${entry.depth} — click to paste`}
                  role="button"
                  style={{
                    display: "flex", alignItems: "center", gap: 4, borderRadius: 5, padding: 5,
                    cursor: isRenaming ? "default" : "pointer", color: "#dad6d2",
                    background: hovered === entry.path ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                  }}
                >
                  <Thumbnail url={typeof thumbs[entry.path] === "string" ? thumbs[entry.path] : null} failed={thumbs[entry.path] === null} size={40} />
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}
                    onClick={(e) => { if (isRenaming) e.stopPropagation(); }}
                  >
                    {isRenaming ? renameInputEl(entry) : (
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                    )}
                    <span style={{ fontSize: 10, color: "#83786c" }}>{entry.width}×{entry.height}×{entry.depth}</span>
                  </div>
                  <div onClick={(e) => e.stopPropagation()} style={{ paddingRight: 2 }}>{actions(entry)}</div>
                </div>
              );
            })}
          </div>
        )}

        {view === "grid" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 6 }}>
            {shown.map((entry) => (
              <div
                key={entry.path}
                onMouseEnter={() => setHovered(entry.path)}
                onMouseLeave={() => setHovered((h) => (h === entry.path ? null : h))}
                title={`${entry.name} — ${entry.width}×${entry.height}×${entry.depth}`}
                style={{ position: "relative", display: "flex", flexDirection: "column", gap: 3, cursor: "pointer" }}
                onClick={() => { if (renaming !== entry.path) handleClick(entry); }}
              >
                <Thumbnail url={typeof thumbs[entry.path] === "string" ? thumbs[entry.path] : null} failed={thumbs[entry.path] === null} size={64} />
                {(hovered === entry.path || confirmDelete === entry.path) && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute", top: 2, right: 2, borderRadius: 4,
                      background: "rgba(0,0,0,0.6)", padding: "1px 2px",
                    }}
                  >{actions(entry)}</div>
                )}
                {renaming === entry.path ? (
                  <div onClick={(e) => e.stopPropagation()}>{renameInputEl(entry)}</div>
                ) : (
                  <span style={{ fontSize: 10, color: "#dad6d2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => dir && refresh(dir)} style={chromeButton({ flex: 1, padding: "5px 10px", fontSize: 11 })}>
          Refresh
        </button>
        <button
          onClick={() => dir && openPath(dir).catch((e) => setError(String(e)))}
          disabled={!dir}
          title="Reveal the prefab library folder"
          style={chromeButton({ flex: 1, padding: "5px 10px", fontSize: 11, opacity: dir ? 1 : 0.5 })}
        >
          Open Folder
        </button>
      </div>
      <button onClick={onSaveAs} style={chromeButton({ padding: "5px 10px", fontSize: 11, ...accentRing("#4ade80"), color: "#86efac" })}>
        Save Selection As…
      </button>
    </div>
  );
}
