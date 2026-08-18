/**
 * The ONE palette presentation. Home, Draw, Sculpt and 3D-Build all render this component, so the
 * active block can't drift into four slightly-different looks for one piece of state.
 *
 * No new state is involved: `fillBlockType`/`fillPaint` were unified in an earlier pass and are
 * already the single source of truth for the 2D fill block *and* the 3D armed block.
 */
import type { ReactNode } from "react";
import { blockDisplayName, resolveColor } from "../blockDefs";
import { tintedSwatch } from "../texturePack";
import { useRibbon, type PickerKind } from "./context";
import { Badge, Group, LargeButton, Row, SmallButton, Swatch } from "./primitives";
import {
  ACCENT, BTN_RADIUS, FONT, GROUP_CONTENT_H, ICON, PALETTE_COMPACT_H, RADIUS, RAIL_W, ROW_GAP,
  SPACE, TEXT_LABEL, btnActive, btnBase,
} from "./tokens";
import { Icon } from "./icons";
import type { Tier } from "./layout";

export interface PaletteGroupProps {
  variant: "full" | "compact";
  pickerKind: PickerKind;
  label?: string;
  /** 3D's Auto-orient toggle — shares the palette's third row rather than adding a fourth. */
  extraRow?: ReactNode;
  dim?: boolean;
  dimNote?: ReactNode;
  tier?: Tier;
  declaredWidth?: number;
}

/** Hotbar cell. Sized so `SLOT + 2×ring` still clears a 26px row with the selected ring drawn. */
const SLOT = 22;

export default function PaletteGroup({
  variant, pickerKind, label = "Palette", extraRow, dim, dimNote, tier, declaredWidth,
}: PaletteGroupProps) {
  const { p, pickerKind: openKind, togglePicker } = useRibbon();
  const open = openKind === pickerKind;
  const swatchUrl = p.texturePack ? tintedSwatch(p.fillBlockType, p.fillPaint, p.texturePack) : null;
  const [r, g, b] = resolveColor(p.fillBlockType, p.fillPaint);
  const name = `${blockDisplayName(p.fillBlockType)}${p.fillPaint > 0 ? ` #${p.fillPaint}` : ""}`;

  const swatchNode = (size: number) => (
    <Swatch color={`rgb(${r},${g},${b})`} url={swatchUrl} size={size} style={{ borderRadius: RADIUS.md }} />
  );

  if (variant === "compact") {
    return (
      <Group id="palette" label={label} tier={tier} declaredWidth={declaredWidth} dim={dim} dimNote={dimNote} icon="block">
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: GROUP_CONTENT_H, gap: ROW_GAP }}>
          <button
            className="rbn-btn" type="button" onClick={e => togglePicker(e, pickerKind)}
            title={`Active block: ${name} — click to browse all blocks & paints`}
            aria-label="Active block" data-active={open ? "true" : undefined}
            style={btnBase({
              height: PALETTE_COMPACT_H, display: "flex", alignItems: "center", gap: SPACE.md, padding: "0 7px",
              ...(open ? btnActive() : null),
            })}
          >
            {swatchNode(20)}
            <span style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
            <Icon name="split" size={ICON.xs} tone="inherit" />
          </button>
        </div>
      </Group>
    );
  }

  return (
    <Group id="palette" label={label} tier={tier} declaredWidth={declaredWidth} dim={dim} dimNote={dimNote} icon="block">
      {/* Active block — the big face, with a ⌄ rail opening the full picker (mockup's "Block"). */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 1 }}>
        <LargeButton
          icon="block" label="Block"
          iconNode={swatchNode(32)}
          title={`Active block: ${name} — click to browse all blocks & paints`}
          onClick={e => togglePicker(e, pickerKind)} active={open}
          style={{ borderRadius: `${BTN_RADIUS}px 0 0 ${BTN_RADIUS}px`, minWidth: 56 }}
        />
        <button
          className="rbn-btn" type="button" onClick={e => togglePicker(e, pickerKind)}
          title="Browse all blocks & paints" aria-label="Browse all blocks and paints"
          aria-haspopup="dialog" aria-expanded={open} data-active={open ? "true" : undefined}
          style={btnBase({
            height: GROUP_CONTENT_H, width: RAIL_W, padding: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: `0 ${BTN_RADIUS}px ${BTN_RADIUS}px 0`,
            ...(open ? btnActive() : null),
          })}
        >
          <Icon name="split" size={ICON.xs} tone="inherit" />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: ROW_GAP, height: GROUP_CONTENT_H }}>
        <HotbarRow kind="pinned" />
        <HotbarRow kind="recent" />
        {extraRow}
      </div>
    </Group>
  );
}

