/**
 * The ribbon shell. Everything visual lives in `src/ribbon/` — this file owns only the state the
 * whole ribbon shares: which tab is active, the application menu, the one `BlockPaintPicker`
 * portal, the measured body width that drives the responsive tier solver, and the contextual-tab
 * auto-switch effects.
 *
 * `RibbonProps` is unchanged from App's point of view (it lives in `ribbon/props.ts` and is
 * re-exported here), so App's call site is a plain prop bag as before.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AppMenu, { type AppMenuRow } from "./AppMenu";
import BlockPaintPicker from "./BlockPaintPicker";
import type { SelectionBounds, Tool } from "./MapCanvas";
import type { ClipboardInfo } from "./types";
import { RibbonProvider, type PickerKind } from "./ribbon/context";
import { RIBBON_CSS } from "./ribbon/primitives";
import { SCULPT_TOOL_IDS } from "./ribbon/sculptTools";
import TopBar from "./ribbon/TopBar";
import ClipboardTab from "./ribbon/tabs/ClipboardTab";
import DrawTab from "./ribbon/tabs/DrawTab";
import HomeTab from "./ribbon/tabs/HomeTab";
import InsertTab from "./ribbon/tabs/InsertTab";
import SculptTab from "./ribbon/tabs/SculptTab";
import SelectionTab from "./ribbon/tabs/SelectionTab";
import ThreeDTab from "./ribbon/tabs/ThreeDTab";
import ViewTab from "./ribbon/tabs/ViewTab";
import {
  BODY_BG, BORDER, CTX_ACCENT, RADIUS, RIBBON_BODY_HEIGHT, RIBBON_HEIGHT_COLLAPSED, SPACE, SURFACE,
  TOPBAR_BG, TOP_BAR_HEIGHT,
} from "./ribbon/tokens";
import type { RibbonProps, RibbonTab } from "./ribbon/props";

export { EDEN_TEAL, EDEN_TEAL_READABLE } from "./designTokens";
export { RIBBON_HEIGHT_COLLAPSED, RIBBON_BODY_HEIGHT, TOP_BAR_HEIGHT } from "./ribbon/tokens";
export type { RibbonProps, RibbonTab, MapViewMode } from "./ribbon/props";

/** 2D draw tools that should jump the ribbon to the Draw tab when armed. */
const DRAW_TOOL_IDS = ["pen", "brush", "spray", "line", "rect", "ellipse", "polygon", "fill"];

