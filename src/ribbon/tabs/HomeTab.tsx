/**
 * HOME — what you touch constantly. The mockup is normative for this tab.
 *
 * Clipboard · Navigation · Selection · Palette · Set Point. The old World readout moved to the
 * top bar's world pill and Create moved into the application menu, which is what freed the width
 * for a real command hierarchy here.
 */
import { useMemo } from "react";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import PaletteGroup from "../PaletteGroup";
import {
  Col, CommandButton, DropdownButton, Group, GroupDivider, MenuItem, MenuSeparator, MoreChevron,
  SmallButton,
} from "../primitives";
import { ACCENT, GROUP_CONTENT_H, ROW_GAP } from "../tokens";

/** Declared widths feed the pure solver; the dev-mode `ResizeObserver` in `Group` warns on drift. */
const SPECS: GroupMetrics[] = [
  { id: "clipboard", widths: { full: 240, medium: 150, compact: 44 }, minTier: "compact", priority: 0 },
  { id: "navigation", widths: { full: 200, medium: 128, compact: 44 }, minTier: "compact", priority: 1 },
  { id: "selection", widths: { full: 214, medium: 138, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "palette", widths: { full: 264, medium: 168, compact: 44 }, minTier: "medium", priority: 3 },
  { id: "setpoint", widths: { full: 138, medium: 104, compact: 44 }, minTier: "full", priority: 4 },
];

export default function HomeTab() {
  const { p, bodyWidth, armTransientTool } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);

  const hasSel = !!p.rawBounds;
  const hasClip = !!p.clipboard;

  return (
    <>
      {/* ── Clipboard ─────────────────────────────────────────────────────── */}
      <Group id="clipboard" label="Clipboard" tier={tier.clipboard} declaredWidth={240} icon="paste">
        <CommandButton
          tier={tier.clipboard === "full" ? "full" : "medium"}
          icon="paste" label="Paste" accent={ACCENT.green}
          title={hasClip ? "Paste mode — click the map to place the clipboard" : "Copy or cut something first"}
          onClick={() => p.setTool("paste")}
          active={p.tool === "paste"} disabled={!hasClip}
        />
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: ROW_GAP, alignContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="copy" label="Copy" full disabled={!hasSel}
            title={hasSel ? "Copy the selection (⌘C)" : "Make a selection first"} onClick={p.copySelection} />
          <SmallButton icon="rotate" label="Rotate" full disabled={!hasClip}
            title={hasClip ? "Rotate the clipboard 90° clockwise" : "Copy or cut something first"} onClick={p.rotateClipboard} />
          <SmallButton icon="cut" label="Cut" full disabled={!hasSel}
            title={hasSel ? "Copy the selection, then clear it — one undo step" : "Make a selection first"} onClick={p.cutSelection} />
          <SmallButton icon="flipX" label="Flip X" full disabled={!hasClip}
            title={hasClip ? "Mirror the clipboard across X" : "Copy or cut something first"} onClick={p.mirrorClipboardX} />
          <PasteModeMenu />
          <SmallButton icon="flipY" label="Flip Y" full disabled={!hasClip}
            title={hasClip ? "Mirror the clipboard across Y" : "Copy or cut something first"} onClick={p.mirrorClipboardY} />
        </div>
      </Group>
      <GroupDivider />

      {/* ── Navigation ────────────────────────────────────────────────────── */}
      <Group id="navigation" label="Navigation" tier={tier.navigation} declaredWidth={200} icon="pan">
        <CommandButton tier={tier.navigation === "full" ? "full" : "medium"}
          icon="pan" label="Pan" title="Pan the map (Space, or middle-drag anywhere)"
          onClick={() => p.setTool("pan")} active={p.tool === "pan"} />
        <CommandButton tier={tier.navigation === "full" ? "full" : "medium"}
          icon="select" label="Select" title="Rectangular selection (S)"
          onClick={() => p.setTool("select")} active={p.tool === "select"} />
        <CommandButton tier={tier.navigation === "full" ? "full" : "medium"}
          icon="wand" label="Wand" accent={ACCENT.green} title="Magic Wand — flood-select matching blocks (W)"
          onClick={() => p.setTool("wand")} active={p.tool === "wand"} />
        <MoreChevron title="More selection tools">
          {() => (<>
            <MenuItem icon="lasso" label="Lasso" title="Drag a freeform selection (K)"
              active={p.tool === "lasso"} onClick={() => p.setTool("lasso")} shortcut="K" />
            <MenuItem icon="polyselect" label="Polygon Select" title="Click points, close to select the shape (J)"
              active={p.tool === "polyselect"} onClick={() => p.setTool("polyselect")} shortcut="J" />
            <MenuItem icon="eyedropper" label="Eyedropper" title="Sample a block from the map (I)"
              active={p.tool === "eyedropper"}
              onClick={() => armTransientTool("eyedropper", "pen")} shortcut="I" />
            {p.tool === "wand" && (
              <MenuItem icon="filter" label={p.wandMatchPaint ? "Match: type + colour" : "Match: type only"}
                title="Whether the wand also requires the paint colour to match"
                onClick={() => p.setWandMatchPaint(!p.wandMatchPaint)} />
            )}
          </>)}
        </MoreChevron>
      </Group>
      <GroupDivider />

      {/* ── Selection ─────────────────────────────────────────────────────── */}
      <Group id="selection" label="Selection" tier={tier.selection} declaredWidth={214} icon="select"
        dim={!hasSel} dimNote="(none)">
        <CommandButton tier={tier.selection === "full" ? "full" : "medium"}
          icon="delete" label="Delete" tone="danger" title="Fill the selection with air (⌫)"
          onClick={p.deleteBlocks} />
        <CommandButton tier={tier.selection === "full" ? "full" : "medium"}
          icon="fill" label="Fill" accent={ACCENT.primary} title="Fill the selection with the active block"
          onClick={p.fillSelection} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="grow" label="Grow" full title="Grow the selection by one block on every side"
            onClick={() => p.setRawBounds(b => b ? { x1: b.x1 - 1, y1: b.y1 - 1, x2: b.x2 + 1, y2: b.y2 + 1 } : null)} />
          <SmallButton icon="shrink" label="Shrink" full title="Shrink the selection by one block on every side"
            onClick={() => p.setRawBounds(b => b ? { x1: Math.min(b.x1 + 1, b.x2), y1: Math.min(b.y1 + 1, b.y2), x2: Math.max(b.x2 - 1, b.x1), y2: Math.max(b.y2 - 1, b.y1) } : null)} />
          <SmallButton icon="clear" label="Clear" full tone="danger" title="Deselect (Esc)"
            onClick={() => p.setRawBounds(null)} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Palette ───────────────────────────────────────────────────────── */}
      <PaletteGroup variant={tier.palette === "full" ? "full" : "compact"} pickerKind="block-draw"
        tier={tier.palette} declaredWidth={264} />
      <GroupDivider />

      {/* ── Set Point ─────────────────────────────────────────────────────── */}
      <Group id="setpoint" label="Set Point" tier={tier.setpoint} declaredWidth={138} icon="home"
        dim={!p.selection} dimNote="(no selection)">
        <CommandButton tier="full" icon="home" label="Home"
          title={`Move the respawn point (header "home"${p.spawnPos ? `, now ${Math.round(p.spawnPos.px)}, ${Math.round(p.spawnPos.py)}` : ", unset"}) to the centre of the selection`}
          onClick={p.onSetSpawnAtSelection} />
        <CommandButton tier="full" icon="start" label="Start"
          title={`Move the last-walked player position (header "pos"${p.playerPos ? `, now ${Math.round(p.playerPos.px)}, ${Math.round(p.playerPos.py)}` : ", unset"}) to the centre of the selection`}
          onClick={p.onSetPlayerPosAtSelection} />
      </Group>
    </>
  );
}

