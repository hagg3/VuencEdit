import { useRef, useState } from "react";
import type { Tool } from "./MapCanvas";
import { IconButton, MenuItem, Popover } from "./ribbon/primitives";
import { BORDER, COL_GAP, RADIUS, SMALL_H, SPACE, SURFACE } from "./ribbon/tokens";
import { Icon, type IconName } from "./ribbon/icons";

const HOLD_MS = 350;
/** Raw localStorage key, not an `AppSettings` field — mirrors the `ribbon_collapsed` idiom
 *  (CLAUDE.md's UI Shell notes): a lightweight per-session UI preference, not schema-migrated. */
const COLLAPSE_KEY = "left_toolbar_collapsed";

interface Variant {
  tool: Tool;
  icon: IconName;
  label: string;
}

interface Family {
  id: string;
  variants: Variant[];
}

/**
 * Illustrator-style tool families: click the button to arm the last-used (or default) variant,
 * press-and-hold to pop a menu of the alternatives. Two single-tool entries (Pan, Eyedropper) have
 * no variants and just arm directly. Kept to six entries (three rows of two) — a quick-access rail
 * next to the Draw/Sculpt tabs, not a duplicate of them.
 */
const FAMILIES: Family[] = [
  { id: "pan", variants: [{ tool: "pan", icon: "pan", label: "Pan" }] },
  {
    id: "select",
    variants: [
      { tool: "select", icon: "select", label: "Select" },
      { tool: "wand", icon: "wand", label: "Magic Wand" },
      { tool: "lasso", icon: "lasso", label: "Lasso" },
    ],
  },
  {
    id: "draw",
    variants: [
      { tool: "pen", icon: "pen", label: "Pen" },
      { tool: "brush", icon: "brush", label: "Brush" },
      { tool: "spray", icon: "spray", label: "Spray" },
    ],
  },
  {
    id: "shape",
    variants: [
      { tool: "rect", icon: "rect", label: "Rectangle" },
      { tool: "ellipse", icon: "ellipse", label: "Ellipse" },
      { tool: "line", icon: "line", label: "Line" },
      { tool: "polygon", icon: "polygon", label: "Polygon" },
    ],
  },
  { id: "eyedropper", variants: [{ tool: "eyedropper", icon: "eyedropper", label: "Eyedropper" }] },
  {
    id: "fill",
    variants: [
      { tool: "fill", icon: "bucket", label: "Fill" },
      { tool: "poolfill", icon: "poolFill", label: "Pool Fill" },
    ],
  },
];

