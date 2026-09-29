/** The registry's dynamic half — what `bindCommands` produces per command, every render. */
export interface CommandBinding {
  /** Run it. For `kind: "setting"` / `"menu"` this is never called — ⌘K reveals those instead. */
  run: () => void;
  /** `true`, or the reason it can't run (shown dimmed in ⌘K and as the ribbon tooltip). */
  enabled: true | string;
  /** Tools/toggles: currently on. */
  armed?: boolean;
  /** A state-dependent label ("Map" instead of "3D view" while swapped). */
  labelOverride?: string;
  /** Ribbon-only text for the current state (the ribbon's `short`, when it depends on state). ⌘K and
   *  Help ignore it and keep `labelOverride ?? label`, so a terse "Change…" never loses its noun there. */
  shortOverride?: string;
  /** A state-dependent tooltip (Set Point's current coordinates). */
  titleOverride?: string;
}
