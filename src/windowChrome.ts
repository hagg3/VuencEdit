/**
 * Which title-bar chrome this window has, and therefore what the top bar / splash must provide.
 *
 *   - **macOS** — `titleBarStyle: "Overlay"` (tauri.conf.json): no title bar, native traffic lights
 *     floated over our content at (12,11). We supply the drag region + left clearance.
 *   - **Windows** — frameless (`decorations: false` in `tauri.windows.conf.json`). We supply the
 *     drag region *and* the minimise/maximise/close cluster (`ribbon/WindowControls.tsx`).
 *   - **Linux** — native decorations untouched; we supply nothing (a drag strip inside the ribbon
 *     would only steal clicks).
 *
 * On macOS, Settings ▸ Experiments "Preview Windows title-bar controls" switches to the Windows
 * layout live: the traffic lights are hidden natively (`set_traffic_lights_hidden`) and the custom
 * cluster is drawn instead — real buttons, so they genuinely minimise/zoom/close.
 *
 * A tiny external store rather than React state threaded through props: the top bar and the splash
 * are far apart in the tree and both just need to read it.
 */
import { useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC, MAC_TRAFFIC_LIGHT_CLEARANCE } from "./ribbon/tokens";

export const IS_WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

let macPreview = false;
const subs = new Set<() => void>();

/** Apply the Experiments toggle. Mac-only — Windows always has the custom controls, Linux never. */
export function setWindowControlsPreview(on: boolean) {
  if (!IS_MAC || on === macPreview) return;
  macPreview = on;
  invoke("set_traffic_lights_hidden", { hidden: on }).catch(() => {});
  subs.forEach(f => f());
}

export interface WindowChrome {
  /** Empty chrome doubles as the window's title bar (`data-tauri-drag-region`). */
  dragRegion: boolean;
  /** Draw our own minimise/maximise/close cluster at the top bar's right end. */
  customControls: boolean;
  /** Left inset the top bar keeps clear for native controls (the traffic lights). */
  leftClearance: number;
}

function snapshot(): WindowChrome {
  if (IS_MAC && !macPreview) return MAC;
  if (IS_WINDOWS || (IS_MAC && macPreview)) return CUSTOM;
  return NATIVE;
}
const MAC: WindowChrome = { dragRegion: true, customControls: false, leftClearance: MAC_TRAFFIC_LIGHT_CLEARANCE };
const CUSTOM: WindowChrome = { dragRegion: true, customControls: true, leftClearance: 0 };
const NATIVE: WindowChrome = { dragRegion: false, customControls: false, leftClearance: 0 };

export function useWindowChrome(): WindowChrome {
  return useSyncExternalStore(
    cb => { subs.add(cb); return () => { subs.delete(cb); }; },
    snapshot,
  );
}

let lastEdited = false;
/** 34.11: the dot in the close button (macOS). Deduped on the last value sent. */
export function setDocumentEdited(edited: boolean) {
  if (!IS_MAC || edited === lastEdited) return;
  lastEdited = edited;
  invoke("set_document_edited", { edited }).catch(() => {});
}

/** What a title-bar double-click does, per the system preference (`title_double_click_action`). */
export type DoubleClickAction = "zoom" | "minimize" | "none";

export function parseDoubleClickAction(raw: unknown): DoubleClickAction {
  return raw === "minimize" || raw === "none" ? raw : "zoom";
}

export type StripClick = "drag" | "arm-double" | "ignore";

/** Mousedown on the strip: left button, the strip itself (not a child), then click count decides. */
export function stripMouseDown(e: { button: number; detail: number; target: unknown; currentTarget: unknown }): StripClick {
  if (e.button !== 0 || e.target !== e.currentTarget) return "ignore";
  if (e.detail === 1) return "drag";
  if (e.detail === 2) return "arm-double";
  return "ignore";
}

/** Mirrors Tauri's macOS rule: a double-click fires on mouseup, and only if the pointer hasn't moved
 *  since the second mousedown (so a drag right after a double-click is not a zoom). */
export function doubleClickFires(
  up: { button: number; detail: number; clientX: number; clientY: number; target: unknown; currentTarget: unknown },
  down: { x: number; y: number } | null,
): boolean {
  return up.button === 0 && up.detail === 2 && up.target === up.currentTarget
    && !!down && up.clientX === down.x && up.clientY === down.y;
}

async function runDoubleClickAction() {
  let action: DoubleClickAction = "zoom";
  try { action = parseDoubleClickAction(await invoke("title_double_click_action")); } catch { /* default */ }
  const w = getCurrentWindow();
  if (action === "zoom") await w.toggleMaximize();
  else if (action === "minimize") await w.minimize();
}

export interface DragRegionProps {
  "data-tauri-drag-region"?: true;
  onMouseDown?: (e: ReactMouseEvent<HTMLElement>) => void;
  onMouseUp?: (e: ReactMouseEvent<HTMLElement>) => void;
}

let armed: { x: number; y: number } | null = null;

/**
 * Spread onto any empty chrome that should drag the window. Windows keeps Tauri's attribute (its
 * double-click = maximise, which Tauri's script already does). On a Mac the handlers replace it,
 * because Tauri's script always toggles maximise on a double-click, ignoring System Settings.
 */
export function dragRegion(c: WindowChrome, mac: boolean = IS_MAC): DragRegionProps {
  if (!c.dragRegion) return {};
  if (!mac) return { "data-tauri-drag-region": true };
  return {
    onMouseDown: e => {
      const k = stripMouseDown(e);
      if (k === "drag") { e.preventDefault(); getCurrentWindow().startDragging().catch(() => {}); }
      else if (k === "arm-double") { e.preventDefault(); armed = { x: e.clientX, y: e.clientY }; }
    },
    onMouseUp: e => {
      const down = armed;
      armed = null;
      if (doubleClickFires(e, down)) void runDoubleClickAction();
    },
  };
}
