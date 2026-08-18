/**
 * One context carrying the whole `RibbonProps` bag plus the shell services a tab needs
 * (the shared block-picker portal, the measured body width, tab switching).
 *
 * Threading ~190 props through eight tab components by hand would be hundreds of lines of churn
 * for no benefit: only one tab is mounted at a time, so the context's changing identity costs
 * nothing over today's whole-component re-render.
 */
import { createContext, useContext } from "react";
import type { Tool } from "../MapCanvas";
import type { RibbonProps, RibbonTab } from "./props";

/** Which block/paint picker the shared portal is currently showing. */
export type PickerKind = "block-draw" | "block-fill" | "filter" | "gradient-to" | "build-3d";

export interface RibbonShell {
  p: RibbonProps;
  activeTab: RibbonTab;
  setActiveTab: (t: RibbonTab) => void;
  /** Width available to the group row, measured on the body element (drives `solveLayout`). */
  bodyWidth: number;
  /** Currently-open picker, or null. */
  pickerKind: PickerKind | null;
  /** Toggle the shared, shell-hosted `BlockPaintPicker` portal anchored on the clicked element. */
  togglePicker: (e: React.MouseEvent, kind: PickerKind) => void;
  /** Open the application menu, optionally jumping straight to one of its rows' panes. */
  openAppMenu: (row?: string) => void;
  /**
   * Arm a tool that returns to the previous one when it's done (Eyedropper, Pool Fill), recording
   * the current tool in `prevToolRef`. Lives on the shell rather than in each tab because
   * `react-hooks/immutability` forbids mutating a ref reached through a hook's return value —
   * only the component that received it as a prop may write it.
   */
  armTransientTool: (next: Tool, escapeTo: Tool) => void;
  /** True while the body is showing as a temporary floating overlay over a collapsed ribbon
   *  (MS Office "peek" behaviour) — clicking a tab while collapsed, not the collapse toggle. */
  peeking: boolean;
  /** Clicked a tab while collapsed: show the body as a floating overlay without un-collapsing. */
  requestPeek: () => void;
}

const Ctx = createContext<RibbonShell | null>(null);

export const RibbonProvider = Ctx.Provider;

export function useRibbon(): RibbonShell {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRibbon() outside <RibbonProvider>");
  return v;
}

/** Sugar for the overwhelmingly common `const p = useRibbon().p`. */
export function useRibbonProps(): RibbonProps {
  return useRibbon().p;
}
