/**
 * Dev-only console helper (Stage 14.7, plan §5.7 step 4). Re-measuring every tab's group widths by
 * hand under the new type/density scale would be "8 tabs × 3 tiers × 4 window widths" of manual
 * work; `window.__harvestRibbonWidths()` turns it into one console call per window width.
 *
 * **How it works.** Only the active tab is mounted at all (`Ribbon.tsx`'s
 * `{activeTab === "home" && <HomeTab/>}` chain), and a group only renders at whichever tier
 * `solveLayout` picked for the *current* window width — so a single call can only observe the tier
 * each group happens to be at right now. This walks every tab button currently in the strip,
 * clicks it, waits two animation frames for React to commit and the browser to lay out, then reads
 * each rendered `[data-group]` element's width and the tier `Group` rendered it at (`data-tier`,
 * added in the same stage). Readings accumulate into `window.__ribbonWidthHarvest` across calls —
 * keyed by tab then group, since several groups share an id across tabs (`block`, `tools`,
 * `options`, `prefab`, `textures`) with genuinely different content and width — so running this
 * once per the plan's four window widths (1920 / 1440 / 1200 / 900) naturally sweeps every group
 * through full → medium → popup as the solver demotes it, and each call's printed table shows
 * whatever has been observed so far, filling in as you go.
 *
 * ⚠️ Only tab buttons **rendered right now** get clicked: the three contextual tabs (3D, Selection,
 * Clipboard) only exist while their state is live. Arm a selection, put something on the clipboard, and open the 3D pane/window
 * before running this, so all 8 tabs are in the strip to measure.
 *
 * Restores whichever tab was active before the call. The `import.meta.env.DEV` guard makes the
 * whole body dead code in a production build (Vite statically replaces the check and removes the
 * branch), so importing this module unconditionally is harmless — `Ribbon.tsx` does exactly that.
 */
import { TIER_ORDER, type Tier } from "./layout";

type TierName = Tier;
const TIERS: readonly TierName[] = TIER_ORDER;

type Reading = Partial<Record<TierName, number>>;
type TabReadings = Record<string, Reading>;

declare global {
  interface Window {
    /** Call from the devtools console — see the module doc comment for the workflow. */
    __harvestRibbonWidths?: () => void;
    /** Accumulated readings, `store[tab][group] = { full?, medium?, popup? }`. Persists across
     *  calls in the same page session so multiple window widths build up one table. */
    __ribbonWidthHarvest?: Record<string, TabReadings>;
  }
}

function measureActiveTab(tab: string, store: Record<string, TabReadings>): void {
  const panel = document.getElementById("ribbon-tabpanel");
  if (!panel) return;
  const tabStore = (store[tab] ??= {});
  panel.querySelectorAll<HTMLElement>("[data-group]").forEach(el => {
    const id = el.getAttribute("data-group");
    const tier = el.getAttribute("data-tier") as TierName | null;
    if (!id || !tier) return;
    const w = Math.round(el.getBoundingClientRect().width);
    if (w === 0) return; // not laid out (e.g. a hidden ancestor) — skip rather than record a lie
    (tabStore[id] ??= {})[tier] = w;
  });
}

function settle(): Promise<void> {
  // Two rAFs: one to let React (batched by the click's event handler) commit the tab switch, one
  // to let the browser paint it before we measure — matches the idiom `Group`'s own ResizeObserver
  // drift guard relies on implicitly (a real layout pass, not a microtask).
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function run(): Promise<void> {
  const strip = document.querySelector<HTMLElement>('[role="tablist"]');
  if (!strip) {
    console.warn("[ribbon widths] no tab strip mounted — open a world first");
    return;
  }
  const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const activeBtn = buttons.find(b => b.getAttribute("aria-selected") === "true");

  const store = (window.__ribbonWidthHarvest ??= {});
  for (const btn of buttons) {
    btn.click();
    await settle();
    const tab = btn.dataset.tab;
    if (tab) measureActiveTab(tab, store);
  }
  activeBtn?.click();
  await settle();

  const lines: string[] = [];
  for (const tab of Object.keys(store).sort()) {
    lines.push(`${tab}:`);
    for (const id of Object.keys(store[tab]).sort()) {
      const r = store[tab][id];
      const parts = TIERS.map(t => `${t}: ${r[t] ?? "?"}`).join(", ");
      lines.push(`  ${id.padEnd(12)} { ${parts} }`);
    }
  }
  console.log(
    `[ribbon widths] @ ${window.innerWidth}px — accumulated across every __harvestRibbonWidths() ` +
    `call this session:\n${lines.join("\n")}\n\n` +
    `A "?" means that tier hasn't been observed at any width tried yet (the row was never demoted ` +
    `that far). Run again at 1920 / 1440 / 1200 / 900 — with a selection, a clipboard and the 3D ` +
    `pane open, so the contextual tabs are in the strip too — until every group shows all three. ` +
    `Paste each group's "full" number into ribbon/specs.ts's TAB_SPECS (the g(...) call's width ` +
    `argument) — declaredWidth reads specWidth() from there automatically now, so that's the only ` +
    `edit. "medium" only ever lives in SPECS too, and "popup" is the fixed POPUP_GROUP_W by construction.`
  );
}

if (import.meta.env.DEV) {
  window.__harvestRibbonWidths = () => { void run(); };
}
