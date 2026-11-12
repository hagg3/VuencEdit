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
import { invoke } from "@tauri-apps/api/core";
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

/** Spread onto any empty chrome that should drag the window. */
export function dragRegion(c: WindowChrome): { "data-tauri-drag-region"?: true } {
  return c.dragRegion ? { "data-tauri-drag-region": true } : {};
}
