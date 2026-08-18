/**
 * The ribbon's responsive tier solver — a **pure function**, deliberately, because this repo's
 * vitest runs in a node environment over `src/**\/*.test.ts` only: components are untestable here,
 * so the one piece of this redesign with real branching logic is kept outside of them.
 *
 * Replaces the old mechanism entirely (horizontal scroll behind ◄ ► arrows + a wheel→horizontal
 * remap), which hid commands rather than resizing them.
 */

export type Tier = "full" | "medium" | "compact";

/** Widest → narrowest. Demotion always walks this order one step at a time. */
export const TIER_ORDER: Tier[] = ["full", "medium", "compact"];

export interface GroupMetrics {
  id: string;
  /** Declared (not measured) rendered width at each tier — see the drift guard in `Group`. */
  widths: Record<Tier, number>;
  /**
   * Narrowest tier this group may be demoted to. `"full"` exempts a group from shrinking at all
   * (MS guidance: don't collapse a two-command group into a popup icon), `"medium"` keeps it
   * visible but shrunk, `"compact"` allows the single-chevron popup form.
   */
  minTier: Tier;
  /** Higher = demoted sooner. Runs right-to-left by importance within a tab. */
  priority: number;
}

export function tierIndex(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

/**
 * Assign each group the widest tier that still lets the whole row fit in `available` px.
 *
 * Start everything at `full`; while the row overflows, demote one group one tier and re-sum.
 * The victim is chosen **widest-tier first, then highest priority** — so the whole row steps
 * `full → medium` in priority order before *any* group collapses into a `compact` popup. Picking
 * purely by priority instead would hide the least-important group behind a chevron while its
 * neighbours were still at full size, which reads as a bug rather than as responsive layout.
 *
 * When nothing can demote any further the result is simply the narrowest achievable layout —
 * the caller keeps `overflowX: auto` as a silent last resort below the minimum width.
 */
export function solveLayout(groups: GroupMetrics[], available: number): Record<string, Tier> {
  const tiers = new Map<string, Tier>();
  for (const g of groups) tiers.set(g.id, "full");

  const total = () => groups.reduce((sum, g) => sum + g.widths[tiers.get(g.id)!], 0);

  // Bounded by (#groups × #tiers) demotions; the guard is belt-and-braces against a bad minTier.
  for (let step = 0; step < groups.length * TIER_ORDER.length + 1; step++) {
    if (total() <= available) break;

    let victim: GroupMetrics | null = null;
    let victimTier = 0;
    for (const g of groups) {
      const cur = tierIndex(tiers.get(g.id)!);
      if (cur >= tierIndex(g.minTier)) continue; // already as narrow as it may go
      // Ties (same tier, same priority) fall to declaration order, so the solve is deterministic.
      if (!victim || cur < victimTier || (cur === victimTier && g.priority > victim.priority)) {
        victim = g;
        victimTier = cur;
      }
    }
    if (!victim) break; // nothing left to demote

    tiers.set(victim.id, TIER_ORDER[victimTier + 1]);
  }

  return Object.fromEntries(tiers);
}
