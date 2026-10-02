/**
 * The **Block** button (UI redesign r3, Stage 14.5) — replaces `PaletteGroup` on Home, Draw, Sculpt
 * and 3D. The pinned/recent swatch rows moved to the floating Hotbar window
 * (`src/windows/HotbarWindow.tsx`); this is now just the one control every tab needs: what's
 * currently armed, and a way to open the full picker. Fixed-width by construction — no `full`
 * variant to solve between, unlike the old `PaletteGroup`.
 */
import type { ReactNode } from "react";
import { blockDisplayName, resolveColor } from "../blockDefs";
import { tintedSwatch } from "../texturePack";
import { useRibbon } from "./context";
import { useBinding } from "./Cmd";
import type { CommandId } from "../commands/meta";
import { Group, Swatch } from "./primitives";
import { BLOCK_NARROW_W, GROUP_CONTENT_H, ICON, RADIUS, SMALL_H, SPACE, TEXT_LABEL, btnActive, btnBase } from "./tokens";
import { Icon } from "./icons";
import type { Tier } from "./layout";

/** Fixed width of the button itself (swatch + ellipsised name + caret) — provisional, per the
 *  plan's "declaredWidth is a hand-set placeholder until 14.7 re-measures every tab". */
export const BLOCK_BUTTON_W = 120;
/** Max width of the name text before it ellipsises. */
const NAME_MAX_W = 58;

export interface BlockButtonProps {
  /** The registry's picker command this button fronts (`home.block.pick`, `3d.block.pick`, …) —
   *  it owns which picker kind opens and how it's anchored. */
  cmd: CommandId;
  label?: string;
  dim?: boolean;
  dimNote?: ReactNode;
  tier?: Tier;
  declaredWidth?: number;
}

export default function BlockButton({
  cmd, label = "Block", dim, dimNote, tier, declaredWidth,
}: BlockButtonProps) {
  const { p } = useRibbon();
  const binding = useBinding(cmd);
  const open = !!binding.armed;
  const swatchUrl = p.texturePack ? tintedSwatch(p.fillBlockType, p.fillPaint, p.texturePack) : null;
  const [r, g, b] = resolveColor(p.fillBlockType, p.fillPaint);
  const name = `${blockDisplayName(p.fillBlockType)}${p.fillPaint > 0 ? ` #${p.fillPaint}` : ""}`;
  // `popup` tier (15.4): MS guidance says a single-button group never collapses into a popup
  // icon — it narrows. Swatch over caret, still one click to the picker.
  const narrow = tier === "popup";

  return (
    <Group id="block" label={label} tier={tier} declaredWidth={declaredWidth} dim={dim} dimNote={dimNote} icon="block" selfCollapsing>
      <div data-cmd={cmd} style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: GROUP_CONTENT_H, gap: 0 }}>
        <button
          className="rbn-btn" type="button" onClick={binding.run}
          title={`Active block: ${name}. Click to choose a block and paint.`}
          aria-label="Active block" data-active={open ? "true" : undefined}
          style={btnBase(narrow ? {
            height: GROUP_CONTENT_H - 2 * SPACE.md, width: BLOCK_NARROW_W,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: SPACE.sm,
            padding: 0, ...(open ? btnActive() : null),
          } : {
            // The one-row compact control's height — `PALETTE_COMPACT_H` (Stage 14.7 deleted it as
            // unused elsewhere) was the same `SMALL_H + 8` expression, just given a name.
            height: SMALL_H + 8, width: BLOCK_BUTTON_W,
            display: "flex", alignItems: "center", gap: SPACE.sm, padding: "0 7px",
            ...(open ? btnActive() : null),
          })}
        >
          <Swatch color={`rgb(${r},${g},${b})`} url={swatchUrl} size={narrow ? 24 : 20} style={{ borderRadius: RADIUS.md }} />
          {!narrow && (<>
            <span style={{ maxWidth: NAME_MAX_W, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: TEXT_LABEL }}>
              {name}
            </span>
            <span style={{ flex: 1 }} />
          </>)}
          <Icon name="split" size={ICON.xs} tone="inherit" />
        </button>
      </div>
    </Group>
  );
}
