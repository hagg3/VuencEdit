import React, { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MODAL_TEXT } from "./designTokens";
import ShortcutTable from "./commands/ShortcutTable";
import { ALT, MOD, ACCENT, FONT } from "./ribbon/tokens";
import { rgba } from "./theme/theme";
import { Keycap } from "./ribbon/primitives";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";

function Key({ children }: { children: React.ReactNode }) {
  return <span style={{ marginRight: 2 }}><Keycap text={children} /></span>;
}

function Row({ keys, action }: { keys: React.ReactNode; action: string }) {
  return (
    <tr>
      <td style={{ padding: "5px 20px 5px 0", whiteSpace: "nowrap", verticalAlign: "middle" }}>
        {keys}
      </td>
      <td style={{ padding: "5px 0", color: MODAL_TEXT.secondary, fontSize: FONT.tab, verticalAlign: "middle" }}>
        {action}
      </td>
    </tr>
  );
}

function Section({ title }: { title: string }) {
  return (
    <tr>
      <td colSpan={2} style={{
        paddingTop: 16, paddingBottom: 3,
        fontSize: FONT.micro, fontWeight: 700,
        color: MODAL_TEXT.label, letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}>
        {title}
      </td>
    </tr>
  );
}

/** Shared emphasis style for inline `<b>` terms across the help pages below. */
const strong: React.CSSProperties = { color: MODAL_TEXT.primary };

const TILE_GROUPS: { label: string; tiles: string[] }[] = [
  {
    label: "Terrain",
    tiles: ["grass_top", "grass_top2", "grass_side", "dirt", "sand", "stone", "bedrock", "dark_stone"],
  },
  {
    label: "Wood & Plants",
    tiles: ["tree_side", "tree_vert", "wood", "leaves", "vine", "ladder"],
  },
  {
    label: "Manufactured",
    tiles: ["brick", "cobblestone", "shingle", "steel", "glass", "ice", "crystal", "cloud", "weave"],
  },
  {
    label: "Special",
    tiles: ["tnt_side", "tnt_top", "water", "lava", "gradient", "lightbox", "trampoline", "firework"],
  },
  {
    label: "Expansion blocks (side + bottom)",
    tiles: ["blocktnt"],
  },
  {
    label: "Doors & portals (halves of door.png / portal.png)",
    tiles: ["door_top", "door_bottom", "portal_top", "portal_bottom"],
  },
  {
    label: "New-format blocks (112–127)",
    tiles: ["ore_sand", "space_stone", "carpet", "snakeskin", "obsidian", "cheese", "space_dirt", "space_grass", "moss", "dark_matter", "space_sand", "snow", "moonrock", "basalt", "dark_tile", "algae"],
  },
];

function TileName({ name }: { name: string }) {
  return (
    <span style={{
      display: "inline-block",
      fontFamily: "ui-monospace, 'SF Mono', monospace",
      fontSize: FONT.label,
      color: ACCENT.primary,
      background: rgba(ACCENT.primary, 0.10),
      border: `1px solid ${rgba(ACCENT.primary, 0.3)}`,
      borderRadius: 3,
      padding: "1px 5px",
      margin: "1px 2px",
      whiteSpace: "nowrap",
    }}>
      {name}.png
    </span>
  );
}

function GettingStartedHelp() {
  return (
    <div className="vx-selectable" style={body}>
      <div style={sectionHead}>Basics</div>
      <p style={para}>
        Open a world with <Key>{MOD}O</Key> or start one with <Key>{MOD}N</Key>. Every edit can be
        undone (<Key>{MOD}Z</Key>). Nothing touches the file until you save (<Key>{MOD}S</Key>).
      </p>

      <div style={sectionHead}>Ribbon</div>
      <p style={para}>
        <b style={strong}>Home</b>, <b style={strong}>Draw</b>, <b style={strong}>Sculpt</b>,{" "}
        <b style={strong}>Insert</b> and <b style={strong}>View</b> are always there.{" "}
        <b style={strong}>Selection</b>, <b style={strong}>Clipboard</b> and <b style={strong}>3D</b>{" "}
        appear when you select, copy or open the 3D view.
      </p>

      <div style={sectionHead}>Options bar</div>
      <p style={para}>
        The bar under the ribbon shows settings for the current tool. The Z-slice and Cutaway level
        sits at its right end.
      </p>

      <div style={sectionHead}>Windows</div>
      <p style={para}>
        <b style={strong}>Tools</b> (<Key>{ALT}T</Key>), <b style={strong}>3D view</b> (<Key>{ALT}3</Key>),{" "}
        <b style={strong}>Hotbar</b> (<Key>{ALT}H</Key>) and <b style={strong}>Lens</b> (<Key>{ALT}P</Key>,
        side views of a selection or paste) float over the map. Each world keeps its own layout.
      </p>

      <div style={sectionHead}>Command search</div>
      <p style={para}>
        <Key>{MOD}K</Key> finds any command. Enter runs it, <Key>Tab</Key> shows where it lives in the ribbon.
      </p>
    </div>
  );
}

function TexturePackHelp() {
  return (
    <div className="vx-selectable" style={body}>
      <div style={sectionHead}>Loading a pack</div>
      <p style={para}>
        <b style={strong}>View ▸ Load Texture Pack…</b> accepts a <b style={strong}>.zip</b> of PNGs
        named after the tiles below, or a game-style <code>atlas.png</code>.{" "}
        <b style={strong}>Default Texture Pack</b> switches back. A pack set in{" "}
        <b style={strong}>Settings ▸ Files</b> loads every launch.
      </p>
      <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
        <li>Tiles can be any size; they're scaled to 32×32. Missing tiles use the flat block colour.</li>
        <li>
          Doors and portals aren't in the atlas: add <code>door.png</code> (32×64) and{" "}
          <code>portal.png</code> (64×128) to the zip or next to <code>atlas.png</code>.
        </li>
        <li>Painted blocks tint a greyscale copy of the tile, like the game, so draw tiles in full colour.</li>
      </ul>

      {/* Tile names */}
      <div style={sectionHead}>Tile names</div>
      {TILE_GROUPS.map(g => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: FONT.micro, fontWeight: 700, color: MODAL_TEXT.label, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 3 }}>
            {g.label}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            {g.tiles.map(t => <TileName key={t} name={t} />)}
          </div>
        </div>
      ))}

      <div style={{ ...sectionHead, marginTop: 10 }}>Which tile goes where</div>
      <table style={table}>
        <tbody>
          {[
            ["Grass", "Top: grass_top · Side: grass_side · Bottom: dirt"],
            ["Trunk", "Side: tree_side · Ends: tree_vert"],
            ["TNT", "Side: tnt_side · Top: tnt_top"],
            ["Doors / Portals", "door_top + door_bottom, portal_top + portal_bottom"],
            ["Ramps / Wedges", "Their material's tile"],
            ["Blocks 82–111", "Side + bottom: blocktnt · Top: base material"],
            ["Blocks 112–127", "Their own tile on every face"],
          ].map(([block, faces]) => <TableRow key={block} name={block} desc={faces} />)}
        </tbody>
      </table>
    </div>
  );
}

