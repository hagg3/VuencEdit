/**
 * Which viewport goes where (UI redesign r3, Stage 14.4; Quad retired in Stage 16.4). Pure — the
 * truth table is unit-tested.
 *
 * This is the **one** definition of `pane3dLive`; every 3D overlay, the mode reset and the context
 * menu's camera commands read it rather than re-deriving it.
 */

export interface LayoutInputs {
  /** 3D is the main pane and the map is in the window. */
  swapped: boolean;
  view3dOpen: boolean;
  view3dCollapsed: boolean;
}

/**
 * Is the 3D view actually on screen (so FlyView3D must run)? `suspended = !pane3dLive`.
 * - swapped: 3D is the main pane → always live.
 * - not swapped: live iff the 3D window is open *and expanded* (a collapsed window renders no
 *   body, so the canvas is detached — it must suspend).
 */
export function computePane3dLive(i: LayoutInputs): boolean {
  if (i.swapped) return true;
  return i.view3dOpen && !i.view3dCollapsed;
}

export type Viewport = "map" | "fly";

export interface Placement {
  /** What fills the main work area. */
  main: Viewport;
  /** What the `view3d` window's body shows (`null` = the window isn't rendered). */
  window: Viewport | null;
}

export function computePlacement(i: LayoutInputs): Placement {
  const inWindow: Viewport = i.swapped ? "map" : "fly";
  return {
    main: i.swapped ? "fly" : "map",
    window: i.view3dOpen && !i.view3dCollapsed ? inWindow : null,
  };
}
