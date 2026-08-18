/**
 * CLIPBOARD — contextual on `clipboard`. Owns the pasted object and its two-click placement
 * lifecycle. Rotate/Flip are the same callbacks Home exposes, not a forked path.
 *
 * The preview tile is 78px square rather than the old 140: the ribbon body is a fixed height now,
 * and a 140px canvas would push the group's label off the bottom.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { decodePreviewData } from "../../types";
import { solveLayout, type GroupMetrics } from "../layout";
import { useRibbon } from "../context";
import {
  Caption, Col, CommandButton, FieldLabel, Group, GroupDivider, NumField, Row, Segmented, SmallButton,
} from "../primitives";
import {
  ACCENT, BORDER, FONT, GROUP_CONTENT_H, RADIUS, SMALL_H, SURFACE, TEXT, TEXT_ARMED, TEXT_DIM,
  lighten,
} from "../tokens";

const PREV = 78;
/** The preview tile's letterbox. Matches the top bar, so the canvas reads as recessed chrome. */
const PREV_BG = SURFACE.topbar;

const SPECS: GroupMetrics[] = [
  { id: "preview", widths: { full: 200, medium: 128, compact: 44 }, minTier: "medium", priority: 4 },
  { id: "place", widths: { full: 246, medium: 168, compact: 44 }, minTier: "medium", priority: 0 },
  { id: "transform", widths: { full: 200, medium: 140, compact: 44 }, minTier: "compact", priority: 1 },
  { id: "options", widths: { full: 176, medium: 130, compact: 44 }, minTier: "compact", priority: 2 },
  { id: "mode", widths: { full: 230, medium: 150, compact: 44 }, minTier: "compact", priority: 3 },
  { id: "prefab", widths: { full: 132, medium: 110, compact: 44 }, minTier: "compact", priority: 5 },
];

