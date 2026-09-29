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
        Five permanent tabs run across the top — <b style={strong}>Home</b>, <b style={strong}>Draw</b>,{" "}
        <b style={strong}>Sculpt</b>, <b style={strong}>Insert</b> and <b style={strong}>View</b> —
        grouping every tool and setting by what you're doing. Three more appear only when they're
        relevant: <b style={strong}>3D</b> while the 3D pane is open, <b style={strong}>Selection</b>{" "}
        once you have one, and <b style={strong}>Clipboard</b> once you've copied something. Picking
        up a tool switches to its tab for you.
      </p>

      <div style={sectionHead}>Floating windows</div>
      <p style={{ margin: "4px 0 10px" }}>
        The map isn't the only pane — <b style={strong}>Tools</b> (<Key>{ALT}T</Key>),{" "}
        <b style={strong}>3D view</b> (<Key>{ALT}3</Key>), <b style={strong}>Hotbar</b>{" "}
        (<Key>{ALT}H</Key>) and the paste <b style={strong}>Lens</b> (<Key>{ALT}P</Key>) are all
        floating windows you can drag by their title bar, resize from the corner, dock to an edge, or
        hide entirely. Each world remembers its own layout. <Key>Tab</Key> swaps focus between the
        map and the 3D view whenever one of them has it.
      </p>

      <div style={sectionHead}>Mode panels</div>
      <p style={{ margin: "4px 0 10px" }}>
        A few modes open a small panel of their own while they're active: the{" "}
        <b style={strong}>brush shape</b> while a sculpt tool is armed, the level slider for{" "}
        <b style={strong}>Z-slice</b> and <b style={strong}>Cutaway</b>, and the build slot in the 3D
        view. They can't be toggled from View ▸ Windows — closing one with its ✕ leaves the mode.
      </p>

      <div style={sectionHead}>Relief shading</div>
      <p style={{ margin: "4px 0 10px" }}>
        View ▸ Render ▸ <b style={strong}>Relief</b> shades the top-down map's slopes as if lit from
        the north-west, so hills, cliffs and valleys read at a glance. It's a display effect only —
        PNG export, Z-slice and the paste lens stay unshaded.
      </p>

      <div style={sectionHead}>Command search</div>
      <p style={{ margin: "4px 0 10px" }}>
        <Key>{MOD}K</Key> opens a search box over every command in the app — type a few letters of
        what you're after (a tool, a setting, a menu item), arrow keys or the mouse to pick a result,
        Enter to run it, or <Key>Tab</Key> to jump to it in the ribbon instead of running it.
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
          A game-style <b style={strong}>atlas image</b> (<code>atlas.png</code>) —
          a vertical strip of square tiles in the original block-texture order. Load it directly.
        </li>
      </ul>
      <p style={{ margin: "4px 0 10px" }}>
        Any size is accepted — tiles are resized to <b style={strong}>32×32</b>{" "}
        internally (nearest-neighbour). Partial packs are fine: any missing tile falls back to the
        flat block colour.
      </p>

      {/* Loading */}
      <div style={sectionHead}>Loading</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>View tab → Load Texture Pack…</b> — or set a default path
        in <b style={strong}>Settings</b> so it loads automatically on startup.
        Textures appear in the 3D fly-through, 3D selection preview, and block-picker swatches.
      </p>

      {/* Tinting */}
      <div style={sectionHead}>Colour tinting</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Unpainted</b> blocks show your tile in full colour, as
        authored. <b style={strong}>Painted</b> blocks are modulated against a
        brightness-normalized greyscale of the tile, so the paint colour reads cleanly instead of
        double-tinting the tile's own colour — matching how the original game pairs each block's
        full-colour and greyscale textures. Author tiles in full colour and both cases are handled
        automatically.
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
        Axiom-style heightmap sculpting, armed from the Sculpt tools group. Click-drag over terrain
        to apply the active mode within a brush radius. <b style={strong}>Live brush</b>{" "}
        (on by default) deforms the terrain live as you drag and builds up on dwell like an airbrush;
        press <Key>Esc</Key> mid-stroke to revert the whole stroke. Turn Live brush off for the legacy
        one-shot behaviour — the swept stroke commits as a single uniform shape when you release.
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        <tbody>
          {[
            ["Raise / Lower", "Push or pull terrain up/down by Strength"],
            ["Grab", "Drag vertically to pull a whole dome of terrain up or down"],
            ["Smooth", "Averages each column against its neighbours — flattens bumps"],
            ["Flatten", "Levels everything in the brush to the height where you clicked"],
            ["Slope", "Flatten tilted to a plane through the clicked anchor (Slope X/Y % grade, in the Falloff group)"],
            ["Terrace", "Quantizes height into Strength-block steps — plateaus and stairs"],
            ["Smear", "Drag to pull terrain along with the brush, like wet paint"],
            ["Sharpen", "Unsharp mask — crisps terrain away from its local average, the inverse of Smooth"],
            ["Noise", "Adds coherent hills or ridged mountains (Hills/Mtns + feature size)"],
            ["Erode / Thermal / Hydro", "Progressively rougher erosion — talus slides, then simulated water flow"],
            ["Stamp / Retexture", "Repaints the surface by steepness (flat→grass, mid→dirt, steep→stone) without changing height"],
            ["Rock", "Stamps a volumetric rock mass fused into the terrain with a smooth fillet (not a heightmap offset) — ignores Strength/Softness, has its own Rock options group"],
            ["Carve", "Rock's inverse — cuts a filleted depression, deleting only sky-connected material so it can't open a floating roof or a sealed cave — ignores Strength/Softness"],
          ].map(([mode, desc]) => (
            <tr key={mode}>
              <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Softness</b> blends the effect out toward the edge of the
        brush instead of a hard cutoff — 0 is a flat hard edge, higher values dome the falloff
        (Profile picks the dome shape). <b style={strong}>In-selection</b> clips the
        stroke to the current selection, if any.
      </p>

      {/* Gradient fill */}
      <div style={sectionHead}>Gradient fill</div>
      <p style={{ margin: "4px 0 10px" }}>
        In the Selection tab: blends the Fill block into a second block across the selection,
        dithered so the transition doesn't band. Pick the second block via the swatch next to
        "Gradient to…". <b style={strong}>Axis</b> chooses which direction the blend
        runs — X/Y for a horizontal gradient across the map, Z for a vertical one (e.g. cliff
        striations, floor-to-ceiling shading). Only re-skins blocks that already exist unless
        "include air" is on.
      </p>

      {/* 3D pane */}
      <div style={sectionHead}>3D pane — camera & build</div>
      <p style={{ margin: "4px 0 10px" }}>
        A floating window over the map — View ▸ Windows ▸ 3D view (<Key>{ALT}3</Key>). Swap it with
        the map using ⇄ in its title bar or <Key>Tab</Key> (with focus on the map). The camera pill (top-left of the pane, or press{" "}
        <Key>Z</Key>) cycles three modes:
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        <tbody>
          {[
            ["Orbit", "Drag to rotate around a point, scroll to zoom — inspection mode"],
            ["Mouselook", "WASD to walk, mouse freely aims (cursor hidden/locked); Esc or Z to exit"],
            ["Fly", "WASD to walk, left-drag to look around; cursor stays visible"],
          ].map(([mode, desc]) => (
            <tr key={mode}>
              <td style={{ padding: "3px 16px 3px 0", color: MODAL_TEXT.primary, whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: MODAL_TEXT.secondary, fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Build mode</b> (3D tab → Camera/Select/Build) arms the same
        block as the map's fill block/hotbar — set it from either place and it stays in sync,
        including the <Key>1</Key>–<Key>0</Key> digit keys and an in-pane hotbar strip while
        building. While in Build, <b style={strong}>left-click breaks</b> the block
        you're aiming at and <b style={strong}>right-click places</b> the armed block
        against that face — the same convention as most block-building games. Holding either button
        down repeats break/place at the crosshair every ~220ms instead of single clicks (release, or
        drag past a few pixels, to stop). <b style={strong}>Middle-click</b> picks the
        block under the cursor as the new armed block, mirroring the map's eyedropper. Ramps, wedges,
        and doors auto-orient to face you as you place them (the pane's own <Key>…</Key> options
        disclosure has an Auto-orient toggle that turns this off, to use the picker's manual
        Dir/Apex buttons instead). Two highlight
        boxes show which block each click acts on. <b style={strong}>Select mode</b>{" "}
        lets you click two corners to make a 3D box selection, same as dragging one on the map.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Sculpt mode</b> (3D tab → Camera/Select/Build/Sculpt) sculpts
        terrain right in the 3D view with the same brush and tool settings as the 2D map's Sculpt
        group — press and hold left to stroke; an amber disc shows the brush radius at the picked
        surface. In Orbit, left-drag rotate is disabled while armed so it doesn't fight the stroke;
        in Fly mode drag-to-look is unavailable for the same reason — use Mouselook or WASD instead.
        Grab (drag vertically to raise/lower) has no hold-timer: it commits once on release.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={strong}>Night Lighting / Shadows / GPU Shadows</b> (3D tab → Lighting)
        are experimental and perf-heavy (⚡-badged) — they reset off every time you load a world.
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
              title="Replay the guided tour of the app's main surfaces"
              style={{ width: "100%", height: "auto", whiteSpace: "normal", lineHeight: 1.3, padding: "6px 8px" }}
            >
              Take the guided tour
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
