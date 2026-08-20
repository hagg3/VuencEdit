/**
 * The onboarding-tour engine. Purely presentational over `steps.tsx`'s declarative array — it
 * owns only `stepIndex` and the measured target rect. See CLAUDE.md's "Onboarding Tour" note and
 * `~/.claude/plans/please-plan-an-on-boarding-golden-sutherland.md` for the design rationale.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../Modal";
import { ACCENT, BORDER, FONT, RADIUS, SPACE, SURFACE, TEXT, TEXT_DIM, btnBase } from "../ribbon/tokens";
import type { TourCtx, TourStep } from "./steps";

/** Plain object, not a live `DOMRect` — keeps `placeCard` pure and node-testable. */
export interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }

const CARD_W = 340;
const GAP = 14;
const MARGIN = 8;

/**
 * Pure geometry: picks the side of `rect` with the most room (or the caller's `placement`) and
 * clamps the result into the viewport. `rect === null` centres the card. Exported for
 * `placement.test.ts` — the tour's only automated coverage, mirroring `ribbon/layout.test.ts`.
 */
export function placeCard(
  rect: Rect | null,
  card: { w: number; h: number },
  vw: number,
  vh: number,
  placement: "auto" | "top" | "bottom" | "left" | "right" = "auto",
): { top: number; left: number } {
  const clampAxis = (v: number, size: number, total: number) =>
    Math.max(MARGIN, Math.min(v, total - size - MARGIN));

  if (!rect) {
    return {
      top: clampAxis((vh - card.h) / 2, card.h, vh),
      left: clampAxis((vw - card.w) / 2, card.w, vw),
    };
  }

  const spaces = { top: rect.top, bottom: vh - rect.bottom, left: rect.left, right: vw - rect.right };
  let side = placement;
  if (side === "auto") {
    side = "bottom";
    let best = -Infinity;
    for (const s of ["top", "bottom", "left", "right"] as const) {
      if (spaces[s] > best) { best = spaces[s]; side = s; }
    }
  }

  let top: number, left: number;
  if (side === "bottom") {
    top = rect.bottom + GAP;
    left = rect.left + rect.width / 2 - card.w / 2;
  } else if (side === "top") {
    top = rect.top - GAP - card.h;
    left = rect.left + rect.width / 2 - card.w / 2;
  } else if (side === "left") {
    top = rect.top + rect.height / 2 - card.h / 2;
    left = rect.left - GAP - card.w;
  } else {
    top = rect.top + rect.height / 2 - card.h / 2;
    left = rect.right + GAP;
  }

  return {
    top: clampAxis(top, card.h, vh),
    left: clampAxis(left, card.w, vw),
  };
}

/**
 * Just the keyframes — whether they're applied is decided in JS (see `usesReducedMotion` below),
 * not by a `prefers-reduced-motion` media query in this block. An earlier version put the opt-out
 * in CSS (`@media (prefers-reduced-motion: reduce) { animation: none !important; ... }` on the
 * same class the animation lives on) and that combination froze the whole app — a dimmed overlay
 * with no card ever appearing — on a real device with Reduce Motion on, even though nothing here
 * reads that media query in JS. Root cause not chased down (WKWebView-specific `@media` + inline
 * `<style>` + `!important` interaction is the leading suspect); the JS branch sidesteps it and is
 * no more code.
 */
const TOUR_CSS = `
@keyframes eden-tour-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0,164,173,.55); }
  50% { box-shadow: 0 0 0 7px rgba(0,164,173,0); }
}
.eden-tour-ring { animation: eden-tour-pulse 1.6s ease-in-out infinite; }
`;

function prefersReducedMotion(): boolean {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; }
  catch { return false; }
}

/** Bounding box containing every rect in `rects` (ignoring nulls). `null` if none measured. */
function unionRects(rects: (Rect | null)[]): Rect | null {
  const present = rects.filter((r): r is Rect => r != null);
  if (present.length === 0) return null;
  const top = Math.min(...present.map((r) => r.top));
  const left = Math.min(...present.map((r) => r.left));
  const right = Math.max(...present.map((r) => r.right));
  const bottom = Math.max(...present.map((r) => r.bottom));
  return { top, left, right, bottom, width: right - left, height: bottom - top };
}

