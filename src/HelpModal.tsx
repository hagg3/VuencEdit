import React from "react";

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

export default function HelpModal({ onClose }: { onClose: () => void }) {
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
          minWidth: 380,
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 24px 48px rgba(0,0,0,0.7)",
          color: "#e2e8f0",
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Keyboard Shortcuts</span>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", color: "#475569",
              fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px",
            }}
            title="Close"
          >
            ×
          </button>
        </div>

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
      </div>
    </div>
  );
}
