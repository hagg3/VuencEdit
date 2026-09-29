/**
 * ⌘K's "reveal" retry loop (Stage 15.4), kept free of the DOM so node-only vitest can drive it
 * (`reveal.test.ts`). `Ribbon.tsx` supplies the real lookups.
 *
 * After the tab switch, a command's control may not exist yet: it can sit inside a `popup`
 * group's popover or the compact ribbon's overflow popover, both of which only render their
 * contents while open. Each frame: look for the control; if it's missing, click the next opener
 * that isn't already open (each at most once, in the order given), then look again next frame.
 */

import type { CommandPath } from "../commands/meta";
import type { WinId } from "../windows/windowGeometry";

export interface RevealOpener {
  /** Already showing its popover. Clicking a toggle that's open would *close* it. */
  expanded: boolean;
  click(): void;
}

export interface RevealDeps<T> {
  /** The command's on-screen control, or null if it isn't rendered yet. */
  find: () => T | null;
  /** Candidate openers, most specific first, re-queried every attempt (the tab may still be
   *  mounting). A null entry is an opener that doesn't exist right now. */
  openers: () => (RevealOpener | null)[];
  /** Schedule the next attempt (requestAnimationFrame in the app). */
  nextFrame: (cb: () => void) => void;
  onFound: (el: T) => void;
  /** Attempts before giving up silently (default 6 frames). */
  maxTries?: number;
}

export function runReveal<T>({ find, openers, nextFrame, onFound, maxTries = 6 }: RevealDeps<T>): void {
  let tries = 0;
  const clicked = new Set<number>();
  const attempt = () => {
    const el = find();
    if (el) { onFound(el); return; }
    const list = openers();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (!o || clicked.has(i)) continue;
      clicked.add(i);
      if (!o.expanded) { o.click(); break; }
    }
    if (++tries < maxTries) nextFrame(attempt);
  };
  nextFrame(attempt);
}

/**
 * Stage 16.6: some controls live in a **context panel** rather than a ribbon group (a
 * `{ panel }` entry in a command's `also`). ⌘K should flash that panel's copy — instead of
 * switching tabs — when the panel is on screen and the active tab has no control of its own for the
 * command. Returns the panel to reveal into, or null to use the normal tab/group path.
 */
export function panelToReveal(
  places: readonly CommandPath[], activeTab: string, activePanels: readonly WinId[],
): WinId | null {
  if (places.some(p => "tab" in p && p.tab === activeTab)) return null;
  for (const p of places) if ("panel" in p && activePanels.includes(p.panel)) return p.panel;
  return null;
}
