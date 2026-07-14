import React, { useState } from "react";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, glassTab } from "./designTokens";
import Modal from "./Modal";

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

const sectionHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#61584f",
  letterSpacing: "0.08em", textTransform: "uppercase",
  marginTop: 14, marginBottom: 2,
};

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"shortcuts" | "textures">("shortcuts");

  return (
    <Modal onClose={onClose} zIndex={1000} label="Help">
      <div
        style={glassPanel({
          padding: "18px 24px 20px", width: 480, maxHeight: "88vh",
          overflowY: "auto", color: "#ebe9e7", display: "flex", flexDirection: "column",
        })}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 2 }}>
            {([["shortcuts", "Shortcuts"], ["textures", "Texture Packs ⚗"]] as const).map(([id, label]) => (
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
              </button>
            ))}
          </div>
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

        {tab === "shortcuts" ? (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                <Section title="Navigation" />
                <Row keys={<>Scroll</>}                                      action="Zoom in / out (toward cursor)" />
                <Row keys={<><Key>⌘</Key><Key>+</Key> / <Key>⌘</Key><Key>−</Key></>} action="Zoom in / out (viewport centre)" />
                <Row keys={<><Key>⌘</Key><Key>0</Key> / <Key>Home</Key></>}  action="Fit map to window" />
                <Row keys={<><Key>⌘</Key><Key>⇧</Key><Key>0</Key></>}       action="Zoom to selection" />
                <Row keys={<>Middle drag</>}                                  action="Pan" />

                <Section title="Tools" />
                <Row keys={<><Key>P</Key></>}                                action="Pen" />
                <Row keys={<><Key>B</Key></>}                                action="Brush" />
                <Row keys={<><Key>L</Key></>}                                action="Line" />
                <Row keys={<><Key>R</Key></>}                                action="Rect" />
                <Row keys={<><Key>E</Key></>}                                action="Ellipse" />
                <Row keys={<><Key>G</Key></>}                                action="Polygon / lasso — click vertices, click the first again (or double-click) to close" />
                <Row keys={<><Key>F</Key></>}                                action="Fill bucket" />
                <Row keys={<><Key>I</Key></>}                                action="Eyedropper — pick the block under the cursor" />
                <Row keys={<><Key>W</Key></>}                                action="Magic Wand — flood-select matching surface blocks (type+colour toggle in toolbar)" />

                <Section title="Blocks" />
                <Row keys={<><Key>1</Key>–<Key>5</Key></>}                   action="Pinned hotbar slots" />
                <Row keys={<><Key>6</Key>–<Key>0</Key></>}                   action="Recently-used hotbar slots" />

                <Section title="Editing" />
                <Row keys={<><Key>⌘</Key><Key>Z</Key></>}                   action="Undo" />
                <Row keys={<><Key>⌘</Key><Key>⇧</Key><Key>Z</Key> / <Key>⌘</Key><Key>Y</Key></>} action="Redo" />
                <Row keys={<><Key>⌘</Key><Key>C</Key></>}                   action="Copy selection" />
                <Row keys={<><Key>⌘</Key><Key>V</Key></>}                   action="Arm paste" />
                <Row keys={<><Key>⌘</Key><Key>A</Key></>}                   action="Select whole world" />
                <Row keys={<><Key>⌘</Key><Key>D</Key></>}                   action="Deselect" />
                <Row keys={<>Arrows</>}                                       action="Nudge selection" />
                <Row keys={<>Drag inside selection</>}                         action="Move it (hold ⇧ to lock to one axis)" />

                <Section title="Paste mode" />
                <Row keys={<>Click</>}                                        action="Lock paste position (ghost turns amber)" />
                <Row keys={<>Click again / Confirm</>}                        action="Stamp paste" />
                <Row keys={<><Key>.</Key></>}                                 action="Repeat paste one step in same direction" />
                <Row keys={<><Key>Esc</Key></>}                               action="Unlock position → exit paste mode" />

                <Section title="3D pane" />
                <Row keys={<><Key>Z</Key></>}                                action="Cycle camera: orbit → mouselook → fly" />
                <Row keys={<>WASD / Space / Ctrl</>}                          action="Move while walking (Shift to boost, wheel for speed)" />
                <Row keys={<>Left-click</>}                                   action="Build mode: break the block you're aiming at" />
                <Row keys={<>Right-click</>}                                  action="Build mode: place the build block against that face" />

                <Section title="File" />
                <Row keys={<><Key>⌘</Key><Key>S</Key></>}                   action="Save" />
                <Row keys={<><Key>⌘</Key><Key>W</Key></>}                   action="Close world" />
                <Row keys={<><Key>⌘</Key><Key>,</Key></>}                   action="Settings" />

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
        ) : (
          <TexturePackHelp />
        )}
      </div>
    </Modal>
  );
}
