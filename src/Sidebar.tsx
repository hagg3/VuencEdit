import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EDEN_TEAL_READABLE, glassPanel, glassTab } from "./designTokens";
import SelectionInspector from "./SelectionInspector";
import PrefabLibraryPanel from "./PrefabLibraryPanel";
import type { SelectionInfo, ClipboardInfo, SignInfo } from "./types";

export type SidebarTab = "inspector" | "prefabs" | "history";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "inspector", label: "Inspector" },
  { id: "prefabs", label: "Prefabs" },
  { id: "history", label: "History" },
];

const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const COLLAPSED_RAIL = 28;
const PAD = 10;

interface UndoStackInfo {
  undo: string[];
  redo: string[];
}

/** Read-only undo/redo stack list, most-recent-undo highlighted (it's what ⌘Z would revert next). */
function HistoryTab({ editEpoch, worldEpoch }: { editEpoch: number; worldEpoch: number }) {
  const [info, setInfo] = useState<UndoStackInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<UndoStackInfo>("list_undo_stack")
      .then((r) => { if (!cancelled) setInfo(r); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [editEpoch, worldEpoch]);

  const rowStyle = (highlight: boolean): React.CSSProperties => ({
    padding: "3px 6px", borderRadius: 4, fontSize: 11,
    color: highlight ? EDEN_TEAL_READABLE : "#afa69d",
    background: highlight ? "rgba(0,164,173,0.14)" : "transparent",
  });

  if (!info) return <div style={{ color: "#61584f", fontSize: 11 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 11 }}>
      <div>
        <div style={{ color: "#83786c", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em", marginBottom: 4 }}>UNDO STACK</div>
        {info.undo.length === 0 ? (
          <div style={{ color: "#61584f" }}>Nothing to undo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column-reverse", gap: 1 }}>
            {info.undo.map((label, i) => (
              <div key={i} style={rowStyle(i === info.undo.length - 1)}>{label}</div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div style={{ color: "#83786c", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em", marginBottom: 4 }}>REDO STACK</div>
        {info.redo.length === 0 ? (
          <div style={{ color: "#61584f" }}>Nothing to redo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {info.redo.map((label, i) => (
              <div key={i} style={rowStyle(i === info.redo.length - 1)}>{label}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only sign list (256z-format plan, Phase 4) — shown only when the world actually has
 *  signs, which is the overwhelming minority. `facing` is a strong-but-unproven hypothesis (see
 *  CLAUDE.md's "File Format" section), shown as a raw number rather than decoded further.
 *  Collapsible like the Inspector tab's other sections (elevation view — `SelectionInspector`),
 *  same ▼/▶ header idiom, open by default. */
function SignsList({ signs, onSignClick }: { signs: SignInfo[]; onSignClick?: (s: SignInfo) => void }) {
  const [open, setOpen] = useState(true);
  if (signs.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, marginBottom: 10 }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ color: "#61584f", fontSize: 9 }}>{open ? "▼" : "▶"}</span>
        <span style={{ color: "#83786c", fontWeight: 700, fontSize: 10, letterSpacing: "0.08em" }}>
          SIGNS ({signs.length})
        </span>
      </div>
      {open && signs.map((s, i) => (
        <div key={i}
          onClick={onSignClick ? () => onSignClick(s) : undefined}
          title={onSignClick ? "Click to centre the map on this sign" : undefined}
          style={{
            padding: "4px 6px", borderRadius: 4, background: "rgba(232,192,74,0.10)",
            border: "1px solid rgba(232,192,74,0.25)",
            cursor: onSignClick ? "pointer" : "default",
          }}>
          <div style={{ color: "#ebe9e7", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {s.text || <span style={{ color: "#61584f", fontStyle: "italic" }}>(empty)</span>}
          </div>
          <div style={{ color: "#83786c", fontSize: 10, marginTop: 2 }}>
            ({Math.round(s.x)}, {Math.round(s.y)}, {s.z}) · facing {s.facing}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width: number;
  /** Fired continuously while dragging (for live layout) — caller decides whether/how to persist. */
  onWidthChange: (width: number) => void;
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** Top inset (px) — mirrors `effectiveRibbonHeight`. */
  topPx: number;
  /** Bottom inset (px) — mirrors `STATUS_BAR_HEIGHT`. */
  bottomPx: number;

  // Inspector tab
  selection: SelectionInfo | null;
  clipboard: ClipboardInfo | null;
  quadMode: boolean;

  // Prefabs tab
  onArmPaste: (info: ClipboardInfo) => void;
  onSavePrefabAs: () => void;
  prefabRefreshToken: number;

  // Elevation view — folded into the Inspector tab. Null when there's nothing to show it for.
  elevationSelection: SelectionInfo | null;
  maxZ: number;
  extrudeCount: number;
  extrudeAxis: string;
  isPastePreview: boolean;
  editEpoch: number;
  drawActive: boolean;
  onDrawElevation: (x: number, y: number, z: number) => void;
  onZRangeChange?: (zMin: number, zMax: number) => void;

  // History tab
  worldEpoch: number;

  // Inspector tab — signs (256z-format plan, Phase 4)
  signs: SignInfo[];
  /** Clicking a sign row focuses the 2D map on it. Omitted = rows are inert. */
  onSignClick?: (s: SignInfo) => void;
}

export default function Sidebar(p: SidebarProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Sidebar is anchored to the right edge — dragging left (negative dx) widens it.
      const dx = drag.startX - e.clientX;
      p.onWidthChange(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, drag.startWidth + dx)));
    };
    const onUp = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  if (!p.open) {
    return (
      <div
        style={glassPanel({
          position: "fixed", top: p.topPx, right: 0, bottom: p.bottomPx, width: COLLAPSED_RAIL,
          zIndex: 120, display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: 8, cursor: "pointer",
        })}
        onClick={() => p.onOpenChange(true)}
        title="Open sidebar"
      >
        <span style={{ color: "#83786c", fontSize: 13 }}>◀</span>
      </div>
    );
  }

  const contentWidth = p.width - PAD * 2;

  return (
    <div style={glassPanel({
      position: "fixed", top: p.topPx, right: 0, bottom: p.bottomPx, width: p.width,
      zIndex: 120, display: "flex", flexDirection: "column",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 30px rgba(0,0,0,.35), -6px 0 20px rgba(0,0,0,.4)",
    })}>
      {/* Left-edge drag-resize handle */}
      <div
        title="Drag to resize sidebar"
        onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, startWidth: p.width };
          setDragging(true);
          e.preventDefault();
        }}
        style={{
          position: "absolute", top: 0, bottom: 0, left: -3, width: 6, cursor: "ew-resize", zIndex: 1,
        }}
      />

      <div style={{ display: "flex", alignItems: "stretch", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => p.onTabChange(t.id)}
            style={{
              ...glassTab(p.tab === t.id),
              flex: 1, padding: "7px 0", fontSize: 11, color: p.tab === t.id ? EDEN_TEAL_READABLE : "#83786c",
              fontWeight: p.tab === t.id ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={() => p.onOpenChange(false)}
          title="Collapse sidebar"
          style={{
            background: "none", border: "none", color: "#61584f", fontSize: 12, cursor: "pointer",
            padding: "0 8px",
          }}
        >▶</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: PAD, color: "#ebe9e7" }}>
        {p.tab === "inspector" && (
          <>
          <SignsList signs={p.signs} onSignClick={p.onSignClick} />
          <SelectionInspector
            selection={p.selection}
            clipboard={p.clipboard}
            quadMode={p.quadMode}
            elevationSelection={p.elevationSelection}
            elevationWidth={contentWidth}
            maxZ={p.maxZ}
            extrudeCount={p.extrudeCount}
            extrudeAxis={p.extrudeAxis}
            isPastePreview={p.isPastePreview}
            editEpoch={p.editEpoch}
            drawActive={p.drawActive}
            onDrawElevation={p.onDrawElevation}
            onZRangeChange={p.onZRangeChange}
          />
          </>
        )}
        {p.tab === "prefabs" && (
          <PrefabLibraryPanel
            onClose={() => p.onTabChange("inspector")}
            onArmPaste={p.onArmPaste}
            onSaveAs={p.onSavePrefabAs}
            refreshToken={p.prefabRefreshToken}
          />
        )}
        {p.tab === "history" && <HistoryTab editEpoch={p.editEpoch} worldEpoch={p.worldEpoch} />}
      </div>
    </div>
  );
}
