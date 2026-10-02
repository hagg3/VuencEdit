import React, { useState } from "react";
import { MODAL_TEXT } from "./designTokens";
import ShortcutTable from "./commands/ShortcutTable";
import { ALT, MOD, ACCENT } from "./ribbon/tokens";
import { rgba } from "./theme/theme";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: "inline-block",
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderBottom: "2px solid rgba(0,0,0,0.35)",
      borderRadius: 4,
      padding: "1px 7px",
      fontSize: 11,
      fontFamily: "ui-monospace, 'SF Mono', monospace",
      color: MODAL_TEXT.primary,
      marginRight: 2,
      whiteSpace: "nowrap",
    }}>
      {children}
    </kbd>
  );
}

function Row({ keys, action }: { keys: React.ReactNode; action: string }) {
  return (
    <tr>
      <td style={{ padding: "5px 20px 5px 0", whiteSpace: "nowrap", verticalAlign: "middle" }}>
        {keys}
      </td>
      <td style={{ padding: "5px 0", color: MODAL_TEXT.secondary, fontSize: 13, verticalAlign: "middle" }}>
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
        fontSize: 10, fontWeight: 700,
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
];

function TileName({ name }: { name: string }) {
  return (
    <span style={{
      display: "inline-block",
      fontFamily: "ui-monospace, 'SF Mono', monospace",
      fontSize: 11,
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
    <div style={{ fontSize: 13, color: MODAL_TEXT.secondary, lineHeight: 1.6 }}>

      <div style={sectionHead}>Ribbon tabs</div>
      <p style={{ margin: "4px 0 10px" }}>
        Five tabs hold every tool: <b style={strong}>Home</b>, <b style={strong}>Draw</b>,{" "}
        <b style={strong}>Sculpt</b>, <b style={strong}>Insert</b> and <b style={strong}>View</b>.{" "}
        <b style={strong}>3D</b> appears while the 3D view is open, <b style={strong}>Selection</b>{" "}
        when you have a selection, and <b style={strong}>Clipboard</b> once you've copied something.
        Arming a tool switches to its tab.
      </p>

      <div style={sectionHead}>Floating windows</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Tools</b> (<Key>{ALT}T</Key>), <b style={strong}>3D view</b> (<Key>{ALT}3</Key>),{" "}
        <b style={strong}>Hotbar</b> (<Key>{ALT}H</Key>) and the paste <b style={strong}>Lens</b>{" "}
        (<Key>{ALT}P</Key>) are floating windows. Drag a title bar to move one, or a corner to resize
        it. Each world keeps its own layout. <Key>Tab</Key> swaps the map and the 3D view.
      </p>

      <div style={sectionHead}>Mode panels</div>
      <p style={{ margin: "4px 0 10px" }}>
        Some modes open a small panel: the <b style={strong}>brush shape</b> for sculpt tools, the
        level for <b style={strong}>Z-slice</b> and <b style={strong}>Cutaway</b>, and the build slot
        in 3D. Close the panel to leave the mode.
      </p>

      <div style={sectionHead}>Relief shading</div>
      <p style={{ margin: "4px 0 10px" }}>
        View ▸ Render ▸ <b style={strong}>Relief</b> shades slopes so hills and cliffs stand out. It
        only changes the map display, not PNG export.
      </p>

      <div style={sectionHead}>Command search</div>
      <p style={{ margin: "4px 0 10px" }}>
        <Key>{MOD}K</Key> searches every command. Enter runs it, <Key>Tab</Key> shows it in the ribbon.
      </p>
    </div>
  );
}

function TexturePackHelp() {
  return (
    <div style={{ fontSize: 13, color: MODAL_TEXT.secondary, lineHeight: 1.6 }}>

      {/* Format */}
      <div style={sectionHead}>Format</div>
      <p style={{ margin: "4px 0 10px" }}>
        Two inputs are accepted:
      </p>
      <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
        <li>
          A <b style={strong}>.zip</b> containing PNG images named after the tile
          names below (may also bundle <code>atlas.png</code> / <code>atlas2.png</code>).
        </li>
        <li>
          A game-style <b style={strong}>atlas image</b> (<code>atlas.png</code>):
          a vertical strip of square tiles in the original block-texture order. Load it directly.
        </li>
      </ul>
      <p style={{ margin: "4px 0 10px" }}>
        Tiles can be any size and are scaled to <b style={strong}>32×32</b>. Missing tiles use the
        flat block colour.
      </p>

      {/* Loading */}
      <div style={sectionHead}>Loading</div>
      <p style={{ margin: "4px 0 10px" }}>
        Load a pack from <b style={strong}>View ▸ Load Texture Pack…</b>, or set a default in{" "}
        <b style={strong}>Settings ▸ Files</b>. Textures show in the 3D view and the block picker.
      </p>

      {/* Tinting */}
      <div style={sectionHead}>Colour tinting</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Unpainted</b> blocks show the tile as drawn. <b style={strong}>Painted</b>{" "}
        blocks tint a greyscale copy of the tile, as the game does. Draw tiles in full colour.
      </p>

      {/* Tile names */}
      <div style={sectionHead}>Tile names</div>
      {TILE_GROUPS.map(g => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: MODAL_TEXT.label, letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 3 }}>
            {g.label}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
            {g.tiles.map(t => <TileName key={t} name={t} />)}
          </div>
        </div>
      ))}

      {/* Face mapping */}
      <div style={{ ...sectionHead, marginTop: 10 }}>Face mapping (selected blocks)</div>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4 }}>
        <tbody>
          {[
            ["Grass / Grass2 / Grass3", "Side: grass_side(_color) · Bottom: dirt · Top: grass_top"],
            ["Trunk", "Side: tree_side · Top + bottom: tree_vert"],
            ["TNT", "Side: tnt_side(_color) · Top: tnt_top(_color)"],
            ["Brick", "All faces: brick(_color)"],
            ["Ramps / Wedges", "Use the same tile as their material (e.g. stone, wood)"],
            ["Expansion blocks 82–111", "Side + bottom: blocktnt · Top: base material"],
          ].map(([block, faces]) => (
            <tr key={block}>
              <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{block}</td>
              <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: 11 }}>{faces}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolsHelp() {
  return (
    <div style={{ fontSize: 13, color: MODAL_TEXT.secondary, lineHeight: 1.6 }}>

      {/* Sculpt */}
      <div style={sectionHead}>Terrain sculpt</div>
      <p style={{ margin: "4px 0 10px" }}>
        Arm a tool from Sculpt ▸ Tools and drag over terrain. With <b style={strong}>Live brush</b> on
        (the default), terrain changes as you drag, and <Key>Esc</Key> mid-stroke reverts it. With it
        off, the stroke applies on release.
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        <tbody>
          {[
            ["Raise / Lower", "Push terrain up or down by Strength"],
            ["Grab", "Drag up or down to pull a dome of terrain"],
            ["Smooth", "Evens out bumps"],
            ["Flatten", "Levels terrain to the height you click"],
            ["Slope", "Flatten tilted to a plane through the clicked anchor (Slope X/Y in the Brush shape panel)"],
            ["Terrace", "Steps terrain into Strength-high terraces"],
            ["Smear", "Pulls terrain along with the brush"],
            ["Sharpen", "Crisps terrain (opposite of Smooth)"],
            ["Noise", "Adds hills or ridged mountains"],
            ["Erode / Thermal / Hydro", "Erosion from gentle to strong: slides, then water flow"],
            ["Retexture", "Repaints by slope (flat: grass, mid: dirt, steep: stone) without changing height"],
            ["Rock", "Places a rock mass fused into the terrain. Tune it in the Rock shape panel."],
            ["Carve", "Cuts a rounded hollow. It only removes exposed terrain, so it never opens a cave roof. Tune it in the Carve shape panel."],
          ].map(([mode, desc]) => (
            <tr key={mode}>
              <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Softness</b> fades the effect toward the brush edge: 0 is a hard edge, higher
        is a softer dome (Profile sets its shape). <b style={strong}>In selection</b> keeps strokes
        inside the selection.
      </p>

      {/* Gradient fill */}
      <div style={sectionHead}>Gradient fill</div>
      <p style={{ margin: "4px 0 10px" }}>
        In the Selection tab, Gradient blends the Write block into the Fade block across the
        selection, dithered to avoid bands. <b style={strong}>Axis</b> sets the direction: X or Y
        across the map, Z by height. Only existing blocks change unless <b style={strong}>+Air</b> is on.
      </p>

      {/* 3D pane */}
      <div style={sectionHead}>3D view: camera and build</div>
      <p style={{ margin: "4px 0 10px" }}>
        Open it from View ▸ Windows ▸ 3D View (<Key>{ALT}3</Key>), and swap it with the map using ⇄ or{" "}
        <Key>Tab</Key>. Click the camera pill (top left) or press <Key>Z</Key> to change mode:
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        <tbody>
          {[
            ["Orbit", "Drag to rotate, scroll to zoom"],
            ["Look", "WASD to move, the mouse to look. Esc or Z exits."],
            ["Fly", "WASD to move, left-drag to look"],
          ].map(([mode, desc]) => (
            <tr key={mode}>
              <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Build mode</b> (3D tab): left-click breaks the block you aim at, right-click
        places the active block on that face. Drag to break or place a row. Middle-click picks a
        block. Ramps, wedges and doors face you when placed (turn this off with Auto-orient in the
        pane's <Key>…</Key> menu). <b style={strong}>Select mode</b>: click two corners to make a 3D
        selection.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Sculpt mode</b>: hold left to sculpt with the current Sculpt tool and brush.
        An amber disc shows the brush. Drag-to-look is off while sculpting, so use Look mode or WASD.
        Grab applies on release.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Night Lighting</b>, <b style={strong}>Shadows</b> and{" "}
        <b style={strong}>GPU Shadows</b> (3D tab ▸ Lighting) are slow and experimental. They turn off
        whenever you load a world.
      </p>
    </div>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: MODAL_TEXT.label,
  letterSpacing: "0.08em", textTransform: "uppercase",
  marginTop: 14, marginBottom: 2,
};

type HelpTab = "start" | "tools" | "shortcuts" | "textures";

const NAV_ITEMS: DialogNavItem[] = [
  { id: "start", icon: "sparkle", label: "Getting started", description: "Ribbon tabs, floating windows, ⌘K" },
  { id: "tools", icon: "sculpt", label: "Tools", description: "Sculpt, gradient fill and the 3D pane" },
  { id: "shortcuts", icon: "quickActions", label: "Shortcuts", description: "Every keyboard shortcut" },
  { id: "textures", icon: "textures", label: "Textures", description: "Pack format and tile names (experimental)" },
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
