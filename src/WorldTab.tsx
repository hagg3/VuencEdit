/**
 * The docked sidebar's **World** tab (ROADMAP-EDIT 24.1; was the Inspector, `audit/00-inspector-sidebar.md`
 * Option A). A navigator, not a second status bar: Selection (only the numbers the status bar
 * doesn't show), World + Places, and a Signs explorer. The Clipboard block it used to carry is gone
 * (it duplicated the Clipboard tab's Preview and the Lens).
 *
 * Every "go to" goes through `onGoTo` (App's `goTo`): 2D centre + zoom, plus a 3D aim when the 3D
 * view is live. The pure search/sort/volume logic lives in `worldNav.ts`.
 */
import { useEffect, useMemo, useState } from "react";
import type { CmdInfo, RecordsInfo, SelectionInfo, SignInfo } from "./types";
import {
  ACCENT, TEXT, TEXT_META, TEXT_LABEL,
  RADIUS, SPACE, hexToRgbTriplet,
} from "./ribbon/tokens";
import { Section, PropGrid, PROP_MONO } from "./ui/PropertyGrid";
import { SmallButton, TextField } from "./ribbon/primitives";
import { useWorldInfo, formatLabel } from "./panels/WorldInfoPanel";
import {
  loadBookmarks, saveBookmarks, addBookmark, renameBookmark, deleteBookmark, MAX_BOOKMARKS, type Bookmark,
} from "./bookmarks";
import { selectionVolume, filterSigns, sortSigns, signDistance, type SignSort } from "./worldNav";
import { MAP } from "./theme/theme";
import { FONT } from "./ribbon/tokens";

export interface WorldTabProps {
  /** Sidebar tab is always mounted, unlike the old floating panel which only mounted while a
   *  selection existed — null hides the Selection section. */
  selection: SelectionInfo | null;
  /** `get_records().signs`, fetched once per world load by App. Empty for most worlds. */
  signs: SignInfo[];
  /** `get_records()` in full (27.7): command blocks, trailer status, adopted counts. Null before it loads. */
  records: RecordsInfo | null;
  /** Live Home (`home`, header 16–27) / Start (`pos`, 4–15) in editor XY, null = never set. App
   *  keeps these current through Set Point, so they're never stale the way a one-off fetch is. */
  spawnPos: { px: number; py: number } | null;
  playerPos: { px: number; py: number } | null;
  /** Centre the 2D map on (x, y), zooming in, and aim the live 3D camera there. Pass `z` when the
   *  block layer is known (a sign); omit it and App looks the surface up. */
  onGoTo: (x: number, y: number, z?: number) => void;
  /** The map's current centre for nearest-first sorting, null before the map has mounted. A
   *  getter, not a prop value: the map pans without re-rendering React. */
  viewCenter: () => { x: number; y: number } | null;
  /** The 3D view is live and has reported a camera position at least once. */
  cam3dAvailable: boolean;
  /** Centre the 2D map on the 3D camera (keeps the zoom). */
  onCentreOnCam3d: () => void;
  /** Re-fetch keys for `useWorldInfo` (panels/WorldInfoPanel): every header write bumps `editEpoch`. */
  editEpoch: number;
  /** Case-folded (`normalizePath`) path of the open world, the bookmarks' storage key. Null for a
   *  world that has never been saved: bookmarks are disabled there. */
  worldKey: string | null;
}

const SIGNS_COLLAPSED_COUNT = 5;

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: FONT.body,
  color: TEXT,
  userSelect: "none",
};

const fmtCoord = (n: number) => String(Math.round(n));

/** One Places row: label, coords (or "not set"), and a Go to button. */
function PlaceRow({ label, pos, onGo, title }: {
  label: string; pos: { px: number; py: number } | null; onGo: () => void; title: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minHeight: 24 }}>
      <span style={{ color: TEXT_LABEL, width: 40, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, textAlign: "right", fontFamily: PROP_MONO, fontVariantNumeric: "tabular-nums" }}>
        {pos ? `(${fmtCoord(pos.px)}, ${fmtCoord(pos.py)})` : <span style={{ color: TEXT_META }}>not set</span>}
      </span>
      <SmallButton label="Go to" title={title} disabled={!pos} onClick={onGo} />
    </div>
  );
}

/** Signs explorer body: search + Nearest / A–Z, every row a go-to. Search runs over all signs; only
 *  the rendered slice is truncated. The map pans without re-rendering React, so the "nearest"
 *  centre is read at render and re-read on `resortTick` (the ↻ button, the toggle, and search focus). */