export default function Ribbon(p: RibbonProps) {
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const activeTabRef = useRef<RibbonTab>("home");
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  const registerTabSetter = p.registerTabSetter;
  useEffect(() => { registerTabSetter?.(setActiveTab); }, [registerTabSetter]);

  // ── Application menu ────────────────────────────────────────────────────
  const [menuRow, setMenuRow] = useState<AppMenuRow | null>(null);
  const menuOpen = menuRow !== null;
  const openAppMenu = useCallback((row?: string) => setMenuRow((row as AppMenuRow) ?? "open"), []);

  // Eyedropper / Pool Fill hand control back to whatever was armed before them. `prevToolRef` is
  // written here, in the component that receives it as a prop — a tab reaching it through
  // `useRibbon()` would be mutating a hook's return value, which `react-hooks/immutability` bans.
  const { setTool, prevToolRef, tool } = p;
  const armTransientTool = useCallback((next: Tool, escapeTo: Tool) => {
    prevToolRef.current = tool === next ? escapeTo : tool;
    setTool(tool === next ? escapeTo : next);
  }, [prevToolRef, setTool, tool]);

  // ── Shared block/paint picker portal ────────────────────────────────────
  const [picker, setPicker] = useState<{ kind: PickerKind; top: number; left: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const togglePicker = useCallback((e: React.MouseEvent, kind: PickerKind) => {
    // ⚠️ The anchor rect MUST be measured here, synchronously inside the event handler — never
    // inside the `setPicker` updater below. React nulls `event.currentTarget` the instant the
    // handler returns, and a `setState` updater is *not* guaranteed to run synchronously: React
    // only evaluates it eagerly while the fiber has no pending lanes, and StrictMode re-invokes
    // it again during the render phase regardless. Either of those re-runs sees
    // `currentTarget === null`, and the resulting TypeError is thrown *during render*, where the
    // Ribbon's ErrorBoundary swallows it and the whole ribbon silently vanishes. That was the
    // "opening the block picker kills the ribbon" crash — a regression from the pre-rewrite
    // ribbon, which measured here. Keep the updater pure.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const next = { kind, top: r.bottom + 4, left: r.left };
    setPicker(cur => (cur?.kind === kind ? null : next));
  }, []);

  // Clamp the picker into the viewport after mount — its size varies by picker type and isn't
  // known until rendered. Converges to a no-op on the re-run its own repositioning triggers.
  useEffect(() => {
    if (!picker) return;
    const el = pickerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = r.right > window.innerWidth ? Math.max(0, window.innerWidth - r.width - 4) : picker.left;
    const ny = r.bottom > window.innerHeight ? Math.max(0, window.innerHeight - r.height - 4) : picker.top;
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

  // ── Collapsed "peek" (MS Office style) ──────────────────────────────────
  // Clicking a tab while the ribbon is collapsed shows the body as a floating overlay — it does
  // not un-collapse (App's layout inset stays keyed on `p.collapsed`, so nothing shifts down) —
  // and it auto-dismisses the moment focus leaves the ribbon, mirroring how Office's collapsed
  // ribbon peeks open for one command then closes itself.
  const [peeking, setPeeking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestPeek = useCallback(() => setPeeking(true), []);

  useEffect(() => { if (!p.collapsed) setPeeking(false); }, [p.collapsed]);

  useEffect(() => {
    if (!peeking) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPeeking(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPeeking(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [peeking]);

  // ── Body width, for the responsive tier solver ──────────────────────────
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(1400);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setBodyWidth(Math.round(w));
    });
    ro.observe(el);
    setBodyWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [p.collapsed, peeking]);

  // ── Contextual tab appearance flashes ───────────────────────────────────
  const [selFlash, setSelFlash] = useState(0);
  const [clipFlash, setClipFlash] = useState(0);

  // Auto-switch: arming a 2D draw tool jumps to Draw, a sculpt tool to Sculpt. Only on the
  // transition *into* that family, so switching between two draw tools doesn't yank the tab back.
  const prevTool = useRef<string | null>(null);
  useEffect(() => {
    const wasDraw = DRAW_TOOL_IDS.includes(prevTool.current ?? "");
    const wasSculpt = SCULPT_TOOL_IDS.includes((prevTool.current ?? "") as never);
    if (DRAW_TOOL_IDS.includes(p.tool) && !wasDraw) setActiveTab("draw");
    else if (SCULPT_TOOL_IDS.includes(p.tool) && !wasSculpt) setActiveTab("sculpt");
    prevTool.current = p.tool;
  }, [p.tool]);

  // Selection appears → Selection tab (with a flash); cleared while active → back to Home.
  const prevBounds = useRef<SelectionBounds | null>(null);
  useEffect(() => {
    if (p.rawBounds && !prevBounds.current) {
      setSelFlash(n => n + 1);
      setActiveTab("selection");
    } else if (!p.rawBounds && prevBounds.current && activeTabRef.current === "selection") {
      setActiveTab("home");
    }
    prevBounds.current = p.rawBounds;
  }, [p.rawBounds]);

  const prevClipboard = useRef<ClipboardInfo | null>(null);
  useEffect(() => {
    if (p.clipboard && !prevClipboard.current) setClipFlash(n => n + 1);
    else if (!p.clipboard && prevClipboard.current && activeTabRef.current === "paste") setActiveTab("home");
    prevClipboard.current = p.clipboard;
  }, [p.clipboard]);

  // The contextual 3D tab only exists while the fly-view is showing; if it vanishes while active,
  // fall back to View so the body isn't blank.
  useEffect(() => {
    if (!(p.showSlicePanels && p.enable3dPane) && activeTabRef.current === "3d") setActiveTab("view");
  }, [p.showSlicePanels, p.enable3dPane]);

  // The Selection tab owns the extrude preview; keep the old coupling.
  const setExtrudeOpen = p.setExtrudeOpen;
  useEffect(() => { setExtrudeOpen(activeTab === "selection"); }, [activeTab, setExtrudeOpen]);

  const bodyAccent = activeTab === "selection" ? CTX_ACCENT.selection
    : activeTab === "paste" ? CTX_ACCENT.clipboard
      : activeTab === "3d" ? CTX_ACCENT["3d"]
        : BORDER.bevel;

  const showBody = !p.collapsed || peeking;

  return (
    <RibbonProvider value={{ p, activeTab, setActiveTab, bodyWidth, pickerKind: picker?.kind ?? null, togglePicker, openAppMenu, armTransientTool, peeking, requestPeek }}>
      <div ref={rootRef} className="eden-ribbon" style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        background: TOPBAR_BG,
        // A crisp 1px seam to the canvas, not a 12px blur — a docked chrome edge, not a floating card.
        borderBottom: `1px solid ${BORDER.outline}`,
        boxShadow: `0 1px 0 ${BORDER.etchLight}`,
        userSelect: "none",
      }}>
        <style>{RIBBON_CSS}</style>

        <TopBar
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuRow(r => (r === null ? "open" : null))}
          selFlash={selFlash}
          clipFlash={clipFlash}
        />

        {showBody && (
          <div
            id="ribbon-tabpanel" role="tabpanel" aria-label={`${activeTab} tab`}
            ref={bodyRef}
            className="rbn-body"
            style={{
              height: RIBBON_BODY_HEIGHT,
              background: BODY_BG,
              borderTop: `1px solid ${bodyAccent}`,
              boxShadow: peeking
                ? `0 14px 28px rgba(0,0,0,.55), inset 0 1px 0 ${BORDER.etchLight}, inset 0 0 30px rgba(0,0,0,.28)`
                : `inset 0 1px 0 ${BORDER.etchLight}, inset 0 0 30px rgba(0,0,0,.28)`,
              display: "flex", alignItems: "stretch",
              // No scroll arrows and no wheel remap any more: the tier solver resizes groups
              // instead of hiding them. This stays purely as a last resort below the minimum width.
              overflowX: "auto", overflowY: "hidden",
              // Peeking floats the body over the content instead of taking up layout space — App's
              // downstream insets are keyed on `p.collapsed`, which doesn't change while peeking.
              ...(peeking ? { position: "fixed", top: TOP_BAR_HEIGHT, left: 0, right: 0, zIndex: 125 } : null),
            }}
          >
            {activeTab === "home" && <HomeTab />}
            {activeTab === "draw" && <DrawTab />}
            {activeTab === "sculpt" && <SculptTab />}
            {activeTab === "insert" && <InsertTab />}
            {activeTab === "view" && <ViewTab />}
            {activeTab === "3d" && <ThreeDTab />}
            {activeTab === "selection" && <SelectionTab />}
            {activeTab === "paste" && <ClipboardTab />}
          </div>
        )}

        {menuOpen && (
          <AppMenu initialRow={menuRow} anchorTop={TOP_BAR_HEIGHT + 2} onClose={() => setMenuRow(null)} />
        )}

        {/* Block/filter picker portal — one instance, hoisted here so tabs only ask to open it. */}
        {/* Same chrome as `Popover` — flyouts belong to the ribbon, not to the app's warm-brown
            modal glass, and the two used to differ. */}
        {picker && createPortal(
          <div ref={pickerRef} className="eden-ribbon" style={{
            position: "fixed", top: picker.top, left: picker.left, zIndex: 9999,
            background: SURFACE.popover,
            boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 10px 28px rgba(0,0,0,.6)`,
            borderRadius: RADIUS.lg, padding: SPACE.lg,
          }}>
            {(picker.kind === "block-draw" || picker.kind === "block-fill") ? (
              <BlockPaintPicker mode="fill" blockType={p.fillBlockType} paint={p.fillPaint}
                onBlockTypeChange={bt => { if (bt !== null) p.setFillBlockType(bt); }}
                onPaintChange={paint => p.setFillPaint(paint ?? 0)}
                onFill={p.fillSelection} selectionExists={!!p.rawBounds}
                texturePack={p.texturePack} allowNewFormat={p.world?.max_z === 255} />
            ) : picker.kind === "build-3d" ? (
              <BlockPaintPicker mode="fill" blockType={p.fillBlockType} paint={p.fillPaint}
                onBlockTypeChange={bt => { if (bt !== null) p.setFillBlockType(bt); }}
                onPaintChange={paint => p.setFillPaint(paint ?? 0)}
                texturePack={p.texturePack} allowNewFormat={p.world?.max_z === 255} />
            ) : picker.kind === "gradient-to" ? (
              <BlockPaintPicker mode="fill" blockType={p.gradientToBlock} paint={p.gradientToPaint}
                onBlockTypeChange={bt => { if (bt !== null) p.setGradientToBlock(bt); }}
                onPaintChange={paint => p.setGradientToPaint(paint ?? 0)}
                onFill={p.applyGradientFill} selectionExists={!!p.rawBounds}
                texturePack={p.texturePack} allowNewFormat={p.world?.max_z === 255} />
            ) : (
              <BlockPaintPicker mode="filter" blockType={p.filterBlockType} paint={p.filterPaint}
                onBlockTypeChange={p.setFilterBlockType} onPaintChange={p.setFilterPaint}
                texturePack={p.texturePack} allowNewFormat={p.world?.max_z === 255} />
            )}
          </div>,
          document.body,
        )}
      </div>
    </RibbonProvider>
  );
}

/** Total ribbon height, given whether it is collapsed. App derives every downstream inset from this. */
export function ribbonHeight(collapsed: boolean): number {
  return collapsed ? RIBBON_HEIGHT_COLLAPSED : TOP_BAR_HEIGHT + RIBBON_BODY_HEIGHT;
}
