/**
 * App-level host for the shared block/paint picker portal (UI redesign r3, Stage 14.5). Used to
 * live entirely inside `Ribbon.tsx`; lifted out so the Hotbar window's ▣ slot (`src/windows/
 * HotbarWindow.tsx`) can anchor the same picker without Ribbon and the floating-window layer
 * needing to share state through props. `Ribbon.tsx` now consumes `usePickerHost()` too, so
 * `useRibbon().pickerKind`/`togglePicker` are unchanged from every tab's point of view.
 *
 * ⚠️ `togglePicker` MUST read `e.currentTarget.getBoundingClientRect()` synchronously inside the
 * event handler, never inside the `setPicker` updater — see CLAUDE.md §"UI Shell" (the StrictMode
 * regression this rule fixed, 2026-08-18: React nulls `event.currentTarget` the instant the handler
 * returns, and a `setState` updater is not guaranteed to run only inside that synchronous window).
 * This code moved verbatim from `Ribbon.tsx` for exactly that reason — don't "clean it up" into the
 * updater.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import BlockPaintPicker from "../BlockPaintPicker";
import type { SelectionBounds } from "../MapCanvas";
import type { WorldMeta } from "../types";
import type { AtlasData } from "../texturePack";
import { BORDER, RADIUS, SPACE, SURFACE } from "../ribbon/tokens";
import { sfx } from "../sound/sfx";

/** Which block/paint picker the shared portal is currently showing. */
export type PickerKind = "block-draw" | "block-fill" | "filter" | "gradient-to" | "build-3d";

export interface PickerHostShell {
  /** Currently-open picker, or null. */
  pickerKind: PickerKind | null;
  /** Toggle the shared portal, anchored on the clicked element. */
  togglePicker: (e: React.MouseEvent, kind: PickerKind) => void;
  /** Same, anchored on a rect the caller already measured — the command registry's path (a
   *  ribbon `<Cmd>` click or ⌘K), which finds its control by `data-cmd` rather than holding an
   *  event. The caller must measure *before* calling, same rule as `togglePicker`. */
  togglePickerAt: (r: DOMRect, kind: PickerKind) => void;
}

/** Rough stand-in for the picker's rendered height, used only to decide the *initial* placement
 *  when opening above an anchor (the Hotbar window's ▣ slot, usually docked low on screen) — the
 *  after-mount clamp effect below corrects it to the real measured height, so a wrong estimate
 *  only costs one frame of drift, never a mispositioned picker. */
const PICKER_HEIGHT_ESTIMATE = 360;

const Ctx = createContext<PickerHostShell | null>(null);

export function usePickerHost(): PickerHostShell {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePickerHost() outside <PickerProvider>");
  return v;
}

export interface PickerProviderProps {
  world: WorldMeta | null;
  texturePack?: AtlasData | null;
  rawBounds: SelectionBounds | null;
  fillBlockType: number; fillPaint: number;
  setFillBlockType: (v: number) => void; setFillPaint: (v: number) => void;
  fillSelection: () => void;
  gradientToBlock: number; gradientToPaint: number;
  setGradientToBlock: (v: number) => void; setGradientToPaint: (v: number) => void;
  applyGradientFill: () => void;
  filterBlockType: number | null; filterPaint: number | null;
  setFilterBlockType: (v: number | null) => void; setFilterPaint: (v: number | null) => void;
  children: ReactNode;
}

