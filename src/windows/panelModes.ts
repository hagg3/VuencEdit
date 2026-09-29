/**
 * The mode → context-panel rules for the three panels that replaced contextual ribbon groups
 * (Stage 16.6). Pure, so the `when` predicates, the size variant each mode picks and the ✕ targets
 * are unit-tested in node (`panelModes.test.ts`); `modePanels.tsx` is the React side.
 */
import type { Tool } from "../MapCanvas";
import type { MapViewMode } from "../ribbon/props";
import { PANEL_SIZES, type Size } from "./windowGeometry";

export type Mode3d = "off" | "select" | "build" | "sculpt" | "floodfill";

/** Cutaway / Z-slice level: while the map is in either sliced view. ✕ returns to Top-down. */
export const cutawayWhen = (viewMode: MapViewMode): boolean => viewMode === "cutaway" || viewMode === "zslice";
export const CUTAWAY_EXIT: MapViewMode = "topdown";

/** Brush shape: the four sculpt tools that carry their own shape parameters. No ✕ (plan Q3) — it
 *  follows the tool, and a sculpt tool has no natural "off". */
export const BRUSH_SHAPE_TOOLS: readonly Tool[] = ["noise", "slope", "rock", "carve"];
export const brushShapeWhen = (tool: Tool): boolean => BRUSH_SHAPE_TOOLS.includes(tool);
export type BrushShapeVariant = "noise" | "slope" | "volumetric";
export const brushShapeVariant = (tool: Tool): BrushShapeVariant =>
  tool === "noise" ? "noise" : tool === "slope" ? "slope" : "volumetric";
export const brushShapeSize = (tool: Tool): Size => PANEL_SIZES.brushshape[brushShapeVariant(tool)];

/** 3D build slot: Flood Fill's limit / the 3D Sculpt brush. Needs the 3D view actually on screen
 *  (`mode3d` is reset to "off" whenever it isn't, but a stale value must never pop the panel).
 *  ✕ returns to Build (place). */
export const buildSlotWhen = (mode3d: Mode3d, pane3dLive: boolean): boolean =>
  pane3dLive && (mode3d === "floodfill" || mode3d === "sculpt");
export const BUILD_SLOT_EXIT: Mode3d = "build";
export const buildSlotSize = (mode3d: Mode3d): Size =>
  mode3d === "sculpt" ? PANEL_SIZES.buildslot.sculpt : PANEL_SIZES.buildslot.floodfill;