/** The mockup's "Mode ⌄" — paste behaviour, one click away without leaving Home. */
function PasteModeMenu() {
  const { p } = useRibbon();
  const hasClip = !!p.clipboard;
  return (
    <DropdownButton
      icon="pasteMode" label="Mode" full disabled={!hasClip}
      title={hasClip ? "Paste mode & options" : "Copy or cut something first"}
      menu={() => (<>
        <MenuItem label="Single (1×)" icon="paste" active={p.pasteMode === "normal"} onClick={() => p.setPasteMode("normal")}
          title="One copy per click" />
        <MenuItem label="Scatter" icon="sparkle" active={p.pasteMode === "scatter"} onClick={() => p.setPasteMode("scatter")}
          disabled={!p.rawBounds} title={p.rawBounds ? "Distribute N copies inside the selection" : "Scatter needs a selection to place copies into"} />
        <MenuItem label="Array" icon="quad" active={p.pasteMode === "array"} onClick={() => p.setPasteMode("array")}
          title="Grid of copies with fixed spacing" />
        <MenuSeparator />
        <MenuItem label="Skip air blocks" icon="clear" active={p.pasteIgnoreAir} onClick={() => p.setPasteIgnoreAir(!p.pasteIgnoreAir)}
          title="Leave existing blocks where the clipboard holds air" />
        <MenuItem label="Repeat on each click" icon="pasteMode" active={p.persistPaste} onClick={() => p.setPersistPaste(!p.persistPaste)}
          title="Stay in paste mode after placing" />
        <MenuItem label="Follow terrain" icon="topdown" active={p.pasteTerrain} onClick={() => p.setPasteTerrain(!p.pasteTerrain)}
          title="Place per column at the local surface height instead of a fixed Z" />
      </>)}
    />
  );
}