function SignsBody({ signs, viewCenter, worldCentre, onGoTo }: {
  signs: SignInfo[];
  viewCenter: () => { x: number; y: number } | null;
  worldCentre: { x: number; y: number };
  onGoTo: (x: number, y: number, z?: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SignSort>("nearest");
  const [showAll, setShowAll] = useState(false);
  const [resortTick, setResortTick] = useState(0);
  const bump = () => setResortTick(t => t + 1);

  const centre = viewCenter() ?? worldCentre;
  const filtered = useMemo(() => filterSigns(signs, query), [signs, query]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortSigns(filtered, sort, centre), [filtered, sort, resortTick]);
  const visible = showAll ? sorted : sorted.slice(0, SIGNS_COLLAPSED_COUNT);
  const hiddenCount = sorted.length - visible.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, fontSize: FONT.label }}>
      {/* Typing here is safe: App's global shortcuts bail on `isTypingTarget`. */}
      <TextField
        value={query} onChange={setQuery} ariaLabel="Search signs" placeholder="Search signs…"
        onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); e.stopPropagation(); } }}
        style={{ userSelect: "text" }}
      />
      <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
        <SmallButton label="Nearest" title="Closest to the map's centre first"
          active={sort === "nearest"} onClick={() => { setSort("nearest"); bump(); }} />
        <SmallButton label="A–Z" title="Alphabetical by sign text"
          active={sort === "text"} onClick={() => setSort("text")} />
        <span style={{ flex: 1 }} />
        {sort === "nearest" && (
          <SmallButton label="Re-sort" title="Re-measure from the map's current centre" onClick={bump} />
        )}
      </div>
      {query.trim() && (
        <div style={{ color: TEXT_META, fontSize: FONT.micro }}>{sorted.length} of {signs.length} match</div>
      )}
      {visible.map((s, i) => (
        <div key={`${s.x},${s.y},${s.z},${i}`}
          role="button" tabIndex={0}
          onClick={() => onGoTo(s.x, s.y, s.z)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onGoTo(s.x, s.y, s.z); } }}
          title="Go to this sign (map, and the 3D view when it's open)"
          style={{
            padding: "4px 6px", borderRadius: RADIUS.md,
            background: `rgba(${hexToRgbTriplet(ACCENT.warm)},.10)`,
            boxShadow: `inset 0 0 0 1px rgba(${hexToRgbTriplet(ACCENT.warm)},.30)`,
            cursor: "pointer",
          }}>
          <div style={{ color: TEXT, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {s.text || <span style={{ color: TEXT_META, fontStyle: "italic" }}>(empty)</span>}
          </div>
          <div style={{ color: TEXT_LABEL, fontSize: FONT.micro, marginTop: 2, fontFamily: PROP_MONO }}>
            ({Math.round(s.x)}, {Math.round(s.y)}, {s.z}) · {Math.round(signDistance(s, centre)).toLocaleString()} blocks · facing {s.c}
          </div>
        </div>
      ))}
      {sorted.length === 0 && <div style={{ color: TEXT_META, textAlign: "center", padding: "4px 0" }}>No signs match.</div>}
      {sorted.length > SIGNS_COLLAPSED_COUNT && (
        <div
          role="button" tabIndex={0}
          onClick={() => setShowAll(v => !v)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowAll(v => !v); } }}
          style={{
            textAlign: "center", padding: "3px 0", cursor: "pointer", userSelect: "none",
            color: TEXT_LABEL, fontSize: FONT.micro,
          }}
        >
          {showAll ? "Show less" : `Show ${hiddenCount} more…`}
        </div>
      )}
    </div>
  );
}

/** One line of a command block's script for a list row: first non-empty line, cut with "…". */
export function scriptPreview(script: string, max = 60): string {
  const first = script.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const multi = script.split("\n").filter((l) => l.trim() !== "").length > 1;
  return first.length > max ? `${first.slice(0, max)}…` : multi ? `${first} …` : first;
}

/** Command-blocks body (27.7, read-only): search + Nearest / A–Z, every row a go-to. Also carries the
 *  opaque-trailer reason and the adopted-sidecar notice, which concern signs too. */