function FamilyButton({
  family, tool, setTool, lastVariant, setLastVariant,
}: {
  family: Family;
  tool: Tool;
  setTool: (t: Tool) => void;
  lastVariant: Tool | undefined;
  setLastVariant: (t: Tool) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);
  const [open, setOpen] = useState(false);

  const active = family.variants.some(v => v.tool === tool);
  const armed = family.variants.find(v => v.tool === tool)
    ?? family.variants.find(v => v.tool === lastVariant)
    ?? family.variants[0];
  const hasVariants = family.variants.length > 1;

  const clearTimer = () => {
    if (holdTimer.current != null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  const onPointerDown = () => {
    if (!hasVariants) return;
    held.current = false;
    clearTimer();
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setOpen(true);
    }, HOLD_MS);
  };

  const onPointerUp = () => {
    clearTimer();
    if (held.current) return; // the hold already opened the flyout — let the user pick from it
    setTool(armed.tool);
    setLastVariant(armed.tool);
  };

  const onPointerLeave = () => {
    // Pointer wandered off mid-press: cancel the pending hold and treat it as no gesture at all
    // (not a click) rather than firing a tool change the user never actually released over.
    clearTimer();
    held.current = false;
  };

  const title = hasVariants
    ? `${armed.label} (hold for ${family.variants.filter(v => v !== armed).map(v => v.label).join(", ")})`
    : armed.label;

  return (
    <div
      ref={ref}
      style={{ position: "relative", userSelect: "none" }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <IconButton
        icon={armed.icon} label={armed.label} title={title} active={active}
        onClick={!hasVariants ? () => setTool(armed.tool) : undefined}
      />
      {open && (
        <Popover anchorRef={ref} onClose={() => setOpen(false)} align="left" ariaLabel={`${armed.label} variants`}>
          <div style={{ display: "flex", flexDirection: "column", padding: SPACE.xs, minWidth: 140 }}>
            {family.variants.map(v => (
              <MenuItem
                key={v.tool} icon={v.icon} label={v.label} active={v.tool === tool}
                onClick={() => { setTool(v.tool); setLastVariant(v.tool); setOpen(false); }}
              />
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

export interface LeftToolbarProps {
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Top offset (px): below the ribbon and, when it's visible, the Quick Actions bar — App computes
   *  this (`effectiveRibbonHeight` + `QUICK_ACTIONS_BAR_H` when shown), not this component. */
  top: number;
}

const panelShell = {
  position: "fixed" as const, left: SPACE.lg, zIndex: 60,
  background: SURFACE.popover,
  boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 6px 16px rgba(0,0,0,.35)`,
  borderRadius: RADIUS.lg,
};

/**
 * Floating Illustrator-style tool palette — quick-access rail built from the ribbon's own
 * `IconButton`/`Popover`/`MenuItem` primitives (not `designTokens.glassPanel`, which is the
 * app-wide modal material the docked right `Sidebar` uses). Two columns, three rows, six families.
 *
 * Deliberately **not** a full-height docked rail like `Sidebar`: at six buttons the content is a
 * ~90px-tall card, so anchoring it top-to-bottom against the left edge (the first cut of this
 * component) left most of the window as dead reserved space down the left side. Floating below the
 * ribbon/Quick-Actions strip instead sizes it to its own content and never reserves canvas width —
 * same idiom as `QuickActionsBar`, which already floats over the map rather than inset it.
 *
 * Two independent ways to get it out of the way: the View tab's "Toolbar" toggle unmounts it
 * entirely (persisted in `AppSettings.leftToolbarOpen`), while the chevron in its own corner
 * collapses it to a single icon-sized handle for a quick "shrink but keep it reachable" (persisted
 * to the raw `left_toolbar_collapsed` key, mirroring the ribbon's own `ribbon_collapsed` idiom —
 * a per-session UI preference, not schema state worth a settings migration).
 */
export default function LeftToolbar({ tool, setTool, top }: LeftToolbarProps) {
  const [lastVariant, setLastVariantState] = useState<Record<string, Tool>>({});
  const setLastVariant = (familyId: string, t: Tool) =>
    setLastVariantState(prev => (prev[familyId] === t ? prev : { ...prev, [familyId]: t }));

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(v => {
    const next = !v;
    try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });

  if (collapsed) {
    return (
      <div style={{ ...panelShell, top, padding: 2 }}>
        <IconButton icon="toolbar" label="Show tool rail" title="Show tool rail" onClick={toggleCollapsed} />
      </div>
    );
  }

  // The minimise control is a small corner badge overlapping the card, not a dedicated header row —
  // a full 26px row above a 78px (3-row) grid was a third of the card's height spent on one control.
  const MINI = 14;
  return (
    <div data-tour="left-toolbar" style={{ ...panelShell, top, padding: SPACE.sm }}>
      <button
        type="button" title="Minimise" aria-label="Minimise tool rail" onClick={toggleCollapsed}
        style={{
          position: "absolute", top: -6, right: -6, width: MINI, height: MINI, padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
          borderRadius: RADIUS.sm, border: "none", background: SURFACE.raised,
          boxShadow: `inset 0 0 0 1px ${BORDER.outline}`, color: "inherit",
        }}
      >
        <Icon name="collapse" size={9} tone="default" />
      </button>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(2, ${SMALL_H}px)`, gap: COL_GAP }}>
        {FAMILIES.map(family => (
          <FamilyButton
            key={family.id} family={family} tool={tool} setTool={setTool}
            lastVariant={lastVariant[family.id]}
            setLastVariant={(t) => setLastVariant(family.id, t)}
          />
        ))}
      </div>
    </div>
  );
}
