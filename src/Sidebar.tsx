/**
 * The docked right-edge sidebar — World / Prefabs / History.
 *
 * Restyled onto `ribbon/tokens` + `ribbon/icons` (audit H10 step 3). It used to be the app's third
 * competing visual system: warm-brown `glassPanel`/`glassTab`, text-only tabs, and its own eight
 * hard-coded greys, sitting flush against a cool-slate ribbon. Nothing about the layout changed —
 * same widths, same drag-resize, same collapse rail — only the material, the type tones and the
 * tab glyphs.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, type IconName } from "./ribbon/icons";
import {
  BORDER, FONT, HAIRLINE, RADIUS, SPACE, SURFACE, TEXT, TEXT_DIM, TEXT_META,
  CUR_ICON, currentRow, TEXT_LABEL, btnBase,
} from "./ribbon/tokens";
import WorldTab, { type WorldTabProps } from "./WorldTab";
import PrefabLibraryPanel from "./PrefabLibraryPanel";
import type { ClipboardInfo } from "./types";

export type SidebarTab = "world" | "prefabs" | "history";

const TABS: { id: SidebarTab; label: string; icon: IconName }[] = [
  // World (24.1, was Inspector): a navigator for the whole world, so the globe rather than the
  // selection glyph the Inspector carried.
  { id: "world", label: "World", icon: "world" },
  { id: "prefabs", label: "Prefabs", icon: "prefabLibrary" },
  { id: "history", label: "History", icon: "history" },
];

/** Section heading for the History tab's undo/redo stacks — the ribbon's `FieldLabel` treatment.
 *  (The World tab's own sections use `ui/PropertyGrid`'s `Section` instead, since those are
 *  collapsible and persist their open/closed state — History's two stacks are always both shown.) */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: TEXT_LABEL, fontWeight: 700, fontSize: FONT.label, letterSpacing: "0.08em",
      userSelect: "none",
    }}>{children}</span>
  );
}

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
    // Debounced (HALO_FLUSH_MS idiom): editEpoch bumps once per stamp during a 3D build
    // sweep, and list_undo_stack clones every group's operation String, so fetching per
    // bump is an O(history) round trip per stamp. Trailing-edge only.
    let cancelled = false;
    const t = setTimeout(() => {
      invoke<UndoStackInfo>("list_undo_stack")
        .then((r) => { if (!cancelled) setInfo(r); })
        .catch(() => { if (!cancelled) setInfo(null); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [editEpoch, worldEpoch]);

  // The current history entry (top of the undo stack) is pushed in — the app-wide current-item
  // recipe (Stage 14.2), no accent fill/ring.
  const rowStyle = (current: boolean): React.CSSProperties => ({
    padding: "3px 6px", borderRadius: RADIUS.md, fontSize: FONT.body,
    color: current ? TEXT : TEXT_DIM,
    ...(current ? currentRow() : null),
  });

  if (!info) return <div style={{ color: TEXT_META, fontSize: FONT.body }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg + 2, fontSize: FONT.body }}>
      <div>
        <div style={{ marginBottom: SPACE.sm }}><SectionLabel>UNDO STACK</SectionLabel></div>
        {info.undo.length === 0 ? (
          <div style={{ color: TEXT_META }}>Nothing to undo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column-reverse", gap: 1 }}>
            {info.undo.map((label, i) => (
              <div key={i} style={rowStyle(i === info.undo.length - 1)}
                aria-current={i === info.undo.length - 1 ? "step" : undefined}>{label}</div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div style={{ marginBottom: SPACE.sm }}><SectionLabel>REDO STACK</SectionLabel></div>
        {info.redo.length === 0 ? (
          <div style={{ color: TEXT_META }}>Nothing to redo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {info.redo.map((label, i) => (
              <div key={i} style={rowStyle(false)}>{label}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export interface SidebarProps extends Omit<WorldTabProps, "editEpoch"> {
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

  // Prefabs tab
  onArmPaste: (info: ClipboardInfo) => void;
  onSavePrefabAs: () => void;
  prefabRefreshToken: number;

  // History tab (and the World tab's `useWorldInfo` keys)
  editEpoch: number;
  worldEpoch: number;
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
        style={{
          position: "fixed", top: p.topPx, right: 0, bottom: p.bottomPx, width: COLLAPSED_RAIL,
          zIndex: 120, display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: SPACE.lg, cursor: "pointer",
          background: SURFACE.body,
          boxShadow: `inset 1px 0 0 ${BORDER.outline}, inset 2px 0 0 ${BORDER.bevel}`,
          color: TEXT_DIM,
        }}
        onClick={() => p.onOpenChange(true)}
        title="Open sidebar"
      >
        <Icon name="left" size={14} tone="default" />
      </div>
    );
  }

  return (
    <div data-tour="sidebar" style={{
      position: "fixed", top: p.topPx, right: 0, bottom: p.bottomPx, width: p.width,
      zIndex: 120, display: "flex", flexDirection: "column",
      background: SURFACE.body, color: TEXT, fontSize: FONT.body,
      boxShadow: `inset 1px 0 0 ${BORDER.outline}, inset 2px 0 0 ${BORDER.bevel}, -6px 0 20px rgba(0,0,0,.4)`,
    }}>
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

      {/* Tab strip. `role="tablist"`; the selected tab is **pushed in** (Stage 14.2 — the
          app-wide current-item recipe). The accent underline it used to carry is gone: current
          items carry no accent strips anywhere. Hover is the `.vx-row` lift. */}
      <div className="eden-ribbon" role="tablist" aria-label="Sidebar panels" style={{
        display: "flex", alignItems: "stretch", gap: 3, padding: 3, background: SURFACE.topbar,
        boxShadow: `inset 0 -1px 0 ${HAIRLINE}`,
      }}>
        {TABS.map((t) => {
          const on = p.tab === t.id;
          return (
            <button
              key={t.id} className="vx-row" type="button" role="tab" aria-selected={on}
              data-cur={on ? "" : undefined} data-tab={t.id}
              onClick={() => p.onTabChange(t.id)}
              title={t.label}
              style={btnBase({
                flex: 1, height: 22, padding: 0, borderRadius: RADIUS.md, background: "none",
                boxShadow: "none", textShadow: "none",
                display: "flex", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
                color: on ? TEXT : TEXT_LABEL, fontWeight: on ? 700 : 400, fontSize: FONT.body,
              })}
            >
              <Icon name={t.icon} size={13} tone={on ? "inherit" : "default"} style={on ? { color: CUR_ICON } : undefined} />
              {t.label}
            </button>
          );
        })}
        <button
          className="rbn-btn" type="button"
          onClick={() => p.onOpenChange(false)}
          title="Collapse sidebar" aria-label="Collapse sidebar"
          style={btnBase({
            width: 26, height: 28, padding: 0, borderRadius: 0, background: "none",
            boxShadow: "none", display: "flex", alignItems: "center", justifyContent: "center",
            color: TEXT_LABEL,
          })}
        >
          <Icon name="right" size={13} tone="default" />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: PAD, color: TEXT }}>
        {/* Keyed on the world so a newly opened world never shows the previous one's info while
            its first (debounced) `get_world_info` is in flight. */}
        {p.tab === "world" && (
          <WorldTab
            key={p.worldEpoch}
            selection={p.selection}
            signs={p.signs}
            spawnPos={p.spawnPos}
            playerPos={p.playerPos}
            onGoTo={p.onGoTo}
            viewCenter={p.viewCenter}
            cam3dAvailable={p.cam3dAvailable}
            onCentreOnCam3d={p.onCentreOnCam3d}
            editEpoch={p.editEpoch}
            worldKey={p.worldKey}
          />
        )}
        {p.tab === "prefabs" && (
          <PrefabLibraryPanel
            onClose={() => p.onTabChange("world")}
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
