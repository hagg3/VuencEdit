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
  setLeftToolbarOpen: (v: boolean) => void;
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

/** The ribbon's tab strip — folded into every ribbon-group step's cutout (see `secondaryTargets`
 *  above) so the active tab stays legible while the step spotlights a group beneath it. */
const RIBBON_TABLIST = '[role="tablist"][aria-label="Ribbon tabs"]';

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
        A quick, ~13-step tour of the main surfaces — about a minute. Press <Kbd>Esc</Kbd> to skip
        at any point; you can replay this any time from the Help window.
      </>
    ),
  },
  {
    id: "map",
    title: "The map",
    target: '[data-tour="map"]',
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
    target: '[role="tablist"][aria-label="Ribbon tabs"]',
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
    target: ".rbn-brand",
    body: "New, Open, Download, Save, Upload, Export, Settings and Help all live behind this button.",
  },
  {
    id: "left-toolbar",
    title: "The tool rail",
    target: '[data-tour="left-toolbar"]',
    before: (c) => c.setLeftToolbarOpen(true),
    body: "Everyday draw and select tools, one click away — each with its own one-key shortcut.",
  },
  {
    id: "palette",
    title: "Active block",
    target: '#ribbon-tabpanel [data-group="palette"]',
    secondaryTargets: [RIBBON_TABLIST],
    before: (c) => c.setRibbonTab("home"),
    body: (
      <>
        The block and paint you're currently placing. <Kbd>1</Kbd>–<Kbd>5</Kbd> arm pinned
        blocks, <Kbd>6</Kbd>–<Kbd>0</Kbd> jump to recently used ones.
      </>
    ),
  },
  {
    id: "draw-tools",
    title: "Draw tools",
    target: '#ribbon-tabpanel [data-group="tools"]',
    secondaryTargets: [RIBBON_TABLIST, '#ribbon-tabpanel [data-group="mask"]'],
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
    target: '#ribbon-tabpanel [data-group="tools"]',
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
    target: '#ribbon-tabpanel [data-group="selection"]',
    secondaryTargets: [RIBBON_TABLIST, '#ribbon-tabpanel [data-group="navigation"]'],
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
    target: '#ribbon-tabpanel [data-group="layout"]',
    secondaryTargets: [RIBBON_TABLIST, '[data-tour="map"]'],
    before: (c) => c.setRibbonTab("view"),
    body: "Quad view (Hammer-style Top/Front/Side/3D), the 3D fly-through pane, and cutaway view for working on caves and interiors.",
  },
  {
    id: "sidebar",
    title: "The sidebar",
    target: '[data-tour="sidebar"]',
    before: (c) => c.setSidebarOpen(true),
    body: "Docked to the right edge: Inspector, Prefabs and undo History, all in one tabbed panel.",
  },
  {
    id: "undo",
    title: "Undo & autosave",
    target: '.rbn-btn[aria-label="Undo"]',
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
    target: '[aria-label="Help"]',
    body: "The full keyboard map and tool reference live here — and you can replay this tour any time from this button.",
  },
];
