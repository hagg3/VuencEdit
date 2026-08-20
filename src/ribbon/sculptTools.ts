/**
 * The sixteen sculpt tools, in frequency order: the four primaries get large buttons, the rest live
 * in a "More tools" dropdown menu (mirrors the Draw tab's Shape split/dropdown button). Module scope
 * so the Sculpt tab and the 3D tab's Sculpt mode share one source of truth (they are one brush —
 * same state, same backend command).
 */
import type { Tool } from "../MapCanvas";
import type { IconName } from "./icons";

export interface SculptToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  title: string;
}

/** Raise / Lower / Rock / Carve — the four big prominent commands. */
export const SCULPT_PRIMARY: SculptToolDef[] = [
  { id: "raise", icon: "raise", label: "Raise", title: "Raise — drag to pull terrain up" },
  { id: "lower", icon: "lower", label: "Lower", title: "Lower — drag to dig down" },
  { id: "rock", icon: "rock", label: "Rock", title: "Rock — volumetric mass fused into the terrain (ignores Strength/Softness; Radius sets its size)" },
  { id: "carve", icon: "carve", label: "Carve", title: "Carve — cuts a filleted depression, sky-connected material only (ignores Strength/Softness)" },
];

/** Everything else, reached through the "More tools" menu. */
export const SCULPT_MORE: SculptToolDef[] = [
  { id: "smooth", icon: "smooth", label: "Smooth", title: "Smooth — average neighbouring heights" },
  { id: "flatten", icon: "flatten", label: "Flatten", title: "Flatten — level terrain to the height you clicked" },
  { id: "slope", icon: "slope", label: "Slope", title: "Slope — flatten to a tilted plane (set Slope X/Y in Tool Options)" },
  { id: "noise", icon: "noise", label: "Noise", title: "Noise — coherent hills or mountains" },
  { id: "erode", icon: "erode", label: "Erode", title: "Erode — drop each column toward its lowest neighbour" },
  { id: "thermal", icon: "thermal", label: "Thermal", title: "Thermal — talus-angle erosion, scree slopes" },
  { id: "hydro", icon: "hydro", label: "Hydro", title: "Hydro — droplet hydraulic erosion, carves channels" },
  { id: "terrace", icon: "terrace", label: "Terrace", title: "Terrace — quantize height into Strength-block steps" },
  { id: "sharpen", icon: "sharpen", label: "Sharpen", title: "Sharpen — crisps terrain, the inverse of Smooth" },
  { id: "smear", icon: "smear", label: "Smear", title: "Smear — drag to pull height along with the brush" },
  { id: "grab", icon: "grab", label: "Grab", title: "Grab — press and drag up/down to pull terrain" },
  { id: "stamp", icon: "stamp", label: "Retexture", title: "Retexture — repaint the surface by slope" },
];

export const SCULPT_ALL: SculptToolDef[] = [...SCULPT_PRIMARY, ...SCULPT_MORE];

export const SCULPT_TOOL_IDS: Tool[] = SCULPT_ALL.map(t => t.id);

/** Rock and Carve are volumetric and share one parameter block; Retexture consumes the palette. */
export const SCULPT_USES_PALETTE = (t: Tool) => t === "rock" || t === "stamp";
export const SCULPT_IS_VOLUMETRIC = (t: Tool) => t === "rock" || t === "carve";

/** The newer/less-battle-tested tools, each flagged individually in the "More tools" menu rather
 *  than the whole module carrying one blanket EXP badge — Raise/Lower/Rock/Carve/Smooth/Flatten
 *  are considered stable. */
const EXPERIMENTAL: ReadonlySet<Tool> = new Set([
  "slope", "noise", "erode", "thermal", "hydro", "terrace", "sharpen", "smear", "grab", "stamp",
]);
export const SCULPT_IS_EXPERIMENTAL = (t: Tool) => EXPERIMENTAL.has(t);
