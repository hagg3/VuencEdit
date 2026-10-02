/**
 * CLIPBOARD — contextual on `clipboard`. Owns the pasted object and its two-click placement
 * lifecycle. Rotate/Flip are the same callbacks Home exposes, not a forked path.
 *
 * The preview tile is 78px square rather than the old 140: the ribbon body is a fixed height now,
 * and a 140px canvas would push the group's label off the bottom.
 */
import { useEffect, useMemo, useRef } from "react";
import { previewCanvas } from "../../previewCanvas";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import { Cmd, CmdSetting, CmdSmall } from "../Cmd";
import {
  Caption, Col, FieldLabel, Group, GroupDivider, NumField, Row, Segmented,
} from "../primitives";
import {
  ACCENT, BORDER, FONT, GROUP_CONTENT_H, RADIUS, SMALL_H, SURFACE, TEXT, TEXT_DIM,
  lighten,
} from "../tokens";

const PREV = 78;
/** The preview tile's letterbox. Matches the top bar, so the canvas reads as recessed chrome. */
const PREV_BG = SURFACE.topbar;

const SPECS = tabMetrics("paste");
const W = (g: string) => specWidth("paste", g);

export default function ClipboardTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const cb = p.clipboard;
  const needsSelection = p.pasteMode === "scatter" && !p.rawBounds;

  const pixels = p.clipboard ? p.clipboardPreview : null;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = PREV_BG;
    ctx.fillRect(0, 0, PREV, PREV);
    if (pixels && pixels.width > 0 && pixels.height > 0) {
      const off = previewCanvas(pixels);
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
      <Group id="preview" label="Preview" tier={tier.preview} declaredWidth={W("preview")} icon="paste">
        <canvas ref={canvasRef} width={PREV} height={PREV} aria-label="Clipboard top-down preview"
          style={{ display: "block", width: PREV, height: PREV, borderRadius: RADIUS.md, background: PREV_BG, imageRendering: "pixelated", boxShadow: `inset 0 0 0 1px ${BORDER.outline}` }} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          {cb && (<>
            <div style={{ color: lighten(ACCENT.clipboard), fontSize: FONT.body, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {cb.width}×{cb.height}×{cb.depth}
            </div>
            <FieldLabel>z {cb.z_anchor}–{cb.z_anchor + cb.depth - 1}</FieldLabel>
            <FieldLabel>{(cb.width * cb.height * cb.depth).toLocaleString()} cells</FieldLabel>
          </>)}
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Place ─────────────────────────────────────────────────────────── */}
      <Group id="place" label="Place" tier={tier.place} declaredWidth={W("place")} icon="paste">
        <Cmd id="home.clipboard.paste" tier={contentTier(tier.place)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="paste.place.confirm" full />
          <CmdSmall id="paste.place.unlock" full />
          <CmdSetting id="paste.place.offset"><Row style={{ height: SMALL_H }}>
            <FieldLabel width={44}>Z offset</FieldLabel>
            <NumField value={p.pasteElevationOffset} onChange={p.setPasteElevationOffset}
              ariaLabel="Paste elevation offset" width={46} />
            <FieldLabel>PgUp/PgDn</FieldLabel>
          </Row></CmdSetting>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Transform — same callbacks Home exposes ───────────────────────── */}
      <Group id="transform" label="Transform" tier={tier.transform} declaredWidth={W("transform")} icon="rotate">
        <Cmd id="home.clipboard.rotate" tier={contentTier(tier.transform)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="home.clipboard.flipX" full />
          <CmdSmall id="home.clipboard.flipY" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Options ───────────────────────────────────────────────────────── */}
      <Group id="options" label="Options" tier={tier.options} declaredWidth={W("options")} icon="settings">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <Row style={{ height: SMALL_H }}>
            <CmdSmall id="home.clipboard.skipAir" label="Skip air" />
            <CmdSmall id="home.clipboard.repeat" label="Repeat" />
          </Row>
          <Row style={{ height: SMALL_H }}>
            <CmdSmall id="home.clipboard.followTerrain" label="Terrain" />
            {p.pasteTerrain && <CmdSmall id="paste.options.above" />}
          </Row>
          <Caption>{p.pasteTerrain ? "Following terrain height" : "Fixed Z anchor"}</Caption>
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Mode ──────────────────────────────────────────────────────────── */}
      <Group id="mode" name="Mode" tier={tier.mode} declaredWidth={W("mode")} icon="pasteMode"
        label={<>Mode{needsSelection ? <span style={{ color: TEXT_DIM, marginLeft: 4 }}>(needs a selection)</span> : null}</>}>
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSetting id="paste.mode.pattern">
            <Segmented ariaLabel="Paste mode" accent={ACCENT.clipboard} value={p.pasteMode} onChange={p.setPasteMode}
              options={[
                { id: "normal", label: "1×", title: "One copy per click" },
                { id: "scatter", label: "Scatter", title: "Distribute N copies inside the selection" },
                { id: "array", label: "Array", title: "Grid of copies with fixed spacing" },
              ]} />
          </CmdSetting>
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
      <Group id="prefab" label="Prefab" tier={tier.prefab} declaredWidth={W("prefab")} icon="savePrefab">
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="insert.prefab.save" full />
          <CmdSmall id="insert.prefab.saveAs" full />
          <Caption tone={TEXT}>Shaped masks are kept</Caption>
        </Col>
      </Group>
    </>
  );
}
