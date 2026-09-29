/**
 * Onboarding tour content — the only file to edit when adding, reordering or rewording a step.
 * The engine (`TourOverlay.tsx`) is purely declarative over this array: it measures `target`,
 * runs `before` to reveal it, and renders `title`/`body`. See CLAUDE.md's "Onboarding Tour" note.
 */
import type { ReactNode } from "react";
import type { RibbonTab } from "../ribbon/props";
import type { SidebarTab } from "../Sidebar";
import { MOD, SHIFT, TEXT } from "../ribbon/tokens";

// ⚠ written by bump-version.sh — keep this on one line
export const TOUR_VERSION = 3;

export interface TourCtx {
  setRibbonTab: (t: RibbonTab) => void;
  setRibbonCollapsed: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  setSidebarTab: (t: SidebarTab) => void;
  /** Open (and expand) the Tools window — the floating six-button quick-tools pane (Stage 14.3). */
  openToolsWindow: () => void;
  /** Open (and expand) the Hotbar window — pinned/recent block slots (Stage 14.5). */
  openHotbarWindow: () => void;
}

export interface TourStep {
  id: string;
  title: string;
  body: ReactNode;
  /** CSS selector for the spotlight target; null = centred card, no spotlight. */
  target: string | null;
  /** Extra selectors folded into the spotlight's cutout (unioned with `target`'s rect) without
   *  taking the pulsing ring — e.g. the ribbon's tab strip, so it isn't dimmed into illegibility
   *  while a step points at a group below it and the active tab would otherwise be unreadable. */
  secondaryTargets?: string[];
  placement?: "auto" | "top" | "bottom" | "left" | "right";
  /** Spotlight inflation in px around the target's measured rect. */
  padding?: number;
  /** Guided-passive reveal — switches a tab / opens a panel before the step is measured. Never
   *  touches world data. */
  before?: (c: TourCtx) => void;
}

/**
 * Every selector a tour step points at, in one place (Stage 14.16), so moving a target is one edit
 * here plus the `data-tour`/`data-group` attribute it names — and `tour/anchors.test.ts` checks the
 * two still agree. `data-tour` values are set by the component that owns the surface
 * (`FloatingWindow`'s `dataTour`, App's map pane, …); `data-group` ids are the ribbon's group ids.
 */
export const TOUR_ANCHORS = {
  /** The main pane — the map, or the 3D view while swapped. */
  map: '[data-tour="map"]',
  ribbonTabs: '[role="tablist"][aria-label="Ribbon tabs"]',
  fileMenu: ".rbn-brand",
  toolsWindow: '[data-tour="left-toolbar"]',
  hotbarWindow: '[data-tour="hotbar"]',
  blockGroup: '#ribbon-tabpanel [data-group="block"]',
  toolsGroup: '#ribbon-tabpanel [data-group="tools"]',
  maskGroup: '#ribbon-tabpanel [data-group="mask"]',
  selectionGroup: '#ribbon-tabpanel [data-group="selection"]',
  navigationGroup: '#ribbon-tabpanel [data-group="navigation"]',
  layoutGroup: '#ribbon-tabpanel [data-group="layout"]',
  sidebar: '[data-tour="sidebar"]',
  undo: '.rbn-btn[aria-label="Undo"]',
  help: '[aria-label="Help"]',
} as const;

/** The ribbon's tab strip — folded into every ribbon-group step's cutout (see `secondaryTargets`
 *  above) so the active tab stays legible while the step spotlights a group beneath it. */
