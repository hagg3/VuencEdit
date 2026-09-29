/**
 * The **Hotbar** window (UI redesign r3, Stage 14.5) — 11 cells: ▣ (opens the shared block/paint
 * picker) + 5 pinned (keys 1–5) + 5 recent (keys 6–0, dashed outline). Pin/unpin affordance ported
 * from `PaletteGroup`'s old `HotbarRow`; the underlying state is `useHotbar()` (`src/hotbar/
 * useHotbar.ts`), owned by App and passed in so the digit-key handler and this window share one
 * source of truth.
 *
 * Reflows 1 row / 2 rows / a column to the body's live size (`hotbarGrid`, the same
 * ResizeObserver-callback-ref idiom as `ToolsWindow`'s tools grid).
 */
import { useCallback, useRef, useState } from "react";
import { blockDisplayName, resolveColor } from "../blockDefs";
import { tintedSwatch, type AtlasData } from "../texturePack";
import type { HotbarSlot, UseHotbarResult } from "../hotbar/useHotbar";
import { usePickerHost } from "../picker/PickerHost";
import { Icon } from "../ribbon/icons";
import { Swatch } from "../ribbon/primitives";
import { ACCENT, FONT, RADIUS, SURFACE, TEXT, currentRow } from "../ribbon/tokens";
import { RAMP } from "../theme/theme";
import FloatingWindow from "./FloatingWindow";
import { HOTBAR_GAP, HOTBAR_PAD, hotbarGrid } from "./windowGeometry";

export interface HotbarWindowProps {
  hotbar: UseHotbarResult;
  fillBlockType: number;
  fillPaint: number;
  setFillBlockType: (v: number) => void;
  setFillPaint: (v: number) => void;
  texturePack?: AtlasData | null;
}

function swatchColor(b: HotbarSlot, texturePack?: AtlasData | null): { color: string; url: string | null } {
  if (!b) return { color: "rgba(255,255,255,.03)", url: null };
  const [r, g, bl] = resolveColor(b.type, b.paint);
  return { color: `rgb(${r},${g},${bl})`, url: texturePack ? tintedSwatch(b.type, b.paint, texturePack) : null };
}

export default function HotbarWindow({
  hotbar, fillBlockType, fillPaint, setFillBlockType, setFillPaint, texturePack,
}: HotbarWindowProps) {
  const { pinnedBlocks, recentBlocks, hotbarHover, setHotbarHover, pinFromRecent, unpinSlot } = hotbar;
  const { togglePicker } = usePickerHost();
  const name = `${blockDisplayName(fillBlockType)}${fillPaint > 0 ? ` #${fillPaint}` : ""}`;

  const [grid, setGrid] = useState({ cols: 6, size: 40 });
  const roRef = useRef<ResizeObserver | null>(null);
  // Callback ref, not an effect: the body unmounts while collapsed and remounts on expand, and the
  // observer has to follow the element, not this component's lifetime (mirrors `ToolsWindow`).
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const measure = () => {
      const next = hotbarGrid(el.clientWidth, el.clientHeight);
      setGrid(g => (g.cols === next.cols && g.size === next.size ? g : next));
    };
    measure();
    roRef.current = new ResizeObserver(measure);
    roRef.current.observe(el);
  }, []);

  const recent: HotbarSlot[] = [...recentBlocks, null, null, null, null, null].slice(0, 5);
  const isActive = (b: HotbarSlot) => !!b && b.type === fillBlockType && b.paint === fillPaint;

  return (
    <FloatingWindow id="hotbar" title="Hotbar" icon="block" meta={name} dataTour="hotbar">
      <div ref={bodyRef} style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        padding: HOTBAR_PAD, background: SURFACE.popover, overflow: "hidden",
      }}>
        <div className="hb-grid" style={{
          display: "grid", gridTemplateColumns: `repeat(${grid.cols}, ${grid.size}px)`, gap: HOTBAR_GAP,
        }}>
          {/* ▣ — opens the shared block/paint picker, anchored on this cell. */}
          <button
            type="button"
            onClick={e => togglePicker(e, "block-draw")}
            title={`Active block: ${name} — click to browse all blocks & paints`}
            aria-label="Open block & paint picker"
            style={{
              width: grid.size, height: grid.size, flexShrink: 0, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: SURFACE.well, border: `1px solid rgba(255,255,255,.14)`, borderRadius: RADIUS.md,
              color: TEXT,
            }}
          >
            <Icon name="block" size={Math.min(20, grid.size - 12)} tone="default" />
          </button>

          {pinnedBlocks.map((b, i) => (
            <HotbarCell
              key={`pinned-${i}`} kind="pinned" index={i} block={b} size={grid.size}
              active={isActive(b)} hovered={hotbarHover === `pinned-${i}`}
              texturePack={texturePack}
              onHover={setHotbarHover}
              onSelect={() => { if (b) { setFillBlockType(b.type); setFillPaint(b.paint); } }}
              onPinToggle={() => unpinSlot(i)}
              alreadyPinned={false}
            />
          ))}
          {recent.map((b, i) => {
            const alreadyPinned = b != null && pinnedBlocks.some(pb => pb && pb.type === b.type && pb.paint === b.paint);
            return (
              <HotbarCell
                key={`recent-${i}`} kind="recent" index={i} block={b} size={grid.size}
                active={isActive(b)} hovered={hotbarHover === `recent-${i}`}
                texturePack={texturePack}
                onHover={setHotbarHover}
                onSelect={() => { if (b) { setFillBlockType(b.type); setFillPaint(b.paint); } }}
                onPinToggle={() => { if (b && !alreadyPinned) pinFromRecent(b); }}
                alreadyPinned={alreadyPinned}
              />
            );
          })}
        </div>
      </div>
    </FloatingWindow>
  );
}

