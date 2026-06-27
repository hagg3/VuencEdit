import {
  BLOCK_DEFS, PAINT_COLORS, resolveColor,
  RAMP_FAMILIES, RAMP_DIRS, WEDGE_FAMILIES, WEDGE_DIRS,
  rampFamilyBase, wedgeFamilyBase, rampDirIndex, blockDisplayName,
  doorFamilyBase, portalFamilyBase, DOOR_PORTAL_DIRS,
  EXPANSION_BLOCKS, isExpansionBlock, PARTIAL_WATER, PARTIAL_LAVA, SPECIAL_BLOCKS,
} from "./blockDefs";
import { tintedSwatch, type AtlasData } from "./texturePack";

interface Props {
  mode: "fill" | "filter";
  /** Active block type. null in filter mode = "any block". */
  blockType: number | null;
  /** Active paint. null in filter mode = "any paint". 0 = no paint. */
  paint: number | null;
  onBlockTypeChange: (bt: number | null) => void;
  onPaintChange: (p: number | null) => void;
  // fill-mode extras
  onFill?: () => void;
  selectionExists?: boolean;
  texturePack?: AtlasData | null;
}

export default function BlockPaintPicker({
  mode, blockType, paint, onBlockTypeChange, onPaintChange, onFill, selectionExists, texturePack = null,
}: Props) {
  const isFill = mode === "fill";
  const bt = blockType;

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, ...(isFill ? {} : { overflowX: "auto" }) }}>

      {/* ── Block column ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, ...(isFill ? {} : { flexShrink: 0 }) }}>
        <span style={{ color: "#64748b", fontSize: 11 }}>Block</span>

        {/* Air (fill) / Any (filter) */}
        <div
          title={isFill ? "Air — erase blocks in the selection" : "Any block (no type filter)"}
          onClick={() => onBlockTypeChange(isFill ? 0 : null)}
          style={{
            fontSize: 10, textAlign: "center", cursor: "pointer",
            padding: "1px 0", borderRadius: 2, userSelect: "none",
            border: (isFill ? bt === 0 : bt === null) ? "1px solid #3b82f6" : "1px solid #334155",
            background: (isFill ? bt === 0 : bt === null)
              ? "rgba(59,130,246,0.25)"
              : isFill ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.04)",
            color: (isFill ? bt === 0 : bt === null) ? "#93c5fd" : "#475569",
          }}
        >{isFill ? "Air" : "Any"}</div>

        {/* 7×5 main block grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 18px)", gap: 2 }}>
          {BLOCK_DEFS.map((b) => {
            const isRamp = rampFamilyBase(b.type) !== null;
            const selected = isFill
              ? (bt === b.type ||
                 (bt !== null && rampFamilyBase(bt) !== null && rampFamilyBase(bt) === rampFamilyBase(b.type)) ||
                 (bt !== null && wedgeFamilyBase(bt) !== null && wedgeFamilyBase(bt) === wedgeFamilyBase(b.type)) ||
                 (bt !== null && doorFamilyBase(bt) !== null && b.type === 66) ||
                 (bt !== null && portalFamilyBase(bt) !== null && b.type === 75) ||
                 (bt !== null && isExpansionBlock(bt) && b.type === 82))
              : bt !== null && (bt === b.type ||
                 (rampFamilyBase(bt) !== null && rampFamilyBase(bt) === rampFamilyBase(b.type)) ||
                 (doorFamilyBase(bt) !== null && b.type === 66) ||
                 (portalFamilyBase(bt) !== null && b.type === 75) ||
                 (isExpansionBlock(bt) && b.type === 82));
            const bg = `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`;
            const texUrl = texturePack ? tintedSwatch(b.type, paint ?? 0, texturePack) : null;
            return (
              <div
                key={b.type}
                title={`${b.name} (type ${b.type})`}
                onClick={() => onBlockTypeChange(b.type)}
                style={{
                  width: 18, height: 18, position: "relative",
                  background: texUrl ? `url(${texUrl}) center/cover` : (isRamp ? "rgba(255,255,255,0.04)" : bg),
                  borderRadius: 2, cursor: "pointer",
                  boxSizing: "border-box",
                  border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                  outline: selected ? "1px solid #3b82f6" : "none",
                  outlineOffset: 1, overflow: "hidden",
                  imageRendering: texUrl ? "pixelated" : undefined,
                }}
              >
                {!texUrl && isRamp && (
                  <div style={{
                    position: "absolute", inset: 0,
                    background: bg,
                    clipPath: "polygon(0% 100%, 100% 100%, 100% 0%)",
                  }} />
                )}
                {isFill && (
                  <span style={{
                    position: "absolute", bottom: 0, left: 1,
                    fontSize: 7, fontWeight: 700, lineHeight: 1,
                    color: "rgba(255,255,255,0.65)", textShadow: "0 0 2px rgba(0,0,0,1)",
                    pointerEvents: "none", userSelect: "none",
                  }}>{b.name[0]?.toUpperCase()}</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Wedge family row (fill mode only) */}
        {isFill && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 18px)", gap: 2, marginTop: 2 }}>
            {WEDGE_FAMILIES.map((wf) => {
              const selected = bt !== null && wedgeFamilyBase(bt) === wf.base;
              const wfBg = `rgb(${wf.color[0]},${wf.color[1]},${wf.color[2]})`;
              return (
                <div
                  key={wf.base}
                  title={`${wf.name} (type ${wf.base})`}
                  onClick={() => onBlockTypeChange(wf.base + rampDirIndex(bt ?? 0))}
                  style={{
                    width: 18, height: 18, position: "relative",
                    background: "rgba(255,255,255,0.04)",
                    borderRadius: 2, cursor: "pointer",
                    boxSizing: "border-box",
                    border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                    outline: selected ? "1px solid #3b82f6" : "none",
                    outlineOffset: 1, overflow: "hidden",
                  }}
                >
                  <div style={{
                    position: "absolute", inset: 0,
                    background: wfBg,
                    clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
                  }} />
                </div>
              );
            })}
          </div>
        )}

        {/* Ramp orientation selector */}
        {bt !== null && rampFamilyBase(bt) !== null && (() => {
          const base = rampFamilyBase(bt)!;
          const family = RAMP_FAMILIES.find((f) => f.base === base);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
              <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Dir</span>
              {RAMP_DIRS.map((dir, i) => {
                const active = rampDirIndex(bt) === i;
                return (
                  <button key={dir} onClick={() => onBlockTypeChange(base + i)} style={{
                    width: 22, padding: "1px 0", fontSize: 10, cursor: "pointer",
                    background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                    color: active ? "#93c5fd" : "#64748b", borderRadius: 3,
                  }} title={`${family?.name} facing ${["South","West","North","East"][i]}`}>{dir}</button>
                );
              })}
            </div>
          );
        })()}

        {/* Wedge orientation selector (fill mode only) */}
        {isFill && bt !== null && wedgeFamilyBase(bt) !== null && (() => {
          const base = wedgeFamilyBase(bt)!;
          const family = WEDGE_FAMILIES.find((f) => f.base === base);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
              <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Apex</span>
              {WEDGE_DIRS.map((dir, i) => {
                const active = rampDirIndex(bt) === i;
                return (
                  <button key={dir} onClick={() => onBlockTypeChange(base + i)} style={{
                    width: 26, padding: "1px 0", fontSize: 10, cursor: "pointer",
                    background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                    color: active ? "#93c5fd" : "#64748b", borderRadius: 3,
                  }} title={`${family?.name} apex at ${["SE","SW","NW","NE"][i]}`}>{dir}</button>
                );
              })}
            </div>
          );
        })()}

        {/* Door orientation selector */}
        {bt !== null && doorFamilyBase(bt) !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
            <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Dir</span>
            {DOOR_PORTAL_DIRS.map((dir, i) => {
              const active = bt - 66 === i;
              return (
                <button key={dir} onClick={() => onBlockTypeChange(66 + i)} style={{
                  width: 22, padding: "1px 0", fontSize: 10, cursor: "pointer",
                  background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                  color: active ? "#93c5fd" : "#64748b", borderRadius: 3,
                }} title={`Door facing ${["South","West","North","East"][i]}`}>{dir}</button>
              );
            })}
          </div>
        )}

        {/* Portal orientation selector */}
        {bt !== null && portalFamilyBase(bt) !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 1 }}>
            <span style={{ color: "#64748b", fontSize: 9, minWidth: 20 }}>Dir</span>
            {DOOR_PORTAL_DIRS.map((dir, i) => {
              const active = bt - 75 === i;
              return (
                <button key={dir} onClick={() => onBlockTypeChange(75 + i)} style={{
                  width: 22, padding: "1px 0", fontSize: 10, cursor: "pointer",
                  background: active ? "rgba(59,130,246,0.35)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                  color: active ? "#93c5fd" : "#64748b", borderRadius: 3,
                }} title={`Portal facing ${["South","West","North","East"][i]}`}>{dir}</button>
              );
            })}
          </div>
        )}

        {/* Expansion sub-type dropdown */}
        {bt !== null && isExpansionBlock(bt) && (
          <div style={{ marginTop: 2 }}>
            <select
              value={bt}
              onChange={e => onBlockTypeChange(Number(e.target.value))}
              style={{
                background: "#0d1829", border: "1px solid #334155", color: "#e2e8f0",
                fontSize: 10, borderRadius: 3, padding: "1px 3px", width: "100%", cursor: "pointer",
              }}
            >
              {EXPANSION_BLOCKS.map(eb => (
                <option key={eb.type} value={eb.type}>{eb.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Partial water/lava row */}
        <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
          {[...PARTIAL_WATER, ...PARTIAL_LAVA].map(b => {
            const isWater = b.type <= 61;
            const baseColor = isWater ? "70,135,210" : "255,69,0";
            const selected = bt === b.type;
            return (
              <div key={b.type} title={b.name} onClick={() => onBlockTypeChange(b.type)}
                style={{
                  width: 18, height: 18, position: "relative", overflow: "hidden",
                  borderRadius: 2, cursor: "pointer", boxSizing: "border-box",
                  background: `rgba(${baseColor},0.15)`,
                  border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                  outline: selected ? "1px solid #3b82f6" : "none", outlineOffset: 1,
                }}
              >
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0,
                  height: `${b.fill * 100}%`,
                  background: `rgb(${baseColor})`,
                }} />
              </div>
            );
          })}
        </div>

        {/* Special blocks row */}
        <div style={{ display: "flex", gap: 2, marginTop: 1 }}>
          {SPECIAL_BLOCKS.map(b => {
            const selected = bt === b.type;
            return (
              <div key={b.type} title={`${b.name} (type ${b.type})`} onClick={() => onBlockTypeChange(b.type)}
                style={{
                  width: 18, height: 18, borderRadius: 2, cursor: "pointer", boxSizing: "border-box",
                  background: `rgb(${b.color[0]},${b.color[1]},${b.color[2]})`,
                  border: selected ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                  outline: selected ? "1px solid #3b82f6" : "none", outlineOffset: 1,
                }}
              />
            );
          })}
        </div>
      </div>

      <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch", ...(isFill ? {} : { flexShrink: 0 }) }} />

      {/* ── Paint column ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, ...(isFill ? {} : { flexShrink: 0 }) }}>
        <span style={{ color: "#64748b", fontSize: 11 }}>Paint</span>
        <div style={{ display: "flex", gap: 3 }}>
          {/* "Any paint" toggle (filter mode only) */}
          {!isFill && (
            <div
              title="Any paint (no paint filter)"
              onClick={() => onPaintChange(null)}
              style={{
                width: 18, height: 18, flexShrink: 0,
                borderRadius: 2, cursor: "pointer", boxSizing: "border-box",
                border: paint === null ? "2px solid #fff" : "2px solid #334155",
                outline: paint === null ? "1px solid #3b82f6" : "none", outlineOffset: 1,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: paint === null ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.04)",
                color: paint === null ? "#93c5fd" : "#475569",
                fontSize: 9, lineHeight: 1, userSelect: "none",
              }}
            >Any</div>
          )}
          {/* No-paint swatch */}
          <div
            title={isFill ? "No paint (use block default color)" : "No paint (unpainted blocks only)"}
            onClick={() => onPaintChange(0)}
            style={{
              width: 18, height: 18, flexShrink: 0,
              background: "transparent", borderRadius: 2, cursor: "pointer", boxSizing: "border-box",
              border: paint === 0 ? "2px solid #fff" : "2px solid #334155",
              outline: paint === 0 ? "1px solid #3b82f6" : "none", outlineOffset: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#475569", fontSize: 11, lineHeight: 1,
            }}
          >✕</div>
          {/* 9-per-row paint grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 18px)", gap: 2 }}>
            {PAINT_COLORS.map(([r, g, b], i) => {
              const pIdx = i + 1;
              const paintTexUrl = texturePack && bt !== null ? tintedSwatch(bt, pIdx, texturePack) : null;
              return (
                <div
                  key={i} title={`Paint color ${i + 1}`}
                  onClick={() => onPaintChange(pIdx)}
                  style={{
                    width: 18, height: 18,
                    background: paintTexUrl ? `url(${paintTexUrl}) center/cover` : `rgb(${r},${g},${b})`,
                    borderRadius: 2, cursor: "pointer", boxSizing: "border-box",
                    border: paint === pIdx ? "2px solid #fff" : "2px solid rgba(255,255,255,0.08)",
                    outline: paint === pIdx ? "1px solid #3b82f6" : "none", outlineOffset: 1,
                    imageRendering: paintTexUrl ? "pixelated" : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Fill-mode extras: preview swatch + fill button + block name ── */}
      {isFill && (
        <>
          <div style={{ width: 1, background: "#1e293b", alignSelf: "stretch" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end", alignSelf: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                title="Preview: selected block + paint"
                style={(() => {
                  const previewTex = texturePack && bt !== null ? tintedSwatch(bt, paint ?? 0, texturePack) : null;
                  const [r, g, b] = resolveColor(bt ?? 0, paint ?? 0);
                  return {
                    width: 22, height: 22, borderRadius: 3, flexShrink: 0,
                    background: previewTex ? `url(${previewTex}) center/cover` : `rgb(${r},${g},${b})`,
                    border: "1px solid #475569",
                    imageRendering: previewTex ? "pixelated" as const : undefined,
                  };
                })()}
              />
              {selectionExists && (
                <button
                  onClick={onFill}
                  style={{
                    background: "rgba(0,0,0,0.6)", border: "1px solid #22c55e",
                    color: "#86efac", padding: "2px 10px", borderRadius: 6,
                    cursor: "pointer", fontSize: 12, lineHeight: "20px", whiteSpace: "nowrap",
                  }}
                  title="Fill every block in the selection with the chosen type and paint"
                >Fill Selection</button>
              )}
            </div>
            <div style={{ color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>
              {blockDisplayName(bt ?? 0)}{(paint ?? 0) > 0 ? <span style={{ color: "#7dd3fc" }}> #{paint}</span> : ""}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