function CmdsBody({ records, viewCenter, worldCentre, onGoTo }: {
  records: RecordsInfo;
  viewCenter: () => { x: number; y: number } | null;
  worldCentre: { x: number; y: number };
  onGoTo: (x: number, y: number, z?: number) => void;
}) {
  const cmds = records.cmds;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SignSort>("nearest");
  const [showAll, setShowAll] = useState(false);
  const [resortTick, setResortTick] = useState(0);
  const bump = () => setResortTick(t => t + 1);
  const textOf = (c: CmdInfo) => c.script;

  const centre = viewCenter() ?? worldCentre;
  const filtered = useMemo(() => filterSigns(cmds, query, textOf), [cmds, query]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortSigns(filtered, sort, centre, textOf), [filtered, sort, resortTick]);
  const visible = showAll ? sorted : sorted.slice(0, SIGNS_COLLAPSED_COUNT);
  const hiddenCount = sorted.length - visible.length;
  const adopted = records.adopted;
  const adoptedParts = [
    adopted.signs > 0 ? `${adopted.signs} sign${adopted.signs === 1 ? "" : "s"}` : "",
    adopted.cmds > 0 ? `${adopted.cmds} command block${adopted.cmds === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, fontSize: FONT.label }}>
      {records.status === "opaque" && (
        <div style={{ color: TEXT_META, fontSize: FONT.micro }}>
          This world's record data is kept as is and can't be read or edited{records.why ? `: ${records.why}` : "."}
        </div>
      )}
      {adoptedParts && (
        <div style={{ color: TEXT_META, fontSize: FONT.micro }}>
          {adoptedParts} came from the game's side files and will be saved into this world.
        </div>
      )}
      {cmds.length === 0 && records.status !== "opaque" && (
        <div style={{ color: TEXT_META, textAlign: "center", padding: "4px 0" }}>No command blocks in this world.</div>
      )}
      {cmds.length > 0 && (
        <>
          <TextField
            value={query} onChange={setQuery} ariaLabel="Search command blocks" placeholder="Search scripts…"
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); e.stopPropagation(); } }}
            style={{ userSelect: "text" }}
          />
          <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
            <SmallButton label="Nearest" title="Closest to the map's centre first"
              active={sort === "nearest"} onClick={() => { setSort("nearest"); bump(); }} />
            <SmallButton label="A–Z" title="Alphabetical by script"
              active={sort === "text"} onClick={() => setSort("text")} />
            <span style={{ flex: 1 }} />
            {sort === "nearest" && (
              <SmallButton label="Re-sort" title="Re-measure from the map's current centre" onClick={bump} />
            )}
          </div>
          {query.trim() && (
            <div style={{ color: TEXT_META, fontSize: FONT.micro }}>{sorted.length} of {cmds.length} match</div>
          )}
          {visible.map((c) => (
            <div key={`${c.i}`}
              role="button" tabIndex={0}
              onClick={() => onGoTo(c.x, c.y, c.z)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onGoTo(c.x, c.y, c.z); } }}
              title="Go to this command block (map, and the 3D view when it's open)"
              style={{
                padding: "4px 6px", borderRadius: RADIUS.md,
                background: `rgba(${hexToRgbTriplet(MAP.command)},.10)`,
                boxShadow: `inset 0 0 0 1px rgba(${hexToRgbTriplet(MAP.command)},.30)`,
                cursor: "pointer",
              }}>
              <div style={{ color: TEXT, fontFamily: PROP_MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {scriptPreview(c.script) || <span style={{ color: TEXT_META, fontStyle: "italic" }}>(empty)</span>}
              </div>
              <div style={{ color: TEXT_LABEL, fontSize: FONT.micro, marginTop: 2, fontFamily: PROP_MONO }}>
                ({Math.round(c.x)}, {Math.round(c.y)}, {c.z}) · {Math.round(signDistance(c, centre)).toLocaleString()} blocks
              </div>
            </div>
          ))}
          {sorted.length === 0 && <div style={{ color: TEXT_META, textAlign: "center", padding: "4px 0" }}>No command blocks match.</div>}
          {sorted.length > SIGNS_COLLAPSED_COUNT && (
            <div
              role="button" tabIndex={0}
              onClick={() => setShowAll(v => !v)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowAll(v => !v); } }}
              style={{ textAlign: "center", padding: "3px 0", cursor: "pointer", userSelect: "none", color: TEXT_LABEL, fontSize: FONT.micro }}
            >
              {showAll ? "Show less" : `Show ${hiddenCount} more…`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Per-world bookmarks: add the map's current centre, click to go, double-click the name to rename. */
function BookmarksBody({ worldKey, viewCenter, onGoTo }: {
  worldKey: string | null;
  viewCenter: () => { x: number; y: number } | null;
  onGoTo: (x: number, y: number, z?: number) => void;
}) {
  const [list, setList] = useState<Bookmark[]>(() => loadBookmarks(worldKey));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => { setList(loadBookmarks(worldKey)); setEditing(null); }, [worldKey]);
  const commit = (next: Bookmark[]) => { setList(next); saveBookmarks(worldKey, next); };
  const finishRename = (id: string) => { commit(renameBookmark(list, id, draft)); setEditing(null); };

  if (!worldKey) {
    return <div style={{ color: TEXT_META }}>Save the world to keep bookmarks.</div>;
  }
  const centre = viewCenter();
  return (
    <>
      {list.map(b => (
        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minHeight: 24 }}>
          {editing === b.id ? (
            <TextField value={draft} onChange={setDraft} ariaLabel="Bookmark name" maxLength={40}
              style={{ flex: 1, userSelect: "text" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename(b.id);
                else if (e.key === "Escape") { setEditing(null); e.stopPropagation(); }
              }} />
          ) : (
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title="Double-click to rename"
              onDoubleClick={() => { setEditing(b.id); setDraft(b.name); }}>
              {b.name}
            </span>
          )}
          <span style={{ color: TEXT_META, fontFamily: PROP_MONO, fontSize: FONT.micro }}>({b.x}, {b.y})</span>
          {editing === b.id
            ? <SmallButton label="OK" title="Save the new name" onClick={() => finishRename(b.id)} />
            : <SmallButton label="Go to" title="Centre the map (and the 3D view) here" onClick={() => onGoTo(b.x, b.y)} />}
          <SmallButton label="✕" title="Delete this bookmark" onClick={() => commit(deleteBookmark(list, b.id))} />
        </div>
      ))}
      <SmallButton label="+ Add current view"
        title={list.length >= MAX_BOOKMARKS ? `Limit of ${MAX_BOOKMARKS} bookmarks` : "Bookmark the map's current centre"}
        disabled={!centre || list.length >= MAX_BOOKMARKS}
        onClick={() => { const c = viewCenter(); if (c) commit(addBookmark(list, c.x, c.y)); }} />
    </>
  );
}

export default function WorldTab({
  selection: sel, signs, records, spawnPos, playerPos, onGoTo, viewCenter, cam3dAvailable, onCentreOnCam3d, editEpoch,
  worldKey,
}: WorldTabProps) {
  const { info } = useWorldInfo(editEpoch, 200);
  const worldCentre = info
    ? { x: (info.width_chunks * 16) / 2, y: (info.height_chunks * 16) / 2 }
    : { x: 0, y: 0 };

  return (
    <div style={panelStyle}>
      {/* Only what the status bar's selection readout (W×H, Z range, shaped cells) doesn't show. */}
      {sel && (
        <Section id="selection" title="Selection" meta={`${sel.width}×${sel.height}×${sel.depth}`}>
          <PropGrid rows={[
            { label: "Bounds", value: `x${sel.x1}–${sel.x2} y${sel.y1}–${sel.y2}` },
            {
              label: "Volume",
              value: selectionVolume(sel).toLocaleString(),
              title: sel.masked ? "Blocks inside the selected shape, not its bounding box" : undefined,
            },
          ]} />
        </Section>
      )}

      <Section id="world" title="World">
        {info ? (
          <PropGrid rows={[
            { label: "Format", value: formatLabel(info).label, title: formatLabel(info).title },
            { label: "Size", value: `${info.width_chunks * 16} × ${info.height_chunks * 16} blocks` },
            { label: "Height", value: `${info.max_z + 1} layers`, title: `Z 0–${info.max_z}` },
            { label: "Chunks saved", value: `${info.chunk_count} of ${info.width_chunks * info.height_chunks}` },
            { label: "Golden cubes", value: info.golden_cubes.toLocaleString() },
          ]} />
        ) : (
          <div style={{ color: TEXT_META }}>Loading…</div>
        )}
      </Section>

      {/* Live spawnPos/playerPos props, not info.home/pos: those only refresh on the debounce. No z
          is passed, so App looks the surface up. */}
      <Section id="places" title="Places">
        <PlaceRow label="Home" pos={spawnPos} title="Centre the map (and the 3D view) on Home"
          onGo={() => spawnPos && onGoTo(spawnPos.px, spawnPos.py)} />
        <PlaceRow label="Start" pos={playerPos} title="Centre the map (and the 3D view) on the Start position"
          onGo={() => playerPos && onGoTo(playerPos.px, playerPos.py)} />
        {cam3dAvailable && (
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minHeight: 24 }}>
            <span style={{ color: TEXT_LABEL, flex: 1 }}>3D camera</span>
            <SmallButton label="Centre map" title="Centre the 2D map on the 3D camera" onClick={onCentreOnCam3d} />
          </div>
        )}
        <BookmarksBody worldKey={worldKey} viewCenter={viewCenter} onGoTo={onGoTo} />
      </Section>

      {signs.length > 0 && (
        <Section id="signs" title="Signs" meta={String(signs.length)}>
          <SignsBody signs={signs} viewCenter={viewCenter} worldCentre={worldCentre} onGoTo={onGoTo} />
        </Section>
      )}

      {records && (
        <Section id="cmds" title="Command blocks" meta={String(records.cmds.length)}>
          <CmdsBody records={records} viewCenter={viewCenter} worldCentre={worldCentre} onGoTo={onGoTo} />
        </Section>
      )}
    </div>
  );
}
