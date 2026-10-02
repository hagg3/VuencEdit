/**
 * The ribbon shell. Everything visual lives in `src/ribbon/` — this file owns only the state the
 * whole ribbon shares: which tab is active, the application menu, the measured body width that
 * drives the responsive tier solver, and the contextual-tab auto-switch effects. The shared
 * `BlockPaintPicker` portal moved to an App-level `PickerHost` (Stage 14.5, `src/picker/
 * PickerHost.tsx`) so the floating Hotbar window's ▣ slot can anchor it too — Ribbon just forwards
 * `usePickerHost()` into its own context, so every tab's `useRibbon().togglePicker`/`pickerKind` is
 * unchanged.
 *
 * `RibbonProps` is unchanged from App's point of view (it lives in `ribbon/props.ts` and is
 * re-exported here), so App's call site is a plain prop bag as before.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AppMenu, { type AppMenuRow } from "./AppMenu";
import type { SelectionBounds, Tool } from "./MapCanvas";
import type { ClipboardInfo } from "./types";
import { RibbonProvider, type PickerKind } from "./ribbon/context";
import { CommandBindingsProvider } from "./ribbon/Cmd";
import { bindCommands } from "./commands/bind";
import { meta, type CommandId, type CommandPath } from "./commands/meta";
import { matchChord } from "./commands/keys";
import CommandPalette, { recordCommandUse } from "./commands/CommandPalette";
import { usePickerHost } from "./picker/PickerHost";
import { RIBBON_CSS } from "./ribbon/primitives";
import { panelToReveal, runReveal } from "./ribbon/reveal";
import { collapseWin, getWindowState } from "./windows/useWindowLayout";
import { SCULPT_TOOL_IDS } from "./ribbon/sculptTools";
// Registers `window.__harvestRibbonWidths()` in dev only — see the module doc comment (14.7).
import "./ribbon/widthHarvester";
import { sfx } from "./sound/sfx";
import TopBar from "./ribbon/TopBar";
import CompactRibbon from "./ribbon/CompactRibbon";
import ClipboardTab from "./ribbon/tabs/ClipboardTab";
import DrawTab from "./ribbon/tabs/DrawTab";
import HomeTab from "./ribbon/tabs/HomeTab";
import InsertTab from "./ribbon/tabs/InsertTab";
import SculptTab from "./ribbon/tabs/SculptTab";
import SelectionTab from "./ribbon/tabs/SelectionTab";
import ThreeDTab from "./ribbon/tabs/ThreeDTab";
import ViewTab from "./ribbon/tabs/ViewTab";
import {
  BODY_BG, BORDER, COMPACT_BODY_HEIGHT, CTX_ACCENT, RIBBON_BODY_HEIGHT, RIBBON_HEIGHT_COLLAPSED,
  TOPBAR_BG, TOP_BAR_HEIGHT,
} from "./ribbon/tokens";
import type { RibbonProps, RibbonTab } from "./ribbon/props";
import { MOTION } from "./theme/theme";

/** Left-to-right tab order, for the tab-change animation's direction of travel. */
const TAB_ORDER: RibbonTab[] = ["home", "draw", "sculpt", "insert", "view", "3d", "selection", "paste"];

export { EDEN_TEAL } from "./designTokens";
export { RIBBON_HEIGHT_COLLAPSED, RIBBON_BODY_HEIGHT, COMPACT_BODY_HEIGHT, TOP_BAR_HEIGHT } from "./ribbon/tokens";
export type { RibbonProps, RibbonTab, MapViewMode } from "./ribbon/props";

/** 2D draw tools that should jump the ribbon to the Draw tab when armed. */
const DRAW_TOOL_IDS = ["pen", "brush", "spray", "line", "rect", "ellipse", "polygon", "fill"];

