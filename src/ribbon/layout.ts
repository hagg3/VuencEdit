/**
 * The ribbon's responsive tier solver — a **pure function**, deliberately, because this repo's
 * vitest runs in a node environment over `src/**\/*.test.ts` only: components are untestable here,
 * so the one piece of this redesign with real branching logic is kept outside of them.
 *
 * Replaces the old mechanism entirely (horizontal scroll behind ◄ ► arrows + a wheel→horizontal
 * remap), which hid commands rather than resizing them. Since Stage 15.4 the ribbon never scrolls
 * at all: the body is `overflowX: hidden`, and the solver guarantees the row fits down to the
 * width of every group collapsed to its popup button (`minRowWidth`).
 */

/**
 * Widest → narrowest. `popup` is the Microsoft ribbon guidelines' "pop-up group icon": the whole
 * group becomes one large button (icon, group label, ▾) that opens the group's full content in a
 * `Popover`. It used to be called `compact`, which collided with the compact command-bar ribbon
 * (14.10) — a different thing entirely.
 */
export type Tier = "full" | "medium" | "popup";

/** Widest → narrowest. Demotion always walks this order one step at a time. */
export const TIER_ORDER: Tier[] = ["full", "medium", "popup"];

export interface GroupMetrics {
  id: string;
  /** Declared (not measured) rendered width at each tier — see the drift guard in `Group`. */
  widths: Record<Tier, number>;
  /**
   * The *graceful* floor: the narrowest tier this group reaches while the rest of the row can
   * still shrink. `"full"` keeps a small group whole (MS guidance: don't collapse a two-command
   * group into a popup), `"medium"` keeps it visible but shrunk. It is **not** absolute — once
   * every group is at its floor and the row still overflows, the last-resort pass collapses
   * groups to `popup` regardless (`solveLayout`), because a clipped group is unreachable.
   */
  minTier: Tier;
  /** Higher = demoted sooner. Runs right-to-left by importance within a tab. */
  priority: number;
  /**
   * A contextual group (the live controls of the current mode — Z-slice level, sculpt tool
   * options, the 3D build slot). The last-resort pass collapses these only after every other
   * group already has.
   */
  conditional?: boolean;
}

export function tierIndex(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

/** Content inside a group renders large unless the group itself is at `medium`: a `popup` group's
 *  popover shows the group's full-tier layout (MS: the popup is the group at its largest). */
export function contentTier(t: Tier): Tier {
  return t === "medium" ? "medium" : "full";
}

/**
 * The tier a group demotes to from `cur` in the graceful pass, or `null` if it can't shrink
 * further. A tier that is **no narrower than the current one** is skipped: several groups (a row
 * of large buttons whose medium form is a column of labelled small ones) measure *wider* at medium
 * (14.7's harvest), so stepping into it would grow the row. Such a group goes straight to `popup`
 * if its `minTier` allows, and otherwise stays put. (Likewise a group narrower than a popup button
 * never becomes one.)
 */
function nextNarrowerTier(g: GroupMetrics, cur: number): Tier | null {
  const min = tierIndex(g.minTier);
  for (let next = cur + 1; next <= min; next++) {
    if (g.widths[TIER_ORDER[next]] < g.widths[TIER_ORDER[cur]]) return TIER_ORDER[next];
  }
  return null;
}

/** Total declared width of `groups` at the given tiers (no dividers — see `solveRow`). */
export function rowWidth(groups: GroupMetrics[], tiers: Record<string, Tier>): number {
  return groups.reduce((sum, g) => sum + g.widths[tiers[g.id] ?? "full"], 0);
}

/**
 * Assign each group the widest tier that still lets the whole row fit in `available` px.
 *
 * **Graceful pass.** Start everything at `full`; while the row overflows, demote one group one
 * tier (down to its `minTier`) and re-sum. The victim is chosen **widest-tier first, then highest
 * priority** — so the whole row steps `full → medium` in priority order before *any* group
 * collapses into a popup. Picking purely by priority instead would hide the least-important group
 * behind a popup while its neighbours were still at full size, which reads as a bug rather than as
 * responsive layout.
 *
 * **Last-resort pass (15.4).** If every group is at its floor and the row still overflows,
 * collapse groups straight to `popup`, ignoring `minTier`: non-contextual groups first, highest
 * priority first (ties by declaration order), then contextual ones the same way. Nothing is ever
 * re-promoted, so both passes are monotonic in `available` — a narrower window never widens a
 * group. Below `minRowWidth` the result is everything-at-popup and the caller clips.
 */
export function solveLayout(groups: GroupMetrics[], available: number): Record<string, Tier> {
  const tiers: Record<string, Tier> = {};
  for (const g of groups) tiers[g.id] = "full";
  const fits = () => rowWidth(groups, tiers) <= available;

  // Bounded by (#groups × #tiers) demotions; the guard is belt-and-braces against a bad minTier.
  for (let step = 0; step < groups.length * TIER_ORDER.length + 1 && !fits(); step++) {
    let victim: GroupMetrics | null = null;
    let victimTier = 0;
    let victimNext: Tier = "full";
    for (const g of groups) {
      const cur = tierIndex(tiers[g.id]);
      const next = nextNarrowerTier(g, cur);
      if (!next) continue; // already at its floor
      // Ties (same tier, same priority) fall to declaration order, so the solve is deterministic.
      if (!victim || cur < victimTier || (cur === victimTier && g.priority > victim.priority)) {
        victim = g;
        victimTier = cur;
        victimNext = next;
      }
    }
    if (!victim) break; // every group is at its floor
    tiers[victim.id] = victimNext;
  }

  if (!fits()) {
    // Stable sort: equal keys keep declaration order.
    const order = [...groups].sort((a, b) =>
      Number(!!a.conditional) - Number(!!b.conditional) || b.priority - a.priority);
    for (const g of order) {
      if (fits()) break;
      // Collapsing only helps if the popup is actually narrower than what the group shows now.
      if (tiers[g.id] !== "popup" && g.widths.popup < g.widths[tiers[g.id]]) tiers[g.id] = "popup";
    }
  }

  return tiers;
}

/** The narrowest the row can ever get — every group as narrow as the solver will take it. The
 *  "always fits" guarantee holds for any `available` ≥ this. */
export function minRowWidth(groups: GroupMetrics[]): number {
  return rowWidth(groups, solveLayout(groups, 0));
}