export default function ClipboardTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveLayout(SPECS, bodyWidth), [bodyWidth]);
  const cb = p.clipboard;
  const needsSelection = p.pasteMode === "scatter" && !p.rawBounds;

  const [pixels, setPixels] = useState<{ width: number; height: number; pixels: Uint8Array } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!p.clipboard) { setPixels(null); return; }
    invoke<ArrayBuffer>("render_clipboard_preview")
      .then(buf => setPixels(decodePreviewData(buf)))
      .catch(() => setPixels(null));
  }, [p.clipboard]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = PREV_BG;
    ctx.fillRect(0, 0, PREV, PREV);
    if (pixels && pixels.width > 0 && pixels.height > 0) {
      const off = document.createElement("canvas");
      off.width = pixels.width;
      off.height = pixels.height;
      const offCtx = off.getContext("2d")!;
      const img = offCtx.createImageData(pixels.width, pixels.height);
      img.data.set(pixels.pixels);
      offCtx.putImageData(img, 0, 0);
      const scale = Math.min(PREV / pixels.width, PREV / pixels.height);
      const dw = Math.round(pixels.width * scale);
      const dh = Math.round(pixels.height * scale);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, Math.round((PREV - dw) / 2), Math.round((PREV - dh) / 2), dw, dh);
    }
  }, [pixels]);

  return (
    <>
      {/* ── Preview ───────────────────────────────────────────────────────── */}
      <Group id="preview" label="Preview" tier={tier.preview} declaredWidth={200} icon="paste">
        <canvas ref={canvasRef} width={PREV} height={PREV} aria-label="Clipboard top-down preview"
          style={{ display: "block", width: PREV, height: PREV, borderRadius: RADIUS.md, background: PREV_BG, imageRendering: "pixelated", boxShadow: `inset 0 0 0 1px ${BORDER.outline}` }} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          {cb && (<>
            <div style={{ color: lighten(ACCENT.green), fontSize: FONT.body, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {cb.width}×{cb.height}×{cb.depth}
            </div>
            <FieldLabel>z {cb.z_anchor}–{cb.z_anchor + cb.depth - 1}</FieldLabel>
            <FieldLabel>{(cb.width * cb.height * cb.depth).toLocaleString()} cells</FieldLabel>
          </>)}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Place ─────────────────────────────────────────────────────────── */}
      <Group id="place" label="Place" tier={tier.place} declaredWidth={246} icon="paste">
        <CommandButton tier={tier.place === "full" ? "full" : "medium"} icon="paste" label="Paste" accent={ACCENT.green}
          active={p.tool === "paste"} title="Paste mode — click the map to place the clipboard"
          onClick={() => p.setTool("paste")} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="paste" label="Confirm" full accent={ACCENT.green} disabled={!p.lockedPastePos}
            title={p.lockedPastePos ? "Place the clipboard at the locked position" : "Click the map once to lock a position first"}
            onClick={() => { const pos = p.lockedPastePos; if (pos) { p.pasteAt(pos); p.setLockedPastePos(null); } }} />
          <SmallButton icon="clear" label="Unlock" full disabled={!p.lockedPastePos}
            title="Release the locked position and pick again" onClick={() => p.setLockedPastePos(null)} />
          <Row style={{ height: SMALL_H }}>
            <FieldLabel width={44}>Z offset</FieldLabel>
            <NumField value={p.pasteElevationOffset} onChange={p.setPasteElevationOffset}
              ariaLabel="Paste elevation offset" width={46} />
            <FieldLabel>PgUp/PgDn</FieldLabel>
          </Row>
        </Col>
        <Col style={{ justifyContent: "flex-end", height: GROUP_CONTENT_H }}>
          <Caption tone={p.lockedPastePos ? TEXT_ARMED : TEXT_DIM}>
            {p.lockedPastePos ? `Locked X${p.lockedPastePos.x}, Y${p.lockedPastePos.y}` : "Click map to place"}
          </Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Transform — same callbacks Home exposes ───────────────────────── */}
      <Group id="transform" label="Transform" tier={tier.transform} declaredWidth={200} icon="rotate">
        <CommandButton tier={tier.transform === "full" ? "full" : "medium"} icon="rotate" label="Rotate" accent={ACCENT.green}
          title="Rotate the clipboard 90° clockwise (ramps and wedges re-orient with it)" onClick={p.rotateClipboard} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="flipX" label="Flip X" full accent={ACCENT.green} title="Mirror across X" onClick={p.mirrorClipboardX} />
          <SmallButton icon="flipY" label="Flip Y" full accent={ACCENT.green} title="Mirror across Y" onClick={p.mirrorClipboardY} />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Options ───────────────────────────────────────────────────────── */}
      <Group id="options" label="Options" tier={tier.options} declaredWidth={176} icon="settings">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            <SmallButton label="No Air" accent={ACCENT.green} active={p.pasteIgnoreAir}
              title="Leave existing blocks where the clipboard holds air" onClick={() => p.setPasteIgnoreAir(!p.pasteIgnoreAir)} />
            <SmallButton label="Repeat" accent={ACCENT.green} active={p.persistPaste}
              title="Stay in paste mode after placing" onClick={() => p.setPersistPaste(!p.persistPaste)} />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <SmallButton label="Terrain" accent={ACCENT.green} active={p.pasteTerrain}
              title="Place per column at the local surface height instead of a fixed Z" onClick={() => p.setPasteTerrain(!p.pasteTerrain)} />
            {p.pasteTerrain && (
              <SmallButton label={p.pasteTerrainAbove ? "Above" : "At surf"} accent={ACCENT.green} active={p.pasteTerrainAbove}
                title={p.pasteTerrainAbove ? "Sit one block above each column's surface" : "Replace each column's surface block"}
                onClick={() => p.setPasteTerrainAbove(!p.pasteTerrainAbove)} />
            )}
          </Row>
          <Caption>{p.pasteTerrain ? "Following terrain height" : "Fixed Z anchor"}</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Mode ──────────────────────────────────────────────────────────── */}
      <Group id="mode" tier={tier.mode} declaredWidth={230} icon="pasteMode"
        label={<>Mode{needsSelection ? <span style={{ color: TEXT_DIM, marginLeft: 4 }}>(needs a selection)</span> : null}</>}>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Segmented ariaLabel="Paste mode" accent={ACCENT.green} value={p.pasteMode} onChange={p.setPasteMode}
            options={[
              { id: "normal", label: "1×", title: "One copy per click" },
              { id: "scatter", label: "Scatter", title: "Distribute N copies inside the selection" },
              { id: "array", label: "Array", title: "Grid of copies with fixed spacing" },
            ]} />
          {p.pasteMode === "scatter" && (
            <Row style={{ height: SMALL_H }}>
              <FieldLabel>Count</FieldLabel>
              <NumField min={1} max={100} value={p.scatterCount} onChange={p.setScatterCount}
                ariaLabel="Scatter count" width={46} />
            </Row>
          )}
          {p.pasteMode === "array" && (<>
            <Row style={{ height: SMALL_H }}>
              <FieldLabel width={30}>Cols</FieldLabel>
              <NumField min={1} max={20} value={p.arrayCols} onChange={p.setArrayCols} ariaLabel="Array columns" width={38} />
              <FieldLabel width={30}>Rows</FieldLabel>
              <NumField min={1} max={20} value={p.arrayRows} onChange={p.setArrayRows} ariaLabel="Array rows" width={38} />
            </Row>
            <Row style={{ height: SMALL_H }}>
              <FieldLabel width={30}>Sp X</FieldLabel>
              <NumField min={0} value={p.arraySpacingX} onChange={p.setArraySpacingX} ariaLabel="Array X spacing" width={38} />
              <FieldLabel width={30}>Sp Y</FieldLabel>
              <NumField min={0} value={p.arraySpacingY} onChange={p.setArraySpacingY} ariaLabel="Array Y spacing" width={38} />
            </Row>
          </>)}
          {p.pasteMode === "normal" && <Caption>One copy per click</Caption>}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Prefab ────────────────────────────────────────────────────────── */}
      <Group id="prefab" label="Prefab" tier={tier.prefab} declaredWidth={132} icon="savePrefab">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <SmallButton icon="savePrefab" label="Save Prefab…" full accent={ACCENT.green}
            title="Save the clipboard as a .epfab in your prefab folder" onClick={p.onSavePrefab} />
          <SmallButton icon="save" label="Save As…" full accent={ACCENT.green}
            title="Save the clipboard to any folder (native dialog)" onClick={p.onSavePrefabAs} />
          <Caption tone={TEXT}>Shaped masks are kept</Caption>
        </Col>
      </Group>
    </>
  );
}
