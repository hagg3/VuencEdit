import React, { useState } from "react";

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
      color: "#cbd5e1",
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
      <td style={{ padding: "5px 0", color: "#94a3b8", fontSize: 13, verticalAlign: "middle" }}>
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
        color: "#475569", letterSpacing: "0.08em",
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
      color: "#93c5fd",
      background: "rgba(59,130,246,0.08)",
      border: "1px solid rgba(59,130,246,0.2)",
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
    <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6 }}>

      {/* Format */}
      <div style={sectionHead}>Format</div>
      <p style={{ margin: "4px 0 10px" }}>
        A texture pack is a <b style={{ color: "#e2e8f0" }}>.zip</b> file containing PNG images named
        after the tile names below. Any size is accepted — tiles are resized to{" "}
        <b style={{ color: "#e2e8f0" }}>32×32</b> internally (nearest-neighbour). Partial packs are
        fine: any tile not present falls back to the flat block colour.
      </p>

      {/* Loading */}
      <div style={sectionHead}>Loading</div>
      <p style={{ margin: "4px 0 10px" }}>
        <b style={{ color: "#e2e8f0" }}>View tab → Load Texture Pack…</b> — or set a default path
        in <b style={{ color: "#e2e8f0" }}>Settings</b> so it loads automatically on startup.
        Textures appear in the 3D fly-through, 3D selection preview, and block-picker swatches.
      </p>

      {/* Tinting */}
      <div style={sectionHead}>Colour tinting</div>
      <p style={{ margin: "4px 0 10px" }}>
        Tiles are automatically converted to greyscale when the pack loads. At render time the
        greyscale value is multiplied by the block's colour (unpainted = its natural colour from
        the game; painted = the paint colour). This means you can author tiles in full colour —
        the engine extracts brightness and applies the correct tint automatically. The same
        stone texture will look grey unpainted and take on any paint colour when painted.
      </p>

      {/* Tile names */}
      <div style={sectionHead}>Tile names</div>
      {TILE_GROUPS.map(g => (
        <div key={g.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 3 }}>
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
              <td style={{ padding: "3px 16px 3px 0", color: "#e2e8f0", whiteSpace: "nowrap", verticalAlign: "top" }}>{block}</td>
              <td style={{ padding: "3px 0", color: "#64748b", fontSize: 11 }}>{faces}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "#475569",
  letterSpacing: "0.08em", textTransform: "uppercase",
  marginTop: 14, marginBottom: 2,
};

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"shortcuts" | "textures">("shortcuts");

  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 10,
          padding: "18px 24px 20px",
          width: 480,
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 24px 48px rgba(0,0,0,0.7)",
          color: "#e2e8f0",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={e => e.stopPropagation()}
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
                  background: tab === id ? "rgba(59,130,246,0.18)" : "none",
                  border: "none",
                  borderBottom: tab === id ? "2px solid #3b82f6" : "2px solid transparent",
                  color: tab === id ? "#93c5fd" : "#475569",
                  fontSize: 13, fontWeight: tab === id ? 600 : 400,
                  padding: "4px 10px", cursor: "pointer", borderRadius: "4px 4px 0 0",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", color: "#475569",
              fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px",
            }}
            title="Close"
          >×</button>
        </div>

        {tab === "shortcuts" ? (
          <>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                <Section title="Navigation" />
                <Row keys={<>Scroll</>}                                      action="Zoom in / out" />
                <Row keys={<><Key>Home</Key></>}                             action="Fit map to window" />
                <Row keys={<>Middle drag</>}                                  action="Pan" />

                <Section title="Tools" />
                <Row keys={<><Key>P</Key></>}                                action="Pen" />
                <Row keys={<><Key>B</Key></>}                                action="Brush" />
                <Row keys={<><Key>R</Key></>}                                action="Rect" />
                <Row keys={<><Key>E</Key></>}                                action="Ellipse" />
                <Row keys={<><Key>F</Key></>}                                action="Fill bucket" />
                <Row keys={<><Key>W</Key></>}                                action="Magic Wand — flood-select matching surface blocks (type+colour toggle in toolbar)" />
                <Row keys={<><Key>1</Key>–<Key>5</Key></>}                   action="Brush size (1 / 3 / 5 / 7 / 9)" />

                <Section title="Editing" />
                <Row keys={<><Key>⌘</Key><Key>Z</Key></>}                   action="Undo" />
                <Row keys={<><Key>⌘</Key><Key>⇧</Key><Key>Z</Key> / <Key>⌘</Key><Key>Y</Key></>} action="Redo" />

                <Section title="Paste mode" />
                <Row keys={<>Click</>}                                        action="Lock paste position" />
                <Row keys={<>Click again / Confirm</>}                        action="Stamp paste" />
                <Row keys={<><Key>.</Key></>}                                 action="Repeat paste one step in same direction" />
                <Row keys={<><Key>Esc</Key></>}                               action="Unlock position → exit paste mode" />

                <Section title="General" />
                <Row keys={<><Key>Esc</Key></>}                               action="Exit current tool / clear selection" />
                <Row keys={<><Key>?</Key></>}                                 action="Toggle this panel" />
              </tbody>
            </table>

            <div style={{
              marginTop: 14, paddingTop: 12,
              borderTop: "1px solid #1e293b",
              fontSize: 11, color: "#475569", textAlign: "center",
            }}>
              <Key>Esc</Key> or click outside to close
            </div>
          </>
        ) : (
          <TexturePackHelp />
        )}
      </div>
    </div>
  );
}
