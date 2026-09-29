/**
 * Hotbar state (UI redesign r3, Stage 14.5) — extracted out of `App.tsx` verbatim: same
 * `localStorage` keys, same fixed-length-array persistence format, same digit-key ordering
 * (1–5 pinned, 6–0 recent). No fork — App's digit-key handler reads `pinnedBlocksRef`/
 * `recentBlocksRef` exactly as before, just through this hook instead of local state.
 *
 * `loadHotbar`/`saveHotbar` are exported standalone (not just used internally) so they're
 * unit-testable with an in-memory `localStorage` shim without mounting React.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { blockDisplayName, resolveColor } from "../blockDefs";
import { tintedSwatch, type AtlasData } from "../texturePack";

const HOTBAR_PINNED_KEY = "eden_hotbar_pinned";
const HOTBAR_RECENT_KEY = "eden_hotbar_recent";

export type HotbarSlot = { type: number; paint: number } | null;
export type HotbarBlock = { type: number; paint: number };
/** Precomputed 3D-overlay/hotbar-window slot shape — resolved colour/texture-pack swatch + name,
 *  so consumers (FlyView3D, HotbarWindow) don't need their own `resolveColor`/`tintedSwatch` import. */
export type Hotbar3DSlot = { type: number; paint: number; css: string; label: string };

/** Stored as a fixed-length array of `{type,paint}|null` so a pinned slot keeps its index across
 *  restarts; unknown/garbage entries decode to null rather than throwing. */
export function loadHotbar(key: string, len: number): HotbarSlot[] {
  const out: HotbarSlot[] = Array(len).fill(null);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return out;
    for (let i = 0; i < Math.min(len, parsed.length); i++) {
      const b = parsed[i];
      if (b && Number.isFinite(b.type) && Number.isFinite(b.paint)) out[i] = { type: b.type, paint: b.paint };
    }
  } catch { /* corrupt entry → empty hotbar */ }
  return out;
}

export function saveHotbar(key: string, slots: readonly HotbarSlot[]) {
  try { localStorage.setItem(key, JSON.stringify(slots)); } catch { /* quota / private mode */ }
}

export interface UseHotbarResult {
  pinnedBlocks: HotbarSlot[];
  recentBlocks: HotbarBlock[];
  setPinnedBlocks: React.Dispatch<React.SetStateAction<HotbarSlot[]>>;
  /** Refs mirroring the state, read by App's global keydown handler (which must not re-register
   *  its listener on every hotbar change). */
  pinnedBlocksRef: React.RefObject<HotbarSlot[]>;
  recentBlocksRef: React.RefObject<HotbarBlock[]>;
  hotbarHover: string | null;
  setHotbarHover: (v: string | null) => void;
  /** 10-slot data for the 3D pane's in-build overlay and the Hotbar window (5 pinned + 5 recent,
   *  matching the digit-key ordering). */
  hotbar3dSlots: (Hotbar3DSlot | null)[];
  /** Push a used block+paint onto the front of Recent, de-duping and capping at 5. */
  trackRecentBlock: (type: number, paint: number) => void;
  /** Pin a recent block into the first empty pinned slot, or slot 5 if all full (ported from
   *  `PaletteGroup`'s `HotbarRow`). */
  pinFromRecent: (b: HotbarBlock) => void;
  /** Clear one pinned slot. */
  unpinSlot: (idx: number) => void;
}

export function useHotbar(texturePackInfo: AtlasData | null | undefined): UseHotbarResult {
  const [pinnedBlocks, setPinnedBlocks] = useState<HotbarSlot[]>(() => loadHotbar(HOTBAR_PINNED_KEY, 5));
  const [recentBlocks, setRecentBlocks] = useState<HotbarBlock[]>(
    () => loadHotbar(HOTBAR_RECENT_KEY, 5).filter((b): b is HotbarBlock => b !== null));
  useEffect(() => { saveHotbar(HOTBAR_PINNED_KEY, pinnedBlocks); }, [pinnedBlocks]);
  useEffect(() => { saveHotbar(HOTBAR_RECENT_KEY, recentBlocks); }, [recentBlocks]);
  const pinnedBlocksRef = useRef(pinnedBlocks);
  useEffect(() => { pinnedBlocksRef.current = pinnedBlocks; }, [pinnedBlocks]);
  const recentBlocksRef = useRef(recentBlocks);
  useEffect(() => { recentBlocksRef.current = recentBlocks; }, [recentBlocks]);
  const [hotbarHover, setHotbarHover] = useState<string | null>(null);

  const hotbar3dSlots = useMemo(() => {
    const swatchCss = (type: number, paint: number): string => {
      const url = texturePackInfo ? tintedSwatch(type, paint, texturePackInfo) : null;
      if (url) return `url(${url}) center/cover`;
      const [r, g, b] = resolveColor(type, paint);
      return `rgb(${r},${g},${b})`;
    };
    const pinned = pinnedBlocks.map(b => b ? { type: b.type, paint: b.paint, css: swatchCss(b.type, b.paint), label: blockDisplayName(b.type) } : null);
    const recent = recentBlocks.map(b => ({ type: b.type, paint: b.paint, css: swatchCss(b.type, b.paint), label: blockDisplayName(b.type) }));
    return [...pinned, ...recent.slice(0, 5)];
  }, [pinnedBlocks, recentBlocks, texturePackInfo]);

  function trackRecentBlock(type: number, paint: number) {
    setRecentBlocks(prev => {
      const filtered = prev.filter(b => !(b.type === type && b.paint === paint));
      return [{ type, paint }, ...filtered].slice(0, 5);
    });
  }

  function pinFromRecent(b: HotbarBlock) {
    setPinnedBlocks(prev => {
      const n = [...prev];
      const i = n.findIndex(s => s === null);
      if (i !== -1) { n[i] = b; return n; }
      n[4] = b;
      return n;
    });
  }

  function unpinSlot(idx: number) {
    setPinnedBlocks(prev => { const n = [...prev]; n[idx] = null; return n; });
  }

  return {
    pinnedBlocks, recentBlocks, setPinnedBlocks, pinnedBlocksRef, recentBlocksRef,
    hotbarHover, setHotbarHover, hotbar3dSlots, trackRecentBlock, pinFromRecent, unpinSlot,
  };
}
