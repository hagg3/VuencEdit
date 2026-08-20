import React, { useState } from "react";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, glassTab, wipBadge } from "./designTokens";
import Modal from "./Modal";
import { MOD, SHIFT } from "./ribbon/tokens";

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
      color: "#dad6d2",
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
      <td style={{ padding: "5px 0", color: "#afa69d", fontSize: 13, verticalAlign: "middle" }}>
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
        color: "#61584f", letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}>
        {title}
      </td>
    </tr>
  );
}

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
      color: EDEN_TEAL_READABLE,
      background: `rgba(${EDEN_TEAL},0.10)`,
      border: `1px solid rgba(${EDEN_TEAL},0.3)`,
      borderRadius: 3,
      padding: "1px 5px",
      margin: "1px 2px",
      whiteSpace: "nowrap",
    }}>
      {name}.png
    </span>
  );
}

function TexturePackHelp() {
  return (
    <div style={{ fontSize: 13, color: "#afa69d", lineHeight: 1.6 }}>

      {/* Format */}
      <div style={sectionHead}>Format</div>
      <p style={{ margin: "4px 0 10px" }}>
        Two inputs are accepted:
      </p>
      <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
        <li>
          A <b style={{ color: "#ebe9e7" }}>.zip</b> containing PNG images named after the tile
          names below (may also bundle <code>atlas.png</code> / <code>atlas2.png</code>).
        </li>
        <li>
          A game-style <b style={{ color: "#ebe9e7" }}>atlas image</b> (<code>atlas.png</code>) —
          a vertical strip of square tiles in the original block-texture order. Load it directly.
        </li>
      </ul>
      <p style={{ margin: "4px 0 10px" }}>
        Any size is accepted — tiles are resized to <b style={{ color: "#ebe9e7" }}>32×32</b>{" "}
        internally (nearest-neighbour). Partial packs are fine: any missing tile falls back to the
        flat block colour.
      </p>

      {/* Loading */}
      <div style={sectionHead}>Loading</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>View tab → Load Texture Pack…</b> — or set a default path
        in <b style={{ color: "#ebe9e7" }}>Settings</b> so it loads automatically on startup.
        Textures appear in the 3D fly-through, 3D selection preview, and block-picker swatches.
      </p>

      {/* Tinting */}
      <div style={sectionHead}>Colour tinting</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>Unpainted</b> blocks show your tile in full colour, as
        authored. <b style={{ color: "#ebe9e7" }}>Painted</b> blocks are modulated against a
        brightness-normalized greyscale of the tile, so the paint colour reads cleanly instead of
        double-tinting the tile's own colour — matching how the original game pairs each block's
        full-colour and greyscale textures. Author tiles in full colour and both cases are handled
        automatically.
      </p>

      {/* Tile names */}
      <div style={sectionHead}>Tile names</div>
      {TILE_GROUPS.map(g => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#61584f", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 3 }}>
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
              <td style={{ padding: "3px 16px 3px 0", color: "#ebe9e7", whiteSpace: "nowrap", verticalAlign: "top" }}>{block}</td>
              <td style={{ padding: "3px 0", color: "#83786c", fontSize: 11 }}>{faces}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolsHelp() {
  return (
    <div style={{ fontSize: 13, color: "#afa69d", lineHeight: 1.6 }}>

      {/* Sculpt */}
      <div style={sectionHead}>Terrain sculpt</div>
      <p style={{ margin: "4px 0 10px" }}>
        Axiom-style heightmap sculpting, armed from the Sculpt tools group. Click-drag over terrain
        to apply the active mode within a brush radius. <b style={{ color: "#ebe9e7" }}>Live brush</b>{" "}
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
              <td style={{ padding: "3px 16px 3px 0", color: "#ebe9e7", whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: "#83786c", fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>Softness</b> blends the effect out toward the edge of the
        brush instead of a hard cutoff — 0 is a flat hard edge, higher values dome the falloff
        (Profile picks the dome shape). <b style={{ color: "#ebe9e7" }}>In-selection</b> clips the
        stroke to the current selection, if any.
      </p>

      {/* Gradient fill */}
      <div style={sectionHead}>Gradient fill</div>
      <p style={{ margin: "4px 0 10px" }}>
        In the Selection tab: blends the Fill block into a second block across the selection,
        dithered so the transition doesn't band. Pick the second block via the swatch next to
        "Gradient to…". <b style={{ color: "#ebe9e7" }}>Axis</b> chooses which direction the blend
        runs — X/Y for a horizontal gradient across the map, Z for a vertical one (e.g. cliff
        striations, floor-to-ceiling shading). Only re-skins blocks that already exist unless
        "include air" is on.
      </p>

      {/* 3D pane */}
      <div style={sectionHead}>3D pane — camera & build</div>
      <p style={{ margin: "4px 0 10px" }}>
        Enable via View ▾ → Quad View, then the 3D Pane toggle. The camera pill (top-left of the
        pane, or press <Key>Z</Key>) cycles three modes:
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 4, marginBottom: 10 }}>
        <tbody>
          {[
            ["Orbit", "Drag to rotate around a point, scroll to zoom — inspection mode"],
            ["Mouselook", "WASD to walk, mouse freely aims (cursor hidden/locked); Esc or Z to exit"],
            ["Fly", "WASD to walk, left-drag to look around; cursor stays visible"],
          ].map(([mode, desc]) => (
            <tr key={mode}>
              <td style={{ padding: "3px 16px 3px 0", color: "#ebe9e7", whiteSpace: "nowrap", verticalAlign: "top" }}>{mode}</td>
              <td style={{ padding: "3px 0", color: "#83786c", fontSize: 11 }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>Build mode</b> (3D tab → Camera/Select/Build) arms the same
        block as the map's fill block/hotbar — set it from either place and it stays in sync,
        including the <Key>1</Key>–<Key>0</Key> digit keys and an in-pane hotbar strip while
        building. While in Build, <b style={{ color: "#ebe9e7" }}>left-click breaks</b> the block
        you're aiming at and <b style={{ color: "#ebe9e7" }}>right-click places</b> the armed block
        against that face — the same convention as most block-building games. Holding either button
        down repeats break/place at the crosshair every ~220ms instead of single clicks (release, or
        drag past a few pixels, to stop). <b style={{ color: "#ebe9e7" }}>Middle-click</b> picks the
        block under the cursor as the new armed block, mirroring the map's eyedropper. Ramps, wedges,
        and doors auto-orient to face you as you place them (3D tab → Build Block → Auto-orient
        toggle turns this off to use the picker's manual Dir/Apex buttons instead). Two highlight
        boxes show which block each click acts on. <b style={{ color: "#ebe9e7" }}>Select mode</b>{" "}
        lets you click two corners to make a 3D box selection, same as dragging one on the map.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>Sculpt mode</b> (3D tab → Camera/Select/Build/Sculpt) sculpts
        terrain right in the 3D view with the same brush and tool settings as the 2D map's Sculpt
        group — press and hold left to stroke; an amber disc shows the brush radius at the picked
        surface. In Orbit, left-drag rotate is disabled while armed so it doesn't fight the stroke;
        in Fly mode drag-to-look is unavailable for the same reason — use Mouselook or WASD instead.
        Grab (drag vertically to raise/lower) has no hold-timer: it commits once on release.
      </p>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#ebe9e7" }}>Night Lighting / Shadows / GPU Shadows</b> (3D tab → Lighting)
        are experimental and perf-heavy (⚡-badged) — they reset off every time you load a world.
      </p>
    </div>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#61584f",
  letterSpacing: "0.08em", textTransform: "uppercase",
  marginTop: 14, marginBottom: 2,
};

export default function HelpModal({ onClose, onStartTour }: { onClose: () => void; onStartTour?: () => void }) {
  const [tab, setTab] = useState<"shortcuts" | "tools" | "textures">("shortcuts");

  return (
    <Modal onClose={onClose} zIndex={1000} label="Help">
      <div
        style={glassPanel({
          padding: "18px 24px 20px", width: 540, maxHeight: "88vh",
          overflowY: "auto", color: "#ebe9e7", display: "flex", flexDirection: "column",
        })}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            {([["shortcuts", "Shortcuts", false], ["tools", "Sculpt / 3D / Gradient", false], ["textures", "Texture Packs", true]] as const).map(([id, label, wip]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  ...glassTab(tab === id),
                  color: tab === id ? EDEN_TEAL_READABLE : "#61584f",
                  fontSize: 13, fontWeight: tab === id ? 600 : 400,
                  padding: "4px 10px", borderRadius: "4px 4px 0 0",
                }}
              >
                {label}
                {wip && <span style={wipBadge({ marginLeft: 4 })}>WIP</span>}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onStartTour && (
              <button
                onClick={() => { onStartTour(); onClose(); }}
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)",
                  color: EDEN_TEAL_READABLE, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  padding: "4px 10px", borderRadius: 4, whiteSpace: "nowrap",
                }}
                title="Replay the guided tour of the app's main surfaces"
              >Take the guided tour</button>
            )}
            <button
              onClick={onClose}
              onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
              onMouseLeave={e => (e.currentTarget.style.color = "#61584f")}
              style={{
                background: "none", border: "none", color: "#61584f",
                fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px", transition: "color .1s",
              }}
              title="Close"
            >×</button>
          </div>
        </div>

        {tab === "shortcuts" ? (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                <Section title="Navigation" />
                <Row keys={<>Scroll</>}                                      action="Zoom in / out (toward cursor)" />
                <Row keys={<><Key>{MOD}+</Key> / <Key>{MOD}−</Key></>} action="Zoom in / out (viewport centre)" />
                <Row keys={<><Key>{MOD}</Key><Key>0</Key> / <Key>Home</Key></>}  action="Fit map to window" />
                <Row keys={<><Key>{MOD}</Key><Key>{SHIFT}</Key><Key>0</Key></>}       action="Zoom to selection" />
                <Row keys={<>Middle drag</>}                                  action="Pan" />

                <Section title="Tools" />
                <Row keys={<><Key>S</Key></>}                                action="Select" />
                <Row keys={<><Key>Space</Key></>}                            action="Hold to pan — releases back to the armed tool" />
                <Row keys={<><Key>P</Key></>}                                action="Pen" />
                <Row keys={<><Key>B</Key></>}                                action="Brush" />
                <Row keys={<><Key>L</Key></>}                                action="Line" />
                <Row keys={<><Key>R</Key></>}                                action="Rect" />
                <Row keys={<><Key>E</Key></>}                                action="Ellipse" />
                <Row keys={<><Key>G</Key></>}                                action="Polygon — click vertices, click the first again (or double-click) to close" />
                <Row keys={<><Key>F</Key></>}                                action="Fill bucket" />
                <Row keys={<><Key>I</Key></>}                                action="Eyedropper — pick the block under the cursor" />
                <Row keys={<><Key>W</Key></>}                                action="Magic Wand — flood-select matching surface blocks (type+colour toggle in toolbar)" />
                <Row keys={<><Key>K</Key></>}                                action="Lasso — drag a freeform selection shape; edits, paste, gradient, extrude, trees, previews all follow the traced footprint (sculpt clip and prefab save still use the bounding box)" />
                <Row keys={<><Key>J</Key></>}                                action="Polygon Select — click vertices to build a selection shape" />

                <Section title="Sculpt" />
                <Row keys={<><Key>[</Key> / <Key>]</Key></>}                 action="Brush radius down / up (while a sculpt tool is armed)" />
                <Row keys={<><Key>{SHIFT}</Key><Key>[</Key> / <Key>{SHIFT}</Key><Key>]</Key></>} action="Strength down / up" />
                <Row keys={<>Hold <Key>Ctrl</Key></>}         action="Invert — swaps Raise ↔ Lower for the stroke" />
                <Row keys={<>Hold <Key>{SHIFT}</Key></>}                            action="Temporary Smooth — overrides the armed tool while held (any sculpt tool except Grab)" />

                <Section title="Blocks" />
                <Row keys={<><Key>1</Key>–<Key>5</Key></>}                   action="Pinned hotbar slots — also works in the 3D pane's Build mode" />
                <Row keys={<><Key>6</Key>–<Key>0</Key></>}                   action="Recently-used hotbar slots — also works in the 3D pane's Build mode" />

                <Section title="Editing" />
                <Row keys={<><Key>{MOD}</Key><Key>Z</Key></>}                   action="Undo" />
                <Row keys={<><Key>{MOD}</Key><Key>{SHIFT}</Key><Key>Z</Key> / <Key>{MOD}</Key><Key>Y</Key></>} action="Redo" />
                <Row keys={<><Key>{MOD}</Key><Key>C</Key></>}                   action="Copy selection" />
                <Row keys={<><Key>{MOD}</Key><Key>V</Key></>}                   action="Arm paste" />
                <Row keys={<><Key>{MOD}</Key><Key>A</Key></>}                   action="Select whole world" />
                <Row keys={<><Key>{MOD}</Key><Key>D</Key></>}                   action="Deselect" />
                <Row keys={<><Key>Delete</Key> / <Key>Backspace</Key></>}     action="Fill the selection with air (Select tool only)" />
                <Row keys={<>Arrows</>}                                       action={`Nudge selection (Select tool only; ${SHIFT} = 10 blocks)`} />
                <Row keys={<>Drag inside selection</>}                         action={`Move it (hold ${SHIFT} to lock to one axis)`} />

                <Section title="Paste mode" />
                <Row keys={<>Click</>}                                        action="Lock paste position (ghost turns amber)" />
                <Row keys={<>Click again / Confirm</>}                        action="Stamp paste" />
                <Row keys={<><Key>.</Key></>}                                 action="Repeat paste one step in same direction" />
                <Row keys={<><Key>PgUp</Key> / <Key>PgDn</Key></>}            action={`Raise / lower paste Z offset (${SHIFT} = ±5)`} />
                <Row keys={<><Key>Esc</Key></>}                               action="Unlock position → exit paste mode" />

                <Section title="3D pane" />
                <Row keys={<><Key>Z</Key></>}                                action="Cycle camera: orbit → mouselook → fly" />
                <Row keys={<>WASD / Space / Ctrl</>}                          action="Move while walking (Shift to boost, wheel for speed)" />
                <Row keys={<>Left-click</>}                                   action="Build mode: break the block you're aiming at" />
                <Row keys={<>Right-click</>}                                  action="Build mode: place the build block against that face" />
                <Row keys={<>Hold left</>}                                    action="Sculpt mode: sculpt terrain under the cursor/crosshair (orbit's left-drag rotate is disabled while armed; drag-to-look is unavailable in Fly mode — use Look mode or WASD instead)" />

                <Section title="File" />
                <Row keys={<><Key>{MOD}</Key><Key>N</Key></>}                   action="New world" />
                <Row keys={<><Key>{MOD}</Key><Key>O</Key></>}                   action="Open world" />
                <Row keys={<><Key>{MOD}</Key><Key>S</Key></>}                   action="Save" />
                <Row keys={<><Key>{MOD}</Key><Key>{SHIFT}</Key><Key>S</Key></>}      action="Save As…" />
                <Row keys={<><Key>{MOD}</Key><Key>W</Key></>}                   action="Close world" />
                <Row keys={<><Key>{MOD}</Key><Key>,</Key></>}                   action="Settings" />

                <Section title="General" />
                <Row keys={<><Key>Esc</Key></>}                               action="Step back: context menu → paste lock → tool → selection" />
                <Row keys={<><Key>?</Key></>}                                 action="Toggle this panel" />
              </tbody>
            </table>

            <div style={{
              marginTop: 14, paddingTop: 12,
              borderTop: "1px solid #312c28",
              fontSize: 11, color: "#61584f", textAlign: "center",
            }}>
              <Key>Esc</Key> or click outside to close
            </div>
          </>
        ) : tab === "tools" ? (
          <ToolsHelp />
        ) : (
          <TexturePackHelp />
        )}
      </div>
    </Modal>
  );
}