export default function TourOverlay({
  steps, ctx, onClose,
}: { steps: TourStep[]; ctx: TourCtx; onClose: (completed: boolean) => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [secondaryRects, setSecondaryRects] = useState<Rect[]>([]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[stepIndex];
  const total = steps.length;
  const [reducedMotion] = useState(prefersReducedMotion);
  // Spotlight cutout — the primary target unioned with any secondary ones (e.g. the ribbon's tab
  // strip, folded in so it isn't dimmed into illegibility while a step points at a group below
  // it). The pulsing ring below still tracks the primary `rect` alone. Memoized: an unmemoized
  // `unionRects` call would mint a new object every render, and the placement effect below is
  // keyed on this value — a fresh reference each render would re-run it (and `setPos`) forever.
  const cutout = useMemo(() => unionRects([rect, ...secondaryRects]), [rect, secondaryRects]);

  useFocusTrap(cardRef);

  // Guided-passive reveal — runs before the rect is measured. `useLayoutEffect` so any state
  // update it triggers upstream (App) commits before the browser paints, which is what makes the
  // rAF measurement below see the post-reveal DOM instead of a stale one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { step.before?.(ctx); }, [stepIndex]);

  // Re-measure after the reveal settles (rAF, i.e. after paint), on resize, and on any body
  // reflow (opening the sidebar/toolbar changes layout without necessarily firing `resize`).
  useEffect(() => {
    const toRect = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const measure = () => {
      if (!step.target) { setRect(null); setSecondaryRects([]); return; }
      const el = document.querySelector(step.target);
      if (!el) {
        if (import.meta.env.DEV) {
          console.warn(`[tour] step "${step.id}" target not found: ${step.target} — showing centred card`);
        }
        setRect(null);
        setSecondaryRects([]);
        return;
      }
      setRect(toRect(el));
      setSecondaryRects(
        (step.secondaryTargets ?? [])
          .map((sel) => document.querySelector(sel))
          .filter((e): e is Element => e != null)
          .map(toRect),
      );
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", measure); ro.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // Card placement — re-run whenever the measured rect changes or the card's own content
  // (title/body length varies per step) resizes it.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    setPos(placeCard(cutout, { w: el.offsetWidth, h: el.offsetHeight }, window.innerWidth, window.innerHeight, step.placement ?? "auto"));
  }, [cutout, stepIndex, step.placement]);

  const next = () => { if (stepIndex + 1 >= total) onClose(true); else setStepIndex((i) => i + 1); };
  const back = () => setStepIndex((i) => Math.max(0, i - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  const PAD = step.padding ?? 6;

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 9990 }}>
      <style>{TOUR_CSS}</style>
      {/* Swallows every click so the app is inert during the tour. Transparent when a spotlight
          supplies the scrim itself (its box-shadow paints both the dim and the cutout); its own
          background otherwise (centred, no-target steps). */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "auto", background: cutout ? "transparent" : "rgba(8,12,16,.66)" }} />
      {cutout && (
        <div style={{
          position: "fixed",
          top: cutout.top - PAD, left: cutout.left - PAD,
          width: cutout.width + PAD * 2, height: cutout.height + PAD * 2,
          borderRadius: 4, pointerEvents: "none",
          boxShadow: "0 0 0 9999px rgba(8,12,16,.66)",
        }} />
      )}
      {rect && (
        <div className={reducedMotion ? undefined : "eden-tour-ring"} style={{
          position: "fixed",
          top: rect.top - PAD - 2, left: rect.left - PAD - 2,
          width: rect.width + PAD * 2 + 4, height: rect.height + PAD * 2 + 4,
          borderRadius: 6, pointerEvents: "none",
          boxShadow: `0 0 0 2px ${ACCENT.primary}`,
        }} />
      )}
      <div
        ref={cardRef}
        role="dialog" aria-modal="true" aria-labelledby="eden-tour-title"
        style={{
          position: "fixed",
          top: pos?.top ?? -9999, left: pos?.left ?? -9999,
          visibility: pos ? "visible" : "hidden",
          width: CARD_W,
          background: SURFACE.popover, color: TEXT,
          boxShadow: `inset 0 0 0 1px ${BORDER.outline}, inset 0 1px 0 ${BORDER.bevel}, 0 12px 32px rgba(0,0,0,.6)`,
          borderRadius: RADIUS.lg, padding: SPACE.lg + 8, fontSize: FONT.body,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: SPACE.md }}>
          <span style={{ color: TEXT_DIM, fontSize: FONT.label, fontWeight: 700 }}>{stepIndex + 1} / {total}</span>
          <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
            {steps.map((s, i) => (
              <span key={s.id} style={{
                width: 5, height: 5, borderRadius: 3,
                background: i === stepIndex ? ACCENT.primary : BORDER.hairline,
              }} />
            ))}
          </div>
        </div>
        <div id="eden-tour-title" style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{step.title}</div>
        <div style={{ color: TEXT_DIM, lineHeight: 1.5, marginBottom: SPACE.lg + 6 }}>{step.body}</div>
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          <button type="button" onClick={() => onClose(false)}
            style={btnBase({ padding: "5px 10px", color: TEXT_DIM })}>
            Skip tour
          </button>
          <div style={{ marginLeft: "auto", display: "flex", gap: SPACE.sm }}>
            {stepIndex > 0 && (
              <button type="button" onClick={back} style={btnBase({ padding: "5px 12px" })}>Back</button>
            )}
            <button type="button" onClick={next} style={btnBase({
              padding: "5px 14px", fontWeight: 700, color: TEXT,
              background: ACCENT.primary, boxShadow: "none",
            })}>
              {stepIndex + 1 >= total ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
