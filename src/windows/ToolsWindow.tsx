/**
 * The **Tools** window (UI redesign r3, Stage 14.3) — the six-button quick-tools pane that used to
 * be `LeftToolbar.tsx`, now a floating window like the others. Its own collapse badge and
 * single-icon collapsed state are gone: window-shade collapse (title-bar button / double-click)
 * replaces them, and the window's ✕ / View ▸ Windows ▸ Tools / ⌥T replace the old View-tab toggle.
 *
 * Illustrator-style tool families: click to arm the last-used (or default) variant, press-and-hold
 * to pop a menu of the alternatives (the `Popover` is portaled, so it escapes the window layer).
 * The grid reflows 2×3 / 3×2 / 6×1 / 1×6 to the window's shape (`toolsGridCols`); the buttons are
 * the ribbon's `IconButton`s and never scale.
 */
import { useCallback, useRef, useState } from "react";
import type { Tool } from "../MapCanvas";
import { IconButton, MenuItem, Popover } from "../ribbon/primitives";
import { SPACE, SURFACE } from "../ribbon/tokens";
import type { IconName } from "../ribbon/icons";
import FloatingWindow from "./FloatingWindow";
import { TOOL_CELL, TOOL_GAP, TOOL_PAD, toolsGridCols } from "./windowGeometry";

const HOLD_MS = 350;

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

export default function ToolsWindow({ tool, setTool }: { tool: Tool; setTool: (t: Tool) => void }) {
  const [lastVariant, setLastVariantState] = useState<Record<string, Tool>>({});
  const setLastVariant = (familyId: string, t: Tool) =>
    setLastVariantState(prev => (prev[familyId] === t ? prev : { ...prev, [familyId]: t }));

  // Reflow to the body's live size (a resize drag resizes the body imperatively, so a
  // ResizeObserver, not the store's committed rect, is what keeps the grid in step with it).
  // A callback ref, not an effect: the body unmounts while the window is collapsed and remounts
  // on expand, and the observer has to follow the element, not this component's lifetime.
  const [cols, setCols] = useState(2);
  const roRef = useRef<ResizeObserver | null>(null);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const measure = () => {
      const next = toolsGridCols(el.clientWidth, el.clientHeight);
      setCols(c => (c === next ? c : next));
    };
    measure();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(el);
  }, []);

  return (
    <FloatingWindow id="tools" title="Tools" icon="toolbar" dataTour="left-toolbar">
      <div ref={bodyRef} style={{
        flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: TOOL_PAD, background: SURFACE.popover, overflow: "hidden",
      }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${TOOL_CELL}px)`, gap: TOOL_GAP }}>
          {FAMILIES.map(family => (
            <FamilyButton
              key={family.id} family={family} tool={tool} setTool={setTool}
              lastVariant={lastVariant[family.id]}
              setLastVariant={(t) => setLastVariant(family.id, t)}
            />
          ))}
        </div>
      </div>
    </FloatingWindow>
  );
}
