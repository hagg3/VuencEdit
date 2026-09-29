/**
 * HOME — what you touch constantly. The mockup is normative for this tab.
 *
 * Clipboard · Navigation · Selection · Palette · Set Point. The old World readout moved to the
 * top bar's world pill and Create moved into the application menu, which is what freed the width
 * for a real command hierarchy here.
 */
import { useMemo } from "react";
import { contentTier } from "../layout";
import { tabMetrics, specWidth, solveRow } from "../specs";
import { useRibbon } from "../context";
import BlockButton from "../BlockButton";
import { Cmd, CmdDropdown, CmdMenuItem, CmdSmall } from "../Cmd";
import { Col, Group, GroupDivider, MenuSeparator, MoreChevron } from "../primitives";
import { GROUP_CONTENT_H, ROW_GAP } from "../tokens";

/** Declared widths feed the pure solver (`ribbon/specs.ts`); the dev-mode `ResizeObserver` in `Group` warns on drift. */
const SPECS = tabMetrics("home");
const W = (g: string) => specWidth("home", g);

export default function HomeTab() {
  const { p, bodyWidth } = useRibbon();
  const tier = useMemo(() => solveRow(SPECS, bodyWidth), [bodyWidth]);
  const hasSel = !!p.rawBounds;

  return (
    <>
      {/* ── Clipboard ─────────────────────────────────────────────────────── */}
      <Group id="clipboard" label="Clipboard" tier={tier.clipboard} declaredWidth={W("clipboard")} icon="paste">
        <Cmd id="home.clipboard.paste" tier={contentTier(tier.clipboard)} />
        <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: ROW_GAP, alignContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="home.clipboard.copy" full />
          <CmdSmall id="home.clipboard.rotate" full />
          <CmdSmall id="home.clipboard.cut" full />
          <CmdSmall id="home.clipboard.flipX" full />
          <CmdDropdown id="home.clipboard.mode" full menu={() => (<>
            <CmdMenuItem id="home.clipboard.modeSingle" />
            <CmdMenuItem id="home.clipboard.modeScatter" />
            <CmdMenuItem id="home.clipboard.modeArray" />
            <MenuSeparator />
            <CmdMenuItem id="home.clipboard.skipAir" />
            <CmdMenuItem id="home.clipboard.repeat" />
            <CmdMenuItem id="home.clipboard.followTerrain" />
          </>)} />
          <CmdSmall id="home.clipboard.flipY" full />
        </div>
      </Group>
      <GroupDivider />

      {/* ── Navigation ────────────────────────────────────────────────────── */}
      <Group id="navigation" label="Navigation" tier={tier.navigation} declaredWidth={W("navigation")} icon="pan">
        <Cmd id="home.navigation.pan" tier={contentTier(tier.navigation)} />
        <Cmd id="home.navigation.select" tier={contentTier(tier.navigation)} />
        <Cmd id="home.navigation.wand" tier={contentTier(tier.navigation)} />
        <MoreChevron title="More selection tools">
          {() => (<>
            <CmdMenuItem id="home.navigation.lasso" />
            <CmdMenuItem id="home.navigation.polyselect" />
            <CmdMenuItem id="draw.tools.eyedropper" />
            {p.tool === "wand" && <CmdMenuItem id="home.navigation.wandMatch" />}
          </>)}
        </MoreChevron>
      </Group>
      <GroupDivider />

      {/* ── Selection ─────────────────────────────────────────────────────── */}
      <Group id="selection" label="Selection" tier={tier.selection} declaredWidth={W("selection")} icon="select"
        dim={!hasSel} dimNote="(none)">
        <Cmd id="home.selection.delete" tier={contentTier(tier.selection)} label="Delete" />
        <Cmd id="home.selection.fill" tier={contentTier(tier.selection)} />
        <Col style={{ justifyContent: "center", height: GROUP_CONTENT_H }}>
          <CmdSmall id="home.selection.grow" full />
          <CmdSmall id="home.selection.shrink" full />
          <CmdSmall id="home.selection.clear" full />
        </Col>
      </Group>
      <GroupDivider />

      {/* ── Block ─────────────────────────────────────────────────────────── */}
      <BlockButton cmd="home.block.pick" tier={tier.block} declaredWidth={W("block")} />
      <GroupDivider />

      {/* ── Set Point ─────────────────────────────────────────────────────── */}
      <Group id="setpoint" label="Set Point" tier={tier.setpoint} declaredWidth={W("setpoint")} icon="home"
        dim={!p.selection} dimNote="(no selection)">
        <Cmd id="home.setpoint.home" tier="full" />
        <Cmd id="home.setpoint.start" tier="full" />
      </Group>
    </>
  );
}