export default function Ribbon(p: RibbonProps) {
  const [activeTab, setActiveTab] = useState<RibbonTab>("home");
  const activeTabRef = useRef<RibbonTab>("home");
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // Tab-change animation (Stage 19.5): the new tab's groups fade in and slide a few px in the
  // direction of travel, staggered. Fires only when `activeTab` actually changes, so a first mount,
  // a responsive-tier change or an overflow re-solve (none of which change the tab) never animates.
  // Transform/opacity only, so it cannot affect `__harvestRibbonWidths()`, which measures layout.
  // The CSS that reads these attributes is gated on `:root[data-motion="full"]` (theme/cssVars.ts).
  const prevTabRef = useRef<RibbonTab>(activeTab);
  useLayoutEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = activeTab;
    const body = bodyRef.current;
    if (prev === activeTab || !body || p.compact) return;
    const dir = TAB_ORDER.indexOf(activeTab) >= TAB_ORDER.indexOf(prev) ? 1 : -1;
    body.style.setProperty("--vx-tab-dx", `${dir * 10}px`);
    body.querySelectorAll<HTMLElement>("[data-group]").forEach((el, i) => el.style.setProperty("--vx-i", String(Math.min(i, 8))));
    body.dataset.tabanim = "";
    const t = window.setTimeout(() => { delete body.dataset.tabanim; }, MOTION.chromeMs + 8 * 20 + 40);
    return () => window.clearTimeout(t);
    // `p.compact` only gates the effect; a compact toggle must not itself replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const registerTabSetter = p.registerTabSetter;
  useEffect(() => { registerTabSetter?.(setActiveTab); }, [registerTabSetter]);

  // ── Application menu ────────────────────────────────────────────────────
  const [menuRow, setMenuRow] = useState<AppMenuRow | null>(null);
  const menuOpen = menuRow !== null;
  // `sfx.play` is a side effect and must not run inside the `setMenuRow` updater itself — a plain
  // updater can run twice under StrictMode (the same trap `togglePicker` below is careful about) —
  // so the "was it already open" check reads `menuOpen` from this render's closure instead.
  const openAppMenu = useCallback((row?: string) => {
    if (!menuOpen) sfx.play("menu");
    setMenuRow((row as AppMenuRow) ?? "open");
  }, [menuOpen]);

  // Eyedropper / Pool Fill hand control back to whatever was armed before them. `prevToolRef` is
  // written here, in the component that receives it as a prop — a tab reaching it through
  // `useRibbon()` would be mutating a hook's return value, which `react-hooks/immutability` bans.
  const { setTool, prevToolRef, tool } = p;
  const armTransientTool = useCallback((next: Tool, escapeTo: Tool) => {
    prevToolRef.current = tool === next ? escapeTo : tool;
    setTool(tool === next ? escapeTo : next);
  }, [prevToolRef, setTool, tool]);

  // ── Shared block/paint picker ────────────────────────────────────────────
  // State + portal now live at App level (`src/picker/PickerHost.tsx`, Stage 14.5) so the Hotbar
  // window's ▣ slot can anchor the same picker; Ribbon just forwards it into its own context so
  // every tab's `useRibbon().togglePicker`/`pickerKind` is unchanged.
  const { pickerKind, togglePicker, togglePickerAt } = usePickerHost();

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

  // ── Overflow safety net (15.4) ──────────────────────────────────────────
  // The body is `overflowX: hidden` now, so a group whose *declared* full width is stale-low
  // (the specs.ts re-harvest debt) would be clipped — unreachable — rather than scrolled to. If the
  // row measures wider than the body after a solve, shrink the width the solver is given by the
  // overshoot and re-solve, before paint. Keyed on tab + width so it resets on either change; it
  // only ever grows within a key and stops at `bodyWidth`, so it can't loop. It is a net, not the
  // mechanism: in dev it warns so the spec gets fixed.
  const [overflowFix, setOverflowFix] = useState({ key: "", px: 0 });
  const fixKey = `${activeTab}|${bodyWidth}|${p.compact}`;
  const fixPx = overflowFix.key === fixKey ? overflowFix.px : 0;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    // Skip until `bodyWidth` is this element's real width — the first render solves against the
    // 1400 default, before the ResizeObserver has reported.
    if (!el || p.compact || Math.abs(el.clientWidth - bodyWidth) > 1) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && fixPx < bodyWidth) {
      if (import.meta.env.DEV) console.warn(`[ribbon] ${activeTab} tab overflows by ${over}px at ${bodyWidth}px — a declared width in ribbon/specs.ts is too small; re-solving ${fixPx + over}px narrower`);
      setOverflowFix({ key: fixKey, px: fixPx + over });
    }
    // `p` changes whenever App re-renders — that's the point: any content change can widen the row.
  }, [p, activeTab, bodyWidth, fixKey, fixPx]);

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
    if (!p.pane3dLive && activeTabRef.current === "3d") setActiveTab("view");
  }, [p.pane3dLive]);

  // The Selection tab owns the extrude preview; keep the old coupling.
  const setExtrudeOpen = p.setExtrudeOpen;
  useEffect(() => { setExtrudeOpen(activeTab === "selection"); }, [activeTab, setExtrudeOpen]);

  // ── Command registry + ⌘K (Stage 14.6, `src/commands/`) ─────────────────
  // Ribbon-shell state a binding needs that used to be local to one tab (so ⌘K sees it too).
  const [extrudeIgnoreAir, setExtrudeIgnoreAir] = useState(false);
  const [plantingTrees, setPlantingTrees] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The cue must not live in a `setPaletteOpen` updater (StrictMode double-invokes updaters — the
  // `togglePicker` rule), so "was it already open" is read from a ref mirror instead.
  const paletteOpenRef = useRef(false);
  useEffect(() => { paletteOpenRef.current = paletteOpen; }, [paletteOpen]);
  const openPalette = useCallback(() => {
    if (!paletteOpenRef.current) sfx.play("menu");
    setPaletteOpen(true);
  }, []);

  // Contextual tabs only exist in some states; never switch to one that isn't in the strip.
  const tabAvailable = useCallback((t: RibbonTab) =>
    t === "3d" ? p.pane3dLive : t === "selection" ? !!p.rawBounds : t === "paste" ? !!p.clipboard : true,
  [p.pane3dLive, p.rawBounds, p.clipboard]);
  /** The placement of `id` to show: one on the active tab if it has one, else its first available. */
  const placementFor = useCallback((id: CommandId) => {
    const m = meta(id);
    const places = [m.path, ...(m.also ?? [])].filter((x): x is Extract<CommandPath, { tab: unknown }> => "tab" in x);
    return places.find(x => x.tab === activeTabRef.current) ?? places.find(x => tabAvailable(x.tab)) ?? null;
  }, [tabAvailable]);

  /** Show `id`'s control: switch to its tab (preferring a placement on the active one), peek a
   *  collapsed ribbon, open the popup group (or compact overflow) holding it, then flash + focus it. `then` runs once the
   *  control is on screen (the picker path anchors on it). */
  const { onNotice } = p;
  const reveal = useCallback((id: CommandId, then?: (el: HTMLElement) => void) => {
    // A control that lives in a context panel (16.6) that's on screen: flash it there, expanding the
    // panel first if it was collapsed, rather than hopping to another ribbon tab.
    const m = meta(id);
    const panel = panelToReveal([m.path, ...(m.also ?? [])], activeTabRef.current, getWindowState().activeContext);
    if (panel) {
      collapseWin(panel, false);
      runReveal<HTMLElement>({
        find: () => findCmd(id, panel),
        openers: () => [],
        nextFrame: cb => { requestAnimationFrame(cb); },
        onFound: el => { flash(el); then?.(el); },
      });
      return;
    }
    const place = placementFor(id);
    if (!place) {
      const path = meta(id).path;
      // A contextual-tab command whose tab isn't showing (e.g. a 3D control with the 3D view shut).
      if ("tab" in path) onNotice(`${meta(id).label} is on the ${path.tab === "paste" ? "Clipboard" : path.tab === "3d" ? "3D" : "Selection"} tab, which isn't showing right now.`);
      return; // app-menu / top-bar commands have nothing to reveal in the body
    }
    setActiveTab(place.tab);
    if (p.collapsed) setPeeking(true);
    // A `popup` group keeps its commands inside its popover, and the compact ribbon's overflow »
    // keeps whole groups inside another — `runReveal` opens whichever holds it (once), then retries.
    runReveal<HTMLElement>({
      find: () => findCmd(id),
      openers: () => [
        document.querySelector<HTMLElement>(`#ribbon-tabpanel [data-group="${place.group}"] [data-group-chevron] button`),
        // The compact ribbon has one overflow button per row; either may hold the group.
        ...document.querySelectorAll<HTMLElement>(`#ribbon-tabpanel [data-overflow-chevron~="${place.group}"]`),
      ].map(el => el && { expanded: el.getAttribute("aria-expanded") === "true", click: () => el.click() }),
      nextFrame: cb => { requestAnimationFrame(cb); },
      onFound: el => { flash(el); then?.(el); },
    });
  }, [p.collapsed, placementFor, onNotice]);

  const togglePickerFor = useCallback((kind: PickerKind, id: CommandId) => {
    const el = findCmd(id);
    // Measured before the toggle, like `togglePicker` — never from a stored event.
    if (el) togglePickerAt(el.getBoundingClientRect(), kind);
    else reveal(id, found => togglePickerAt(found.getBoundingClientRect(), kind));
  }, [reveal, togglePickerAt]);

  // `p` carries `prevToolRef`, which trips react-hooks/refs here — but bindings only *close over*
  // it (armTransientTool writes it inside a click handler); nothing reads a ref during render.
  // eslint-disable-next-line react-hooks/refs
  const bindings = useMemo(() => bindCommands({
    p, setActiveTab, armTransientTool, togglePickerFor, pickerKind, openPalette,
    ui: { extrudeIgnoreAir, setExtrudeIgnoreAir, plantingTrees, setPlantingTrees },
  }), [p, armTransientTool, togglePickerFor, pickerKind, openPalette, extrudeIgnoreAir, plantingTrees]);

  // ⌘K / Ctrl+K — the one registry-dispatched chord this phase. Capture-phase so it works with a
  // text field focused; inert while any modal (or the palette itself) is up. Ctrl+K is
  // `preventDefault`ed as cheap insurance against a WebView2 accelerator.
  useEffect(() => {
    const chord = meta("app.commandSearch").keys![0];
    const onKey = (e: KeyboardEvent) => {
      if (!matchChord(e, chord)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault(); e.stopPropagation();
      openPalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openPalette]);

  const runFromPalette = useCallback((id: CommandId) => {
    setPaletteOpen(false);
    const b = bindings[id];
    if (b.enabled !== true) { p.onNotice(b.enabled); return; }
    recordCommandUse(id);
    b.run();
    // Show where it lives (the mock's `runCmd`) — staying put if the active tab has it too.
    const place = placementFor(id);
    if (place && meta(id).kind !== "picker") setActiveTab(place.tab);
    sfx.play("copy");
  }, [bindings, p, placementFor]);

  const revealFromPalette = useCallback((id: CommandId) => {
    setPaletteOpen(false);
    recordCommandUse(id);
    reveal(id, el => el.focus());
  }, [reveal]);

  const bodyAccent = activeTab === "selection" ? CTX_ACCENT.selection
    : activeTab === "paste" ? CTX_ACCENT.clipboard
      : activeTab === "3d" ? CTX_ACCENT["3d"]
        : BORDER.bevel;

  const showBody = !p.collapsed || peeking;

  return (
    <RibbonProvider value={{ p, activeTab, setActiveTab, bodyWidth: bodyWidth - fixPx, pickerKind, togglePicker, openAppMenu, armTransientTool, peeking, requestPeek }}>
      <CommandBindingsProvider value={bindings}>
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
          onToggleMenu={() => {
            if (!menuOpen) sfx.play("menu"); // opening only, not the same click's close
            setMenuRow(menuOpen ? null : "open");
          }}
          selFlash={selFlash}
          clipFlash={clipFlash}
          onOpenSearch={openPalette}
        />

        {showBody && (
          <div
            id="ribbon-tabpanel" role="tabpanel" aria-label={`${activeTab} tab`}
            ref={bodyRef}
            className="rbn-body"
            style={{
              height: p.compact ? COMPACT_BODY_HEIGHT : RIBBON_BODY_HEIGHT,
              background: BODY_BG,
              borderTop: `1px solid ${bodyAccent}`,
              boxShadow: peeking
                ? `0 14px 28px rgba(0,0,0,.55), inset 0 1px 0 ${BORDER.etchLight}, inset 0 0 30px rgba(0,0,0,.28)`
                : `inset 0 1px 0 ${BORDER.etchLight}, inset 0 0 30px rgba(0,0,0,.28)`,
              display: "flex", alignItems: "stretch",
              // Never scrolls (15.4): the tier solver resizes groups, collapsing the least important
              // into popup buttons, and fits down to every group collapsed (well under the 900px
              // minimum window — `specs.test.ts`). Compact mode's two rows put what doesn't fit
              // behind their own overflow » (`CompactRibbon`).
              overflowX: "hidden", overflowY: "hidden",
              // Peeking floats the body over the content instead of taking up layout space — App's
              // downstream insets are keyed on `p.collapsed`, which doesn't change while peeking.
              ...(peeking ? { position: "fixed", top: TOP_BAR_HEIGHT, left: 0, right: 0, zIndex: 125 } : null),
            }}
          >
            {p.compact ? <CompactRibbon onOpenSearch={openPalette} /> : <>
              {activeTab === "home" && <HomeTab />}
              {activeTab === "draw" && <DrawTab />}
              {activeTab === "sculpt" && <SculptTab />}
              {activeTab === "insert" && <InsertTab />}
              {activeTab === "view" && <ViewTab />}
              {activeTab === "3d" && <ThreeDTab />}
              {activeTab === "selection" && <SelectionTab />}
              {activeTab === "paste" && <ClipboardTab />}
            </>}
          </div>
        )}
        {/* The ribbon's own Compact/Labels corner toggle was removed (2026-09-28 UI feedback) —
            `ribbonCompact` is experimental-only now, set from Settings ▸ Experiments. */}

        {menuOpen && (
          <AppMenu initialRow={menuRow} anchorTop={TOP_BAR_HEIGHT + 2} onClose={() => setMenuRow(null)} />
        )}
        {paletteOpen && (
          <CommandPalette bindings={bindings} top={TOP_BAR_HEIGHT}
            onRun={runFromPalette} onReveal={revealFromPalette} onClose={() => setPaletteOpen(false)} />
        )}
        {import.meta.env.DEV && <UnmarkedButtonCheck tab={activeTab} />}
      </div>
      </CommandBindingsProvider>
    </RibbonProvider>
  );
}

/** The on-screen control for a command (the `<Cmd>` wrapper is `display: contents`, so its first
 *  child is the real element). A popup group's popover is portaled, so search the document. */
function findCmd(id: CommandId, panel?: string): HTMLElement | null {
  // A command can be marked twice (its ribbon home *and* a context panel's copy, 16.6): inside the
  // named panel when asked, otherwise the ribbon/popup copy first.
  const marks = [...document.querySelectorAll(`[data-cmd="${id}"]`)];
  const mark = panel
    ? marks.find(m => m.closest(`[data-win="${panel}"]`))
    : marks.find(m => !m.closest("[data-win]")) ?? marks[0];
  return (mark?.firstElementChild as HTMLElement | null) ?? null;
}

/** 1.3 s outline on a revealed control. Static unless motion is on (`data-motion`, 14.13). */
function flash(el: HTMLElement) {
  el.classList.remove("cmd-flash");
  void el.offsetWidth; // restart the animation on a repeat reveal
  el.classList.add("cmd-flash");
  window.setTimeout(() => el.classList.remove("cmd-flash"), 1300);
}

/**
 * Dev-only tripwire (commands sub-plan §4.4): a ribbon button that isn't inside a `<Cmd>` wrapper
 * is invisible to ⌘K — the lint catches imports, this catches an `eslint-disable`d hand-rolled
 * `<button className="rbn-btn">`. Popup-group buttons and overflow chevrons are chrome, not commands.
 */
function UnmarkedButtonCheck({ tab }: { tab: RibbonTab }) {
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      // Segmented/Select options (role radio/option) are settings, not commands — exempt.
      const bad = [...document.querySelectorAll<HTMLElement>('#ribbon-tabpanel button.rbn-btn:not([role="radio"]):not([role="option"])')]
        .filter(b => !b.closest("[data-cmd],[data-group-chevron],[data-no-cmd]"));
      if (bad.length) console.warn(`[ribbon] ${bad.length} button(s) on the ${tab} tab aren't registry commands:`, bad);
    });
    return () => cancelAnimationFrame(id);
  });
  return null;
}

/**
 * Total ribbon height, given whether it is collapsed and whether the opt-in compact command-bar
 * body (Stage 14.10, `AppSettings.ribbonCompact`) is showing. App derives every downstream inset
 * (sidebar, floating-window layer, Quick Actions bar) from this — it stays the single source
 * regardless of which body is active.
 */
export function ribbonHeight(collapsed: boolean, compact: boolean = false): number {
  if (collapsed) return RIBBON_HEIGHT_COLLAPSED;
  return TOP_BAR_HEIGHT + (compact ? COMPACT_BODY_HEIGHT : RIBBON_BODY_HEIGHT);
}
