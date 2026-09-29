/**
 * Texture-pack loading. Used to share this file with `PaletteGroup` (Home/Draw/Sculpt/3D's active
 * block, superseded by `BlockButton.tsx` + the floating Hotbar window, Stage 14.5); kept here on
 * its own since View and 3D both render it and it isn't part of that migration.
 */
import { useRibbon } from "./context";
import { Badge, Group } from "./primitives";
import { CmdSmall } from "./Cmd";
import { GROUP_CONTENT_H, ROW_GAP } from "./tokens";
import type { Tier } from "./layout";

/** Texture-pack load/unload — shared by View and 3D so the two are a mirror, not a fork. */
export function TextureGroup({ tier, declaredWidth }: { tier?: Tier; declaredWidth?: number }) {
  const { p } = useRibbon();
  return (
    <Group id="textures" label="Textures" tier={tier} declaredWidth={declaredWidth} icon="textures">
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: ROW_GAP, height: GROUP_CONTENT_H }}>
        {/* The green "loaded" badge was dropped (15.2) so Change and Unload both fit at compact
            tiers — "Change…"/"Change Texture Pack…" (bind.ts's labelOverride) already says it's
            loaded without needing a badge alongside it. */}
        <CmdSmall id="view.textures.load" full badge={<Badge style={{ marginLeft: "auto" }} />} />
        {p.texturePackLoaded && <CmdSmall id="view.textures.unload" full />}
      </div>
    </Group>
  );
}
