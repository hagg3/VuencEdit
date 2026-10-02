/**
 * A context panel (Stage 16.5) — a `FloatingWindow` that renders from its mode's `when` predicate
 * instead of a user open/close toggle. The rules live in `contextPanels.ts` (pure, tested); this
 * wrapper only wires them to React: the render gate, registration for stacking, the appear/disappear
 * cue, and ✕ → `onExit` (leave the mode — plan Q1). Omitting `onExit` removes the ✕ entirely, for a
 * panel with no natural "off" mode (Q3: the sculpt brush-shape panel follows its tool).
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import FloatingWindow, { type FloatingWindowProps } from "./FloatingWindow";
import { CONTEXT_PANELS, contextPanelShown, resizeDirsFor, stackOffsets } from "./contextPanels";
import { setContextActive, useWindowLayout } from "./useWindowLayout";
import { setContentSize, type Size } from "./windowGeometry";
import { sfx } from "../sound/sfx";

export interface ContextPanelProps extends Omit<FloatingWindowProps, "onClose" | "offsetY" | "resizeDirs" | "closable"> {
  /** The mode predicate: the panel exists exactly while this holds (and a world is loaded). */
  when: boolean;
  worldLoaded: boolean;
  /** ✕ = leave the mode. Omit for a panel that has no ✕ and just follows its mode. */
  onExit?: () => void;
  /** `userToggle` panels: overrides the stored `wins[id].open` as the user's on/off (the Lens's
   *  per-mode flags, 20.4). */
  enabled?: boolean;
  /** The panel's live content size (16.6, `PANEL_SIZES`): pins its rendered size for as long as it's
   *  shown, so a panel whose content changes with the mode (Noise vs Rock) grows/shrinks with it. */
  contentSize?: Size;
}

export default function ContextPanel({ when, worldLoaded, onExit, enabled, contentSize, ...win }: ContextPanelProps) {
  const { id } = win;
  const def = CONTEXT_PANELS[id];
  const layout = useWindowLayout();
  const shown = def != null && contextPanelShown(id, { when, worldLoaded, open: layout.wins[id].open, enabled });
  // Registered *during render*, not in an effect: `FloatingWindow` (a child) reads `winLimits` in the
  // same pass, and an effect would let it paint one frame at the previous variant's size. The write
  // is to module state and idempotent, so StrictMode's double render is harmless.
  setContentSize(id, shown && contentSize ? contentSize : null);
  useLayoutEffect(() => () => setContentSize(id, null), [id]);

  // Layout effects so a panel's stacking slot is claimed/released before paint — two panels
  // appearing together never flash on top of each other for a frame.
  useLayoutEffect(() => { setContextActive(id, shown); }, [id, shown]);
  useLayoutEffect(() => () => setContextActive(id, false), [id]);

  // `menu` cue on a real transition only — not on mount (a world opening mid-mode isn't an event).
  const prevShown = useRef(shown);
  useEffect(() => {
    if (prevShown.current === shown) return;
    prevShown.current = shown;
    if (def?.cue) sfx.play("menu");
  }, [shown, def]);

  if (!shown || !def) return null;
  const offsetY = stackOffsets(layout.activeContext, layout.wins, layout.work)[id] ?? 0;
  return (
    <FloatingWindow
      {...win}
      offsetY={offsetY}
      resizeDirs={resizeDirsFor(def.resize)}
      closable={onExit != null}
      onClose={onExit}
      open
    />
  );
}
