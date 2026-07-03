import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PAINT_COLORS } from "./blockDefs";
import { EDEN_TEAL_READABLE, glassPanel } from "./designTokens";
import Modal from "./Modal";

interface WorldInfo {
  name: string;
  level_seed: number;
  pos_local_x: number; pos_local_y: number; pos_height: number;
  home_local_x: number; home_local_y: number; home_height: number;
  heading: number;
  version: number;
  sky_colors: number[];
  golden_cubes: number;
  width_chunks: number; height_chunks: number;
  max_z: number; chunk_count: number;
  abs_min_x: number; abs_min_y: number;
  spawn_px: number | null; spawn_py: number | null;
}

function paintColor(idx: number): string {
  if (idx === 0 || idx === 14) return "#a0c8ff"; // default sky blue
  if (idx < 1 || idx > 54) return "#333";
  const [r, g, b] = PAINT_COLORS[idx - 1];
  return `rgb(${r},${g},${b})`;
}

function fmt1(n: number) { return n.toFixed(1); }

const rowStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  padding: "2px 0", gap: 12,
};
const keyStyle: React.CSSProperties = { color: "#94a3b8", flexShrink: 0 };
const valStyle: React.CSSProperties = { color: "#e2e8f0", textAlign: "right", wordBreak: "break-all" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      <span style={valStyle}>{v}</span>
    </div>
  );
}

export default function WorldInfoModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<WorldInfo>("get_world_info")
      .then(setInfo)
      .catch(e => setErr(String(e)));
  }, []);

  const modal: React.CSSProperties = glassPanel({
    padding: "20px 24px", minWidth: 440, maxWidth: 540, maxHeight: "85vh",
    overflowY: "auto", color: "#e2e8f0", fontFamily: "monospace", fontSize: 12,
  });
  const heading: React.CSSProperties = {
    margin: 0, fontSize: 15, fontWeight: 700, color: EDEN_TEAL_READABLE, marginBottom: 16,
  };
  const section: React.CSSProperties = {
    marginBottom: 14,
  };
  const sectionLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    color: "#475569", textTransform: "uppercase", marginBottom: 6,
    borderBottom: "1px solid #1e293b", paddingBottom: 3,
  };
  return (
    <Modal onClose={onClose} zIndex={9000} labelledBy="worldinfo-title">
      <div style={modal}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 id="worldinfo-title" style={heading}>World Info</h2>
          <button onClick={onClose}
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#64748b")}
            style={{ background: "none", border: "none", color: "#64748b", fontSize: 18, cursor: "pointer", lineHeight: 1, transition: "color .1s" }}>×</button>
        </div>

        {err && <div style={{ color: "#f87171", marginBottom: 12 }}>{err}</div>}
        {!info && !err && <div style={{ color: "#64748b" }}>Loading…</div>}

        {info && <>
          {/* Identity */}
          <div style={section}>
            <div style={sectionLabel}>Identity</div>
            <Row k="Name" v={info.name || "—"} />
            <Row k="Format" v={info.max_z === 255 ? "New Dawn 256z" : "Legacy 64z"} />
            <Row k="Version" v={info.version} />
            <Row k="Level seed" v={info.level_seed === 0 ? <span style={{ color: "#475569" }}>0 (unset)</span> : info.level_seed} />
          </div>

          {/* Dimensions */}
          <div style={section}>
            <div style={sectionLabel}>Dimensions</div>
            <Row k="Size (chunks)" v={`${info.width_chunks} × ${info.height_chunks}`} />
            <Row k="Size (blocks)" v={`${info.width_chunks * 16} × ${info.height_chunks * 16}`} />
            <Row k="Height" v={`${info.max_z + 1} layers (Z 0–${info.max_z})`} />
            <Row k="Chunks saved" v={`${info.chunk_count} of ${info.width_chunks * info.height_chunks}`} />
            <Row k="Chunk origin" v={`(${info.abs_min_x}, ${info.abs_min_y})`} />
          </div>

          {/* Positions */}
          <div style={section}>
            <div style={sectionLabel}>Positions</div>
            {info.spawn_px != null
              ? <Row k="Spawn (XY)" v={`(${fmt1(info.spawn_px)}, ${fmt1(info.spawn_py!)})`} />
              : <Row k="Spawn" v={<span style={{ color: "#475569" }}>not set</span>} />}
            <Row k="Spawn height (Z)" v={fmt1(info.home_height)} />
            <Row k="Last pos (XY)" v={`(${fmt1(info.pos_local_x)}, ${fmt1(info.pos_local_y)})`} />
            <Row k="Last pos height (Z)" v={fmt1(info.pos_height)} />
            <Row k="Heading (@28)" v={<span title="Unknown — possibly player yaw">{fmt1(info.heading)}°?</span>} />
          </div>

          {/* Progress */}
          <div style={section}>
            <div style={sectionLabel}>Progress</div>
            <Row k="Golden cubes" v={info.golden_cubes === 0
              ? <span style={{ color: "#475569" }}>0</span>
              : <span style={{ color: "#fbbf24" }}>⬡ {info.golden_cubes}</span>} />
          </div>

          {/* Sky */}
          <div style={section}>
            <div style={sectionLabel}>Sky colors (16 altitude bands)</div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 4 }}>
              {info.sky_colors.map((idx, i) => {
                const color = paintColor(idx);
                const isDefault = idx === 14 || idx === 0;
                return (
                  <div key={i} title={`Band ${i}: paint ${idx}${isDefault ? " (default)" : ""}`}
                    style={{ width: 20, height: 20, borderRadius: 3, background: color,
                      border: isDefault ? "1px solid #1e3a5f" : "1px solid rgba(255,255,255,0.2)",
                      position: "relative" }}>
                    <span style={{ position: "absolute", bottom: 0, right: 1, fontSize: 7, color: "rgba(0,0,0,0.5)", lineHeight: 1 }}>{i}</span>
                  </div>
                );
              })}
            </div>
          </div>

        </>}
      </div>
    </Modal>
  );
}