const RIBBON_TABLIST = TOUR_ANCHORS.ribbonTabs;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd style={{
      fontSize: 10.5, fontFamily: "ui-monospace,'SF Mono',monospace", color: TEXT,
      background: "rgba(255,255,255,.08)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14)",
      borderRadius: 3, padding: "0 4px", margin: "0 1px",
    }}>{children}</kbd>
  );
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to VuencEdit",
    target: null,
    body: (
      <>
        A quick tour of the main surfaces — about a minute. Press <Kbd>Esc</Kbd> to skip
        at any point; you can replay this any time from the Help window.
      </>
    ),
  },
  {
    id: "map",
    title: "The map",
    target: TOUR_ANCHORS.map,
    body: (
      <>
        Top-down view of the world. Middle-drag (or hold <Kbd>Space</Kbd>) to pan, scroll to zoom,
        <Kbd>Home</Kbd> to fit the whole world.
      </>
    ),
  },
  {
    id: "ribbon",
    title: "The ribbon",
    target: TOUR_ANCHORS.ribbonTabs,
    before: (c) => c.setRibbonCollapsed(false),
    body: (
      <>
        Five permanent tabs — Home, Draw, Sculpt, Insert, View. 3D, Selection and Clipboard appear
        only when they apply.
      </>
    ),
  },
  {
    id: "file-menu",
    title: "The File menu",
    target: TOUR_ANCHORS.fileMenu,
    body: "New, Open, Download, Save, Upload, Export, Settings and Help all live behind this button.",
  },
  {
    id: "left-toolbar",
    title: "The Tools window",
    target: TOUR_ANCHORS.toolsWindow,
    before: (c) => c.openToolsWindow(),
    body: "Everyday draw and select tools, one click away — each with its own one-key shortcut. Drag its title bar to move it; hold a button for its variants.",
  },
  {
    id: "block",
    title: "Active block",
    target: TOUR_ANCHORS.blockGroup,
    secondaryTargets: [RIBBON_TABLIST],
    before: (c) => c.setRibbonTab("home"),
    body: "The block and paint you're currently placing. Click it to browse every block & paint.",
  },
  {
    id: "hotbar",
    title: "The Hotbar window",
    target: TOUR_ANCHORS.hotbarWindow,
    before: (c) => c.openHotbarWindow(),
    body: (
      <>
        Pinned blocks and recently used ones, always one keystroke away: <Kbd>1</Kbd>–<Kbd>5</Kbd> arm
        pinned slots, <Kbd>6</Kbd>–<Kbd>0</Kbd> jump to recent ones. Hover a slot to pin or unpin it,
        or click ▣ to open the full picker from here.
      </>
    ),
  },
  {
    id: "draw-tools",
    title: "Draw tools",
    target: TOUR_ANCHORS.toolsGroup,
    secondaryTargets: [RIBBON_TABLIST, TOUR_ANCHORS.maskGroup],
    before: (c) => c.setRibbonTab("draw"),
    body: (
      <>
        Pen, brush, line, rectangle, ellipse, polygon — with brush size and a block mask for
        selective replacement.
      </>
    ),
  },
  {
    id: "sculpt-tools",
    title: "Sculpt tools",
    target: TOUR_ANCHORS.toolsGroup,
    secondaryTargets: [RIBBON_TABLIST],
    before: (c) => c.setRibbonTab("sculpt"),
    body: (
      <>
        Raise, lower, smooth, erode and more. <Kbd>[</Kbd> / <Kbd>]</Kbd> change radius,
        <Kbd>{SHIFT}[</Kbd> / <Kbd>{SHIFT}]</Kbd> change strength, and <Kbd>Esc</Kbd> mid-stroke
        reverts the whole stroke as one undo step.
      </>
    ),
  },
  {
    id: "selection",
    title: "Selecting",
    target: TOUR_ANCHORS.selectionGroup,
    secondaryTargets: [RIBBON_TABLIST, TOUR_ANCHORS.navigationGroup],
    before: (c) => c.setRibbonTab("home"),
    body: (
      <>
        Rectangle <Kbd>S</Kbd>, magic wand <Kbd>W</Kbd> and lasso <Kbd>K</Kbd> make real shapes,
        not just bounding boxes. Once you have a selection, a Selection tab, a Clipboard tab and a
        floating Quick Actions bar all appear.
      </>
    ),
  },
  {
    id: "view-layout",
    title: "View layouts",
    target: TOUR_ANCHORS.layoutGroup,
    secondaryTargets: [RIBBON_TABLIST, TOUR_ANCHORS.map],
    before: (c) => c.setRibbonTab("view"),
    body: "The 3D view floats over the map as a window — swap them with Tab or ⇄ — plus which floating windows are shown. The Render group's Relief shades the map's slopes so hills and cliffs read at a glance.",
  },
  {
    id: "context-panels",
    title: "Mode panels",
    target: null,
    body: (
      <>
        Some modes bring a small panel of their own — the brush shape while sculpting, the level
        while in Z-slice or Cutaway, the build slot in the 3D view. It appears with the mode and
        its ✕ leaves the mode, so there's nothing to hunt for in the ribbon.
      </>
    ),
  },
  {
    id: "sidebar",
    title: "The sidebar",
    target: TOUR_ANCHORS.sidebar,
    before: (c) => c.setSidebarOpen(true),
    body: "Docked to the right edge: Inspector, Prefabs and undo History, all in one tabbed panel.",
  },
  {
    id: "undo",
    title: "Undo & autosave",
    target: TOUR_ANCHORS.undo,
    body: (
      <>
        <Kbd>{MOD}Z</Kbd> / <Kbd>{MOD}{SHIFT}Z</Kbd> undo and redo — also listed in the sidebar's
        History tab. <Kbd>{MOD}S</Kbd> saves, and an autosave runs quietly in the background.
      </>
    ),
  },
  {
    id: "help",
    title: "Help",
    target: TOUR_ANCHORS.help,
    body: "The full keyboard map and tool reference live here — and you can replay this tour any time from this button.",
  },
];