/** Pinned (keys 1–5) and Recent (keys 6–0) swatch rows — the mockup's two-row gallery. */
function HotbarRow({ kind }: { kind: "pinned" | "recent" }) {
  const { p } = useRibbon();
  const isActive = (b: { type: number; paint: number }) => b.type === p.fillBlockType && b.paint === p.fillPaint;

  function pinToSlot(b: { type: number; paint: number }) {
    p.setPinnedBlocks(prev => {
      const n = [...prev];
      const i = n.findIndex(s => s === null);
      if (i !== -1) { n[i] = b; return n; }
      n[4] = b;
      return n;
    });
  }

  const items: (({ type: number; paint: number } | null))[] =
    kind === "pinned" ? p.pinnedBlocks : [...p.recentBlocks, null, null, null, null, null].slice(0, 5);

  return (
    // gap SPACE.sm, not COL_GAP: the selected cell's ring is drawn *outside* the swatch, so a 2px
    // gap would let a selected cell's ring touch its neighbour.
    <Row gap={SPACE.sm}>
      <span style={{ color: TEXT_LABEL, fontSize: FONT.micro, width: 38, userSelect: "none" }}>
        {kind === "pinned" ? "Pinned" : "Recent"}
      </span>
      {items.map((b, i) => {
        const key = `${kind}-${i}`;
        const hovered = p.hotbarHover === key;
        const active = b ? isActive(b) : false;
        const [r, g, bl] = b ? resolveColor(b.type, b.paint) : [0, 0, 0];
        const url = b && p.texturePack ? tintedSwatch(b.type, b.paint, p.texturePack) : null;
        const alreadyPinned = kind === "recent" && b != null &&
          p.pinnedBlocks.some(pb => pb && pb.type === b.type && pb.paint === b.paint);
        const digit = kind === "pinned" ? String(i + 1) : i === 4 ? "0" : String(i + 6);
        return (
          <div
            key={key}
            role="button" tabIndex={b ? 0 : -1}
            aria-label={b ? `${blockDisplayName(b.type)}${b.paint > 0 ? ` paint ${b.paint}` : ""}` : `Empty ${kind} slot ${i + 1}`}
            title={b
              ? `${blockDisplayName(b.type)}${b.paint > 0 ? ` p${b.paint}` : ""} · key ${digit}`
              : `Empty ${kind} slot ${i + 1}`}
            onClick={() => b && (p.setFillBlockType(b.type), p.setFillPaint(b.paint))}
            onKeyDown={e => { if (b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); p.setFillBlockType(b.type); p.setFillPaint(b.paint); } }}
            onMouseEnter={() => p.setHotbarHover(key)}
            onMouseLeave={() => p.setHotbarHover(null)}
            style={{
              width: SLOT, height: SLOT, position: "relative", flexShrink: 0,
              cursor: b ? "pointer" : "default", opacity: alreadyPinned ? 0.5 : 1,
            }}
          >
            <Swatch color={`rgb(${r},${g},${bl})`} url={url} size={SLOT} selected={active} empty={!b} />
            {/* Corner-set key hint. Was `fontSize: 6` — the smallest type anywhere in the app. */}
            <span style={{
              position: "absolute", top: 1, left: 2, fontSize: FONT.micro - 2, lineHeight: 1,
              color: "rgba(255,255,255,0.45)", textShadow: "0 1px 1px rgba(0,0,0,.6)",
              pointerEvents: "none", userSelect: "none",
            }}>{digit}</span>
            {hovered && b && (
              <div
                onClick={e => {
                  e.stopPropagation();
                  if (kind === "pinned") p.setPinnedBlocks(prev => { const n = [...prev]; n[i] = null; return n; });
                  else if (!alreadyPinned) pinToSlot(b);
                  p.setHotbarHover(null);
                }}
                title={kind === "pinned" ? "Unpin" : alreadyPinned ? "Already pinned" : "Pin"}
                style={{
                  position: "absolute", top: 0, right: 0, width: 10, height: 10,
                  borderRadius: `0 ${RADIUS.sm}px 0 ${RADIUS.sm}px`, background: "rgba(0,0,0,0.75)",
                  color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: FONT.micro - 1, cursor: "pointer",
                }}
              >
                {kind === "pinned" ? "×" : "↑"}
              </div>
            )}
          </div>
        );
      })}
    </Row>
  );
}

/** Texture-pack load/unload — shared by View and 3D so the two are a mirror, not a fork. */
export function TextureGroup({ tier, declaredWidth }: { tier?: Tier; declaredWidth?: number }) {
  const { p } = useRibbon();
  return (
    <Group id="textures" label="Textures" tier={tier} declaredWidth={declaredWidth} icon="textures">
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: ROW_GAP, height: GROUP_CONTENT_H }}>
        <SmallButton
          icon="textures" full accent={ACCENT.primary}
          label={p.texturePackLoaded ? "Change Pack…" : "Load Pack…"}
          title="Block textures for the 3D views and picker swatches (experimental). Accepts a ZIP of named PNGs or a bare atlas image."
          onClick={p.openTexturePackFile}
          badge={p.texturePackLoaded
            ? <Badge tone="ok" style={{ marginLeft: "auto" }}>✓ loaded</Badge>
            : <Badge style={{ marginLeft: "auto" }} />}
        />
        {p.texturePackLoaded && (
          <SmallButton icon="close" full label="Unload Pack" title="Go back to flat block colours" onClick={p.unloadTexturePack} />
        )}
      </div>
    </Group>
  );
}
