/**
 * The full header readout, extracted from `WorldInfoModal` so the application menu's Properties
 * pane and the modal show the same data from the same fetch.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PAINT_COLORS } from "../blockDefs";
import { classifyWorldFormat } from "../types";

export interface WorldInfo {
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

/** Display text for the Properties pane's Format row — `classifyWorldFormat` (types.ts) owns the
 *  actual max_z/version logic; this just picks wording. */
function formatLabel(info: WorldInfo): { label: string; title: string } {
  switch (classifyWorldFormat(info)) {
    case "legacy64z":
      return { label: "Legacy 64z", title: "Legacy (64z) format — worlds up to 64 blocks tall" };
    case "newDawn256z":
      return { label: "New Dawn 256z", title: "New Dawn (256z) format — worlds up to 256 blocks tall" };
    case "newFormat256z":
      return {
        label: "NewFormat256z",
        title: `A 2026 game update's 256z variant (version ${info.version}, not the New Dawn 5/6 you'd expect) — adds 16 new block types (112–127) and stores signs differently from earlier New Dawn worlds`,
      };
  }
}

const rowStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  padding: "2px 0", gap: 12,
};

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={{ color: "#afa69d", flexShrink: 0 }}>{k}</span>
      <span style={{ color: "#ebe9e7", textAlign: "right", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

const section: React.CSSProperties = { marginBottom: 14 };
const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
  color: "#61584f", textTransform: "uppercase", marginBottom: 6,
  borderBottom: "1px solid #312c28", paddingBottom: 3,
};

/** `refreshKey` re-fetches — the menu bumps it after a rename so the pane doesn't go stale. */
export default function WorldInfoPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<WorldInfo>("get_world_info")
      .then(i => { setInfo(i); setErr(null); })
      .catch(e => setErr(String(e)));
  }, [refreshKey]);

  return (
    <div style={{ color: "#ebe9e7", fontFamily: "monospace", fontSize: 12 }}>
      {err && <div style={{ color: "#f87171", marginBottom: 12 }}>{err}</div>}
      {!info && !err && <div style={{ color: "#83786c" }}>Loading…</div>}

      {info && <>
        <div style={section}>
          <div style={sectionLabel}>Identity</div>
          <Row k="Name" v={info.name || "—"} />
          <Row k="Format" v={
            <span title={formatLabel(info).title}>{formatLabel(info).label}</span>
          } />
          <Row k="Version" v={info.version} />
          <Row k="Level seed" v={info.level_seed === 0 ? <span style={{ color: "#61584f" }}>0 (unset)</span> : info.level_seed} />
        </div>

        <div style={section}>
          <div style={sectionLabel}>Dimensions</div>
          <Row k="Size (chunks)" v={`${info.width_chunks} × ${info.height_chunks}`} />
          <Row k="Size (blocks)" v={`${info.width_chunks * 16} × ${info.height_chunks * 16}`} />
          <Row k="Height" v={`${info.max_z + 1} layers (Z 0–${info.max_z})`} />
          <Row k="Chunks saved" v={`${info.chunk_count} of ${info.width_chunks * info.height_chunks}`} />
          <Row k="Chunk origin" v={`(${info.abs_min_x}, ${info.abs_min_y})`} />
        </div>

        <div style={section}>
          <div style={sectionLabel}>Positions</div>
          {info.spawn_px != null
            ? <Row k="Home / spawn (XY)" v={`(${fmt1(info.spawn_px)}, ${fmt1(info.spawn_py!)})`} />
            : <Row k="Home / spawn" v={<span style={{ color: "#61584f" }}>not set</span>} />}
          <Row k="Home height (Z)" v={fmt1(info.home_height)} />
          <Row k="Start / last pos (XY)" v={`(${fmt1(info.pos_local_x)}, ${fmt1(info.pos_local_y)})`} />
          <Row k="Start height (Z)" v={fmt1(info.pos_height)} />
          <Row k="Heading (@28)" v={<span title="Unknown — possibly player yaw">{fmt1(info.heading)}°?</span>} />
        </div>

        <div style={section}>
          <div style={sectionLabel}>Progress</div>
          <Row k="Golden cubes" v={info.golden_cubes === 0
            ? <span style={{ color: "#61584f" }}>0</span>
            : <span style={{ color: "#fbbf24" }}>⬡ {info.golden_cubes}</span>} />
        </div>

        <div style={section}>
          <div style={sectionLabel}>Sky colors (16 altitude bands)</div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 4 }}>
            {info.sky_colors.map((idx, i) => {
              const color = paintColor(idx);
              const isDefault = idx === 14 || idx === 0;
              return (
                <div key={i} title={`Band ${i}: paint ${idx}${isDefault ? " (default)" : ""}`}
                  style={{
                    width: 20, height: 20, borderRadius: 3, background: color,
                    border: isDefault ? "1px solid #453f38" : "1px solid rgba(255,255,255,0.2)",
                    position: "relative",
                  }}>
                  <span style={{ position: "absolute", bottom: 0, right: 1, fontSize: 7, color: "rgba(0,0,0,0.5)", lineHeight: 1 }}>{i}</span>
                </div>
              );
            })}
          </div>
        </div>
      </>}
    </div>
  );
}