/** One pinned/recent slot: digit label top-left, hover pin/unpin affordance, a pushed-in current
 *  recipe + primary ring when it's the active block. */
function HotbarCell({
  kind, index, block, size, active, hovered, texturePack, onHover, onSelect, onPinToggle, alreadyPinned,
}: {
  kind: "pinned" | "recent";
  index: number;
  block: HotbarSlot;
  size: number;
  active: boolean;
  hovered: boolean;
  texturePack?: AtlasData | null;
  onHover: (key: string | null) => void;
  onSelect: () => void;
  onPinToggle: () => void;
  alreadyPinned: boolean;
}) {
  const key = `${kind}-${index}`;
  const digit = kind === "pinned" ? String(index + 1) : index === 4 ? "0" : String(index + 6);
  const { color, url } = swatchColor(block, texturePack);
  // Pushed-in current recipe (`currentRow()`, ribbon/tokens — the same "current item" recipe as
  // app-menu rows/sidebar tabs/History's current entry) plus a 2px primary inner ring layered on
  // top (mock `.hb-slot[data-sel]`) — the ring is what a bare `currentRow()` can't express on its
  // own, since CLAUDE.md's "no accent strips or underlines on current items" rule is about a strip
  // *beside* the row, not a ring *around* the selected slot the way an armed tool gets one.
  // Composed manually (not `currentRow({boxShadow: …})`) because that helper's `extra` replaces
  // the shadow outright rather than layering onto it.
  const cur = currentRow();
  const selectedShadow = `${cur.boxShadow}, inset 0 0 0 2px ${ACCENT.primary}`;

  return (
    <div
      role="button" tabIndex={block ? 0 : -1}
      aria-label={block ? `${blockDisplayName(block.type)}${block.paint > 0 ? ` paint ${block.paint}` : ""}` : `Empty ${kind} slot ${index + 1}`}
      title={block
        ? `${blockDisplayName(block.type)}${block.paint > 0 ? ` p${block.paint}` : ""} · key ${digit}`
        : `Empty ${kind} slot ${index + 1}`}
      onClick={onSelect}
      onKeyDown={e => { if (block && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(); } }}
      onMouseEnter={() => onHover(key)}
      onMouseLeave={() => onHover(null)}
      style={{
        width: size, height: size, position: "relative", flexShrink: 0,
        cursor: block ? "pointer" : "default",
        borderRadius: RADIUS.md,
        display: "flex", alignItems: "center", justifyContent: "center",
        outline: kind === "recent" ? "1px dashed rgba(255,255,255,.16)" : "none", outlineOffset: -3,
        background: active ? cur.background : undefined,
        boxShadow: active ? selectedShadow : "none",
        opacity: alreadyPinned ? 0.5 : 1,
      }}
    >
      <Swatch color={color} url={url} size={Math.round(size * 0.68)} empty={!block} />
      <span style={{
        position: "absolute", top: 1, left: 3, fontSize: FONT.micro - 1, lineHeight: 1,
        fontFamily: "monospace", color: active ? RAMP.white : "rgba(255,255,255,0.5)", textShadow: "0 1px 1px rgba(0,0,0,.6)",
        pointerEvents: "none", userSelect: "none",
      }}>{digit}</span>
      {hovered && block && (
        <div
          onClick={e => { e.stopPropagation(); onPinToggle(); onHover(null); }}
          title={kind === "pinned" ? "Unpin" : alreadyPinned ? "Already pinned" : "Pin"}
          style={{
            position: "absolute", top: 0, right: 0, width: 12, height: 12,
            borderRadius: `0 ${RADIUS.sm}px 0 ${RADIUS.sm}px`, background: "rgba(0,0,0,0.75)",
            color: RAMP.white, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: FONT.micro, cursor: alreadyPinned ? "default" : "pointer",
          }}
        >
          {kind === "pinned" ? "×" : "↑"}
        </div>
      )}
    </div>
  );
}