export function PickerProvider({
  world, texturePack, rawBounds,
  fillBlockType, fillPaint, setFillBlockType, setFillPaint, fillSelection,
  gradientToBlock, gradientToPaint, setGradientToBlock, setGradientToPaint, applyGradientFill,
  filterBlockType, filterPaint, setFilterBlockType, setFilterPaint,
  children,
}: PickerProviderProps) {
  const [picker, setPicker] = useState<{ kind: PickerKind; top: number; left: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const togglePickerAt = useCallback((r: DOMRect, kind: PickerKind) => {
    // Open above the anchor when it sits in the lower half of the screen (Stage 14.5 — the Hotbar
    // window's ▣ slot is docked bottom-centre by default) so the picker doesn't render mostly
    // off-screen; the after-mount clamp effect below corrects the estimate to the real height.
    const openAbove = r.top > window.innerHeight / 2;
    const top = openAbove ? Math.max(4, r.top - PICKER_HEIGHT_ESTIMATE - 4) : r.bottom + 4;
    const next = { kind, top, left: r.left };
    // Cue on open only (including switching to a different picker kind), read from this render's
    // `picker` closure rather than the `setPicker` updater — see this file's header note on why a
    // side effect can never live inside that updater.
    if (picker?.kind !== kind) sfx.play("menu");
    setPicker(cur => (cur?.kind === kind ? null : next));
  }, [picker]);

  const togglePicker = useCallback((e: React.MouseEvent, kind: PickerKind) => {
    // Measured here, synchronously, before anything else runs — see the header note.
    togglePickerAt((e.currentTarget as HTMLElement).getBoundingClientRect(), kind);
  }, [togglePickerAt]);

  // Clamp the picker into the viewport after mount — its size varies by picker type and isn't
  // known until rendered. Converges to a no-op on the re-run its own repositioning triggers.
  // Symmetric on the vertical axis (not just bottom overflow) because the ▣ slot's "open above"
  // placement above starts from an *estimated* height — a picker shorter than the estimate leaves
  // a gap the overflow branch won't touch, but a taller one can still poke off the top of the
  // screen, which this branch catches.
  useEffect(() => {
    if (!picker) return;
    const el = pickerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = r.right > window.innerWidth ? Math.max(0, window.innerWidth - r.width - 4) : picker.left;
    let ny = picker.top;
    if (r.bottom > window.innerHeight) ny = Math.max(4, window.innerHeight - r.height - 4);
    else if (r.top < 0) ny = 4;
    if (nx !== picker.left || ny !== picker.top) setPicker(c => c && { ...c, left: nx, top: ny });
  }, [picker]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setPicker(null); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picker]);

  return (
    <Ctx.Provider value={{ pickerKind: picker?.kind ?? null, togglePicker, togglePickerAt }}>
      {children}
      {/* Same chrome as `Popover` — flyouts belong to the ribbon/window system, not the app's
          warm modal glass. */}
      {picker && createPortal(
        <div ref={pickerRef} className="eden-ribbon" style={{
          position: "fixed", top: picker.top, left: picker.left, zIndex: 9999,
          background: SURFACE.popover,
          boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 10px 28px rgba(0,0,0,.6)`,
          borderRadius: RADIUS.lg, padding: SPACE.lg,
        }}>
          {(picker.kind === "block-draw" || picker.kind === "block-fill") ? (
            <BlockPaintPicker mode="fill" blockType={fillBlockType} paint={fillPaint}
              onBlockTypeChange={bt => { if (bt !== null) setFillBlockType(bt); }}
              onPaintChange={paint => setFillPaint(paint ?? 0)}
              onFill={fillSelection} selectionExists={!!rawBounds}
              texturePack={texturePack} allowNewFormat={world?.max_z === 255} />
          ) : picker.kind === "build-3d" ? (
            <BlockPaintPicker mode="fill" blockType={fillBlockType} paint={fillPaint}
              onBlockTypeChange={bt => { if (bt !== null) setFillBlockType(bt); }}
              onPaintChange={paint => setFillPaint(paint ?? 0)}
              texturePack={texturePack} allowNewFormat={world?.max_z === 255} />
          ) : picker.kind === "gradient-to" ? (
            <BlockPaintPicker mode="fill" blockType={gradientToBlock} paint={gradientToPaint}
              onBlockTypeChange={bt => { if (bt !== null) setGradientToBlock(bt); }}
              onPaintChange={paint => setGradientToPaint(paint ?? 0)}
              onFill={applyGradientFill} selectionExists={!!rawBounds}
              texturePack={texturePack} allowNewFormat={world?.max_z === 255} />
          ) : (
            <BlockPaintPicker mode="filter" blockType={filterBlockType} paint={filterPaint}
              onBlockTypeChange={setFilterBlockType} onPaintChange={setFilterPaint}
              texturePack={texturePack} allowNewFormat={world?.max_z === 255} />
          )}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}
