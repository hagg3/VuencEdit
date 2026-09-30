/**
 * A completion outline (Stage 14.13, MO.B): a brief rectangle flashed around the world-rect a
 * successful user edit just touched. Deliberately a **DOM overlay**, positioned via
 * `MapCanvasRef.worldRectToScreen` (the same rect/view transform the paste-lens ghost subscription
 * uses — see that method's doc comment) — never drawn into the map `<canvas>` itself. The canvas's
 * own pixels are owned by `applyPatch`/`refetchRegion`; a second `ctx.strokeRect` call per frame
 * would fight that, whereas a `position:fixed` div animated on the GPU compositor (transform/
 * opacity only) costs nothing extra to the canvas repaint path.
 *
 * Static (appears, holds, disappears) unless `:root[data-motion="full"]` — see `src/theme/motion.ts`
 * for the JS gate. Either way it self-clears after `MOTION.doneMs` via its own timer, so a user
 * with motion off never gets a rectangle that lingers forever.
 */
import { useEffect, useRef, useState } from "react";
import type { MapCanvasRef } from "../MapCanvas";
import { ACCENTS, MOTION } from "../theme/theme";

/** One flash request: a world-space rect plus a key that changes per edit, so back-to-back edits
 *  at the same location still restart the effect (object identity, not just field equality). */
export interface DoneRect {
  key: number;
  /** `done` (default): an edit landed, teal. `select`: a selection was committed, blue, shorter. */
  tone?: "done" | "select";
  x: number;
  y: number;
  w: number;
  h: number;
}

type ScreenRect = { left: number; top: number; width: number; height: number };

export default function DoneOutline({
  rect, mapCanvasRef,
}: {
  rect: DoneRect | null;
  mapCanvasRef: React.RefObject<MapCanvasRef | null>;
}) {
  const [screen, setScreen] = useState<ScreenRect | null>(null);
  const rafRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    if (!rect) { setScreen(null); return; }

    // Re-measure every frame for the outline's short lifetime — a pan/zoom mid-flash (rare, but a
    // trailing edit's flash can outlive the gesture that triggered it) should track the map instead
    // of freezing at a now-wrong screen position.
    const tick = () => {
      setScreen(mapCanvasRef.current?.worldRectToScreen(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h) ?? null);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    hideTimerRef.current = window.setTimeout(() => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setScreen(null);
    }, rect.tone === "select" ? MOTION.selectMs : MOTION.doneMs);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [rect, mapCanvasRef]);

  if (!screen || screen.width <= 0 || screen.height <= 0) return null;

  return (
    <div
      aria-hidden
      className="vx-done-outline"
      data-tone={rect?.tone === "select" ? "select" : undefined}
      style={{
        position: "fixed",
        left: screen.left, top: screen.top, width: screen.width, height: screen.height,
        pointerEvents: "none",
        zIndex: 90, // Above the map (20), below the ribbon (100) and QuickActionsBar chrome.
        boxSizing: "border-box",
        border: `2px solid ${rect?.tone === "select" ? ACCENTS.selection : ACCENTS.primary}`,
        borderRadius: 2,
      }}
    />
  );
}
