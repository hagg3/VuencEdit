/**
 * The docked right-edge sidebar — Inspector / Prefabs / History.
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
  ACCENT, BORDER, FONT, HAIRLINE, RADIUS, SPACE, SURFACE, TEXT, TEXT_DIM, TEXT_DISABLED,
  TEXT_LABEL, btnBase, hexToRgbTriplet,
} from "./ribbon/tokens";
import SelectionInspector from "./SelectionInspector";
import PrefabLibraryPanel from "./PrefabLibraryPanel";
import type { SelectionInfo, ClipboardInfo, SignInfo } from "./types";

export type SidebarTab = "inspector" | "prefabs" | "history";

const TABS: { id: SidebarTab; label: string; icon: IconName }[] = [
  // Inspector reads out the *selection*, so it carries the selection glyph rather than a generic
  // "info" one — same command, same icon, wherever it appears.
  { id: "inspector", label: "Inspector", icon: "select" },
  { id: "prefabs", label: "Prefabs", icon: "prefabLibrary" },
  { id: "history", label: "History", icon: "history" },
];

/** Section heading shared by the History and Signs lists — the ribbon's `FieldLabel` treatment. */
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
    let cancelled = false;
    invoke<UndoStackInfo>("list_undo_stack")
      .then((r) => { if (!cancelled) setInfo(r); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [editEpoch, worldEpoch]);

  const rowStyle = (highlight: boolean): React.CSSProperties => ({
    padding: "3px 6px", borderRadius: RADIUS.md, fontSize: FONT.body,
    color: highlight ? TEXT : TEXT_DIM,
    background: highlight ? `rgba(${hexToRgbTriplet(ACCENT.primary)},.16)` : "transparent",
    boxShadow: highlight ? `inset 0 0 0 1px rgba(${hexToRgbTriplet(ACCENT.primary)},.35)` : undefined,
  });

  if (!info) return <div style={{ color: TEXT_DISABLED, fontSize: FONT.body }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg + 2, fontSize: FONT.body }}>
      <div>
        <div style={{ marginBottom: SPACE.sm }}><SectionLabel>UNDO STACK</SectionLabel></div>
        {info.undo.length === 0 ? (
          <div style={{ color: TEXT_DISABLED }}>Nothing to undo.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column-reverse", gap: 1 }}>
            {info.undo.map((label, i) => (
              <div key={i} style={rowStyle(i === info.undo.length - 1)}>{label}</div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div style={{ marginBottom: SPACE.sm }}><SectionLabel>REDO STACK</SectionLabel></div>
        {info.redo.length === 0 ? (
          <div style={{ color: TEXT_DISABLED }}>Nothing to redo.</div>
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
const SIGNS_COLLAPSED_COUNT = 3;

function SignsList({ signs, onSignClick }: { signs: SignInfo[]; onSignClick?: (s: SignInfo) => void }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (signs.length === 0) return null;
  const visible = showAll ? signs : signs.slice(0, SIGNS_COLLAPSED_COUNT);
  const hiddenCount = signs.length - visible.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, fontSize: FONT.body, marginBottom: SPACE.lg + 2 }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: SPACE.sm, cursor: "pointer", userSelect: "none" }}
      >
        <Icon name={open ? "expandBar" : "right"} size={FONT.body} tone="default" />
        <SectionLabel>SIGNS ({signs.length})</SectionLabel>
      </div>
      {open && <>
        {visible.map((s, i) => (
          <div key={i}
            onClick={onSignClick ? () => onSignClick(s) : undefined}
            title={onSignClick ? "Click to centre the map on this sign" : undefined}
            style={{
              padding: "4px 6px", borderRadius: RADIUS.md,
              background: `rgba(${hexToRgbTriplet(ACCENT.warm)},.10)`,
              boxShadow: `inset 0 0 0 1px rgba(${hexToRgbTriplet(ACCENT.warm)},.30)`,
              cursor: onSignClick ? "pointer" : "default",
            }}>
            <div style={{ color: TEXT, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {s.text || <span style={{ color: TEXT_DISABLED, fontStyle: "italic" }}>(empty)</span>}
            </div>
            <div style={{ color: TEXT_LABEL, fontSize: FONT.label, marginTop: 2 }}>
              ({Math.round(s.x)}, {Math.round(s.y)}, {s.z}) · facing {s.facing}
            </div>
          </div>
        ))}
        {signs.length > SIGNS_COLLAPSED_COUNT && (
          <div
            onClick={() => setShowAll(v => !v)}
            style={{
              textAlign: "center", padding: "3px 0", cursor: "pointer", userSelect: "none",
              color: TEXT_LABEL, fontSize: FONT.label,
            }}
          >
            {showAll ? "Show less" : `Show ${hiddenCount} more…`}
          </div>
        )}
      </>}
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

  const contentWidth = p.width - PAD * 2;

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

      {/* Tab strip. `role="tablist"` + the ribbon's own armed treatment (accent underline, lit
          icon) rather than the old bespoke `glassTab`, so a selected sidebar tab reads the same
          way a selected ribbon tab does. */}
      <div className="eden-ribbon" role="tablist" aria-label="Sidebar panels" style={{
        display: "flex", alignItems: "stretch", background: SURFACE.topbar,
        boxShadow: `inset 0 -1px 0 ${HAIRLINE}`,
      }}>
        {TABS.map((t) => {
          const on = p.tab === t.id;
          return (
            <button
              key={t.id} className="rbn-tab" type="button" role="tab" aria-selected={on}
              data-active={on ? "true" : undefined} data-tab={t.id}
              onClick={() => p.onTabChange(t.id)}
              title={t.label}
              style={btnBase({
                flex: 1, height: 28, padding: 0, borderRadius: 0, background: "none",
                boxShadow: on ? `inset 0 -2px 0 ${ACCENT.primary}` : "none",
                display: "flex", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
                color: on ? TEXT : TEXT_LABEL, fontWeight: on ? 700 : 400, fontSize: FONT.body,
              })}
            >
              <Icon name={t.icon} size={13} tone={on ? "accent" : "default"} />
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
