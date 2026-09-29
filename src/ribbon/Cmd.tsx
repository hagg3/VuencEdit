/**
 * The only way a ribbon tab renders a command (UI redesign r3, 14.6; commands sub-plan §4).
 *
 * Each wrapper takes a registry id and nothing about *behaviour*: label, icon, family hue, tooltip,
 * shortcut, enabled state, armed state and the click handler all come from `COMMAND_META` +
 * `bindCommands`. What a tab still decides is *presentation* — tier, `full`, a shorter placement
 * label, a badge. `eslint.config.js` forbids importing the raw button primitives into
 * `ribbon/tabs/**`, so a hand-rolled button there is a lint error, and `bind.ts`'s `satisfies`
 * makes an unbound id a type error.
 *
 * Every wrapper is a `display: contents` span carrying `data-cmd`: layout is untouched (the button
 * still participates in its parent's grid/flex exactly as before) and ⌘K's reveal finds the
 * control with one `querySelector`.
 */
import { createContext, useContext, type ReactNode } from "react";
import { COMMAND_META, meta, type CommandFamily, type CommandId } from "../commands/meta";
import type { CommandBinding } from "../commands/types";
import { formatChord } from "../commands/keys";
import type { Tier } from "./layout";
import type { IconName } from "./icons";
import {
  CommandButton, DropdownButton, IconButton, MenuItem, SmallButton, SplitButton, usePopupGroupClose,
} from "./primitives";
import { ACCENT } from "./tokens";

const BindingsCtx = createContext<Record<CommandId, CommandBinding> | null>(null);
export const CommandBindingsProvider = BindingsCtx.Provider;

export function useBinding(id: CommandId): CommandBinding {
  const all = useContext(BindingsCtx);
  if (!all) throw new Error("<Cmd> outside <CommandBindingsProvider>");
  return all[id];
}

export const FAMILY_ACCENT: Record<CommandFamily, string | undefined> = {
  primary: ACCENT.primary, warm: ACCENT.warm, selection: ACCENT.selection,
  clipboard: ACCENT.clipboard, violet: ACCENT.violet, danger: undefined,
};

/** Everything a button primitive needs, resolved from the registry. `close` is the enclosing
 *  `popup` group's (`usePopupGroupClose`): running a command from a group popup dismisses it. */
function resolve(id: CommandId, b: CommandBinding, o: Placement, close: (() => void) | null) {
  const m = meta(id);
  const base = o.label ?? b.shortOverride ?? b.labelOverride ?? m.short ?? m.label;
  const label = o.check && b.armed ? `${base} ✓` : base;
  const chord = m.keys?.[0];
  const help = b.titleOverride ?? m.title ?? m.label;
  const title = b.enabled !== true ? b.enabled : chord ? `${help} (${formatChord(chord)})` : help;
  return {
    label, title,
    icon: (o.icon ?? m.icon) as IconName | undefined,
    active: o.active ?? !!b.armed,
    disabled: b.enabled !== true,
    accent: m.family ? FAMILY_ACCENT[m.family] : undefined,
    tone: m.family === "danger" ? ("danger" as const) : undefined,
    onClick: () => { b.run(); if (b.enabled === true) close?.(); },
  };
}

/** Presentation a placement may choose. Behaviour is never a placement's call. */
interface Placement {
  /** A shorter label for this spot ("Pick" for the Eyedropper on Draw). */
  label?: string;
  /** Show " ✓" after the label while armed (the ribbon's toggle idiom). */
  check?: boolean;
  /** Override the armed look (a split button's face is "active" for its whole family). */
  active?: boolean;
  icon?: IconName;
  /** Suppress the visible label (icon-only placement). Tooltip/aria-label, ⌘K and Help keep the
   *  full registry label — this only affects what a `CmdSmall` renders inline. */
  iconOnly?: boolean;
}