function ToolsHelp() {
  return (
    <div className="vx-selectable" style={body}>
      <div style={sectionHead}>Draw and select</div>
      <p style={para}>
        Draw tools paint the active block on the map. Select with a box, wand, lasso or polygon
        (Home tab); the Selection tab then fills, replaces, extrudes or moves it, using its exact shape.
      </p>

      <div style={sectionHead}>Sculpt</div>
      <p style={para}>
        Pick a tool on the Sculpt tab and drag over terrain. <Key>[</Key> <Key>]</Key> change the
        radius. With <b style={strong}>Live brush</b> off, a stroke applies when you let go.
      </p>
      <table style={table}>
        <tbody>
          {[
            ["Raise / Lower", "Push terrain up or down"],
            ["Rock", "Add a rock mass in the Sculpt block"],
            ["Carve", "Cut a rounded hollow (never opens a cave roof)"],
            ["Smooth / Sharpen", "Soften or crisp up bumps"],
            ["Flatten / Slope", "Level to the clicked height, or to a tilted plane"],
            ["Grab / Smear", "Pull terrain up, down or along the stroke"],
            ["Terrace", "Cut into steps"],
            ["Noise", "Add hills or mountains"],
            ["Thermal / Hydro", "Erosion"],
            ["Retexture", "Repaint grass, dirt and stone by slope"],
          ].map(([mode, desc]) => <TableRow key={mode} name={mode} desc={desc} />)}
        </tbody>
      </table>
      <p style={para}>
        Rock and Carve have more settings under <b style={strong}>Shape</b> in the options bar.
      </p>

      <div style={sectionHead}>Gradient fill</div>
      <p style={para}>
        Selection tab ▸ Gradient blends the Write block into the Fade block along the chosen axis.
        Only existing blocks change unless <b style={strong}>+Air</b> is on.
      </p>
    </div>
  );
}

function View3DHelp() {
  return (
    <div className="vx-selectable" style={body}>
      <div style={sectionHead}>Camera</div>
      <p style={para}>
        Open with <Key>{ALT}3</Key>. <Key>Tab</Key> swaps it with the map. Press <Key>Z</Key> or
        click the camera pill to switch modes:
      </p>
      <table style={table}>
        <tbody>
          {[
            ["Orbit", "Drag to rotate, scroll to zoom"],
            ["Look", "WASD and the mouse. Esc exits."],
            ["Fly", "WASD, left-drag to look"],
          ].map(([mode, desc]) => <TableRow key={mode} name={mode} desc={desc} />)}
        </tbody>
      </table>

      <div style={sectionHead}>Modes (3D tab)</div>
      <table style={table}>
        <tbody>
          {[
            ["Build", "Left-click breaks, right-click places, middle-click picks a block"],
            ["Select", "Click two corners"],
            ["Sculpt", "Hold left to use the current sculpt tool"],
            ["Flood Fill", "Click a face to fill the connected air"],
          ].map(([mode, desc]) => <TableRow key={mode} name={mode} desc={desc} />)}
        </tbody>
      </table>
      <p style={para}>
        Ramps, wedges and doors face you when placed. Turn that off with Auto-orient in the view's{" "}
        <Key>…</Key> menu.
      </p>

      <div style={sectionHead}>Lighting</div>
      <p style={para}>
        Night lighting and GPU shadows are slow and turn off when you load another world.
      </p>
    </div>
  );
}

function WebLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={e => { e.preventDefault(); void openUrl(href); }}
      style={{ color: ACCENT.primary, textDecoration: "none" }}
      onMouseEnter={e => (e.currentTarget.style.textDecoration = "underline")}
      onMouseLeave={e => (e.currentTarget.style.textDecoration = "none")}
    >
      {children}
    </a>
  );
}

const SITE = "https://hagg3.github.io/VuencEdit";

const TUTORIALS: [string, string][] = [
  ["First edit and save", "first-edit"],
  ["Sculpt terrain", "sculpt-terrain"],
  ["Copy, paste and prefabs", "copy-paste-prefabs"],
  ["Generate a world", "generate-world"],
  ["3D view and building in 3D", "build-in-3d"],
  ["Download and upload a world", "download-upload"],
];

function OnlineHelp() {
  return (
    <div className="vx-selectable" style={body}>
      <div style={sectionHead}>Website</div>
      <p style={para}>
        Guides for every part of the app: <WebLink href={`${SITE}/docs/`}>VuencEdit Help</WebLink>
      </p>

      <div style={sectionHead}>Tutorials</div>
      <ul style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
        {TUTORIALS.map(([label, slug]) => (
          <li key={slug}><WebLink href={`${SITE}/docs/tutorials/${slug}/`}>{label}</WebLink></li>
        ))}
      </ul>

      <div style={sectionHead}>Questions and bugs</div>
      <p style={para}>
        Ask on the <WebLink href="https://discord.com/invite/rjYXwBC">Discord server</WebLink> or{" "}
        <WebLink href="https://github.com/hagg3/VuencEdit/issues">open an issue on GitHub</WebLink>.
      </p>
    </div>
  );
}

const body: React.CSSProperties = { fontSize: FONT.tab, color: MODAL_TEXT.secondary, lineHeight: 1.6 };
const para: React.CSSProperties = { margin: "4px 0 10px" };
const table: React.CSSProperties = { borderCollapse: "collapse", fontSize: FONT.body, marginTop: 4, marginBottom: 10 };

function TableRow({ name, desc }: { name: string; desc: string }) {
  return (
    <tr>
      <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{name}</td>
      <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: FONT.label }}>{desc}</td>
    </tr>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: FONT.micro, fontWeight: 700, color: MODAL_TEXT.label,
  letterSpacing: "0.08em", textTransform: "uppercase",
  marginTop: 14, marginBottom: 2,
};

type HelpTab = "start" | "tools" | "3d" | "shortcuts" | "textures" | "online";

const NAV_ITEMS: DialogNavItem[] = [
  { id: "start", icon: "sparkle", label: "Getting started", description: "The basics" },
  { id: "tools", icon: "sculpt", label: "Tools", description: "Draw, select and sculpt" },
  { id: "3d", icon: "pane3d", label: "3D view", description: "Camera, building, lighting" },
  { id: "shortcuts", icon: "quickActions", label: "Shortcuts", description: "Every keyboard shortcut" },
  { id: "textures", icon: "textures", label: "Textures", description: "Custom texture packs" },
  { id: "online", icon: "world", label: "Tutorials", description: "Guides on the website" },
];

export default function HelpModal({ onClose, onStartTour }: { onClose: () => void; onStartTour?: () => void }) {
  const [tab, setTab] = useState<HelpTab>("start");

  return (
    <Dialog
      size="md" icon="help" title="Help" onClose={onClose}
      nav={
        <DialogNav
          items={NAV_ITEMS} value={tab} onChange={id => setTab(id as HelpTab)}
          footer={onStartTour && (
            <DialogButton
              onClick={() => { onStartTour(); onClose(); }}
              title="Replay the guided tour"
              style={{ width: "100%", height: "auto", whiteSpace: "normal", lineHeight: 1.3, padding: "6px 8px" }}
            >
              Guided tour
            </DialogButton>
          )}
        />
      }
    >
      {tab === "start" ? (
        <GettingStartedHelp />
      ) : tab === "tools" ? (
        <ToolsHelp />
      ) : tab === "3d" ? (
        <View3DHelp />
      ) : tab === "online" ? (
        <OnlineHelp />
      ) : tab === "shortcuts" ? (
        // Generated from the command registry (14.6) — declare a shortcut in
        // `commands/meta.ts` and it appears here; nothing is mirrored by hand any more.
        <ShortcutTable Key={Key} Section={Section} RowEl={Row} />
      ) : (
        <TexturePackHelp />
      )}
    </Dialog>
  );
}