function Mark({ id, children }: { id: CommandId; children: ReactNode }) {
  return <span data-cmd={id} style={{ display: "contents" }}>{children}</span>;
}

/**
 * Large at `full` tier, small row at `medium` — `CommandButton` from the registry.
 *
 * ⚠️ **Keycaps are `full`-tier only** (Stage 14.7, plan §5.7 step 3): a small/medium row already
 * shows its shortcut in the tooltip, and `CommandButton` would drop a `keycap` on a `SmallButton`
 * anyway — the `tier === "full"` check here just avoids formatting a chord nobody will render.
 */
export function Cmd({ id, tier = "full", full, badge, ...o }: Placement & { id: CommandId; tier?: Tier; full?: boolean; badge?: ReactNode }) {
  const r = resolve(id, useBinding(id), o, usePopupGroupClose());
  const chord = meta(id).keys?.[0];
  const keycap = tier === "full" && chord ? formatChord(chord) : undefined;
  return <Mark id={id}><CommandButton {...r} icon={r.icon ?? "more"} tier={tier} full={full} badge={badge} keycap={keycap} /></Mark>;
}

export function CmdSmall({ id, full, badge, ...o }: Placement & { id: CommandId; full?: boolean; badge?: ReactNode }) {
  const r = resolve(id, useBinding(id), o, usePopupGroupClose());
  return <Mark id={id}><SmallButton {...r} full={full} badge={badge} iconOnly={o.iconOnly} /></Mark>;
}

export function CmdIcon({ id, ...o }: Placement & { id: CommandId }) {
  const r = resolve(id, useBinding(id), o, usePopupGroupClose());
  return <Mark id={id}><IconButton {...r} icon={r.icon ?? "more"} /></Mark>;
}

/** A split button whose face is `id` and whose menu the tab supplies (usually `CmdMenuItem`s). */
export function CmdSplit({ id, menuTitle, menu, ...o }: Placement & { id: CommandId; menuTitle: string; menu: () => ReactNode }) {
  const r = resolve(id, useBinding(id), o, usePopupGroupClose());
  return <Mark id={id}><SplitButton {...r} icon={r.icon ?? "more"} menuTitle={menuTitle} menu={menu} /></Mark>;
}

/**
 * A dropdown opener. `id` may be a `kind: "menu"` command (the opener *is* the command, e.g. Paste
 * Mode) or a real command whose face it shows (the Shape dropdown at medium tier).
 */
export function CmdDropdown({ id, full, menu, ...o }: Placement & { id: CommandId; full?: boolean; menu: () => ReactNode }) {
  const r = resolve(id, useBinding(id), o, usePopupGroupClose());
  return <Mark id={id}><DropdownButton {...r} full={full} menu={menu} /></Mark>;
}

export function CmdMenuItem({ id, after, ...o }: Placement & { id: CommandId; after?: ReactNode }) {
  const b = useBinding(id);
  const r = resolve(id, b, o, usePopupGroupClose());
  const chord = meta(id).keys?.[0];
  const text = o.label ?? b.shortOverride ?? b.labelOverride ?? meta(id).short ?? meta(id).label;
  return (
    <Mark id={id}>
      <MenuItem label={after ? <>{text} {after}</> : text} icon={r.icon} active={r.active}
        disabled={r.disabled} title={r.title} onClick={r.onClick} danger={r.tone === "danger"}
        shortcut={chord ? formatChord(chord) : undefined} />
    </Mark>
  );
}

/**
 * A non-button control (slider, segmented set, field, picker chip) that ⌘K should be able to
 * reveal and focus. The control keeps its own props; this only marks it.
 */
export function CmdSetting({ id, children }: { id: CommandId; children: ReactNode }) {
  return <Mark id={id}>{children}</Mark>;
}

/** Dev-only: the ids the registry knows, for the runtime "unmarked button" check. */
export const KNOWN_IDS: ReadonlySet<string> = new Set(Object.keys(COMMAND_META));
