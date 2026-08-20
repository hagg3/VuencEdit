/**
 * The world's identity, relocated from Home's "World" group to the top bar's right cluster —
 * which is what reclaimed ~250px of Home for real commands.
 *
 * The rename flow is ported verbatim, including the `renameCancelledRef` Escape guard: Escape
 * triggers a blur, and without the flag that blur would commit the very edit Escape cancelled.
 *
 * ⚠️ The details panel goes through `Popover`, i.e. a **portal**, not an absolutely-positioned
 * child. The ribbon root is `z-index: 100`, which is its own stacking context, so a child panel
 * could never rise above the docked sidebar (`z-index: 120`) whatever z-index it asked for — it
 * was clipped and painted underneath. Portaling to `document.body` is the fix; keep it that way.
 */
import { useRef, useState } from "react";
import { useRibbon } from "./ribbon/context";
import { Icon } from "./ribbon/icons";
import { Popover } from "./ribbon/primitives";
import {
  ACCENT, BORDER, FONT, ICON, RADIUS, SPACE, SURFACE, TEXT, TEXT_DIM, TEXT_LABEL, TOPBAR_BTN_H,
  btnBase, hexToRgbTriplet,
} from "./ribbon/tokens";
import { classifyWorldFormat } from "./types";

const RENAME_ALLOWED = /[A-Za-z0-9' ]/;

export default function WorldNamePill() {
  const { p, openAppMenu } = useRibbon();
  // Destructured up front: the lint rule that guards ref access treats any object reached through
  // a hook's return value as ref-like once one of its fields *is* a ref (`renameInputRef` here),
  // so reading `p.<field>` inline in the JSX trips it on every unrelated field too.
  const {
    world, spawnPos, playerPos, sourcePath, renamingWorld, renameInput, renameInputRef,
    setRenamingWorld, setRenameInput, onRenameBlur, onShowWorldInfo,
  } = p;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const renameCancelledRef = useRef(false);
  const [renameHint, setRenameHint] = useState(false);

  if (!world) return null;
  const w = world;
  const formatClass = classifyWorldFormat(w);
  const newDawn = formatClass !== "legacy64z"; // badge/accent only distinguish 64z vs 256z-of-either-kind
  const formatLabel = formatClass === "legacy64z" ? "Legacy 64z"
    : formatClass === "newDawn256z" ? "New Dawn 256z"
    : "NewFormat256z";
  const dawnRgb = hexToRgbTriplet(ACCENT.violet);

  return (
    <div ref={wrapRef} data-tour="world-pill" style={{ position: "relative", display: "flex", alignItems: "center", marginRight: 4 }}>
      <button
        className="rbn-btn" type="button" onClick={() => setOpen(v => !v)}
        title={`${w.name} — ${formatLabel}, ${w.width_chunks}×${w.height_chunks} chunks. Click for world details and rename.`}
        aria-haspopup="dialog" aria-expanded={open} data-active={open ? "true" : undefined}
        style={btnBase({
          display: "flex", alignItems: "center", gap: 6, height: TOPBAR_BTN_H, padding: "0 8px",
          // Regular button corners. This is a chrome control in a row of chrome controls, not a
          // pill — the 12px radius made it the only rounded object in the top bar.
          borderRadius: RADIUS.md,
          fontSize: FONT.tab, fontWeight: 600, color: TEXT, maxWidth: 240,
        })}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name || "Untitled"}</span>
        <span style={{
          fontSize: FONT.micro - 1, lineHeight: "12px", padding: "0 4px", borderRadius: RADIUS.sm, flexShrink: 0,
          color: newDawn ? "#b3a9ea" : TEXT_LABEL,
          background: newDawn ? `rgba(${dawnRgb},.16)` : "rgba(255,255,255,.06)",
          boxShadow: `inset 0 0 0 1px ${newDawn ? `rgba(${dawnRgb},.4)` : "rgba(255,255,255,.12)"}`,
        }}>
          {newDawn ? "256z" : "64z"}
        </span>
      </button>

      {open && (
        <Popover
          anchorRef={wrapRef} align="right" role="dialog" ariaLabel="World details"
          onClose={() => setOpen(false)}
          onEscape={() => {
            // Escape steps back one level: cancel an in-progress rename first, close the panel
            // only when there is nothing else to cancel. `renameCancelledRef` is what stops the
            // blur this triggers from committing the very edit Escape just cancelled.
            if (renamingWorld) {
              renameCancelledRef.current = true;
              setRenameHint(false);
              setRenamingWorld(false);
            } else setOpen(false);
          }}
          style={{ width: 268, padding: SPACE.lg + 2 }}
        >
          {/* Rename — the one editable field here. */}
          {renamingWorld ? (
            <>
              <input
                ref={renameInputRef}
                value={renameInput}
                aria-label="World name"
                title="Letters, numbers, spaces and apostrophes — max 32 characters"
                onChange={e => {
                  const raw = e.target.value;
                  const clean = raw.split("").filter(c => RENAME_ALLOWED.test(c)).join("").slice(0, 32);
                  setRenameHint(clean !== raw);
                  setRenameInput(clean);
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    renameCancelledRef.current = true; // consumed by onBlur below
                    setRenameHint(false);
                    setRenamingWorld(false);
                  }
                }}
                onBlur={() => {
                  setRenameHint(false);
                  if (renameCancelledRef.current) { renameCancelledRef.current = false; return; }
                  onRenameBlur(renameInput.trim());
                }}
                autoFocus
                style={{
                  width: "100%", background: SURFACE.well, border: "none", borderRadius: RADIUS.md,
                  boxShadow: `inset 0 0 0 1px ${ACCENT.primary}`, color: TEXT, fontSize: FONT.tab,
                  fontWeight: 700, padding: "4px 7px", outline: "none",
                }}
              />
              {renameHint && (
                <div style={{ color: ACCENT.warm, fontSize: FONT.label, marginTop: 3 }}>
                  letters, numbers, spaces and ’ only
                </div>
              )}
              <div style={{ color: TEXT_LABEL, fontSize: FONT.label, marginTop: 3 }}>Enter to save · Escape to cancel</div>
            </>
          ) : (
            <button className="rbn-btn" type="button"
              onClick={() => { setRenameInput(w.name ?? ""); setRenamingWorld(true); }}
              title="Rename this world"
              style={btnBase({
                width: "100%", display: "flex", alignItems: "center", gap: 7, padding: "5px 8px",
                fontSize: FONT.tab, fontWeight: 700, color: TEXT,
              })}>
              <Icon name="properties" size={ICON.sm} />
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name || "Untitled"}</span>
              <span style={{ fontSize: FONT.label, color: TEXT_LABEL }}>Rename</span>
            </button>
          )}

          <div style={{ height: 1, background: BORDER.hairline, margin: `${SPACE.lg}px 0` }} />

          <InfoRow k="Format" v={formatLabel} />
          <InfoRow k="Size" v={`${w.width_chunks} × ${w.height_chunks} chunks`} />
          <InfoRow k="Blocks" v={`${w.width_chunks * 16} × ${w.height_chunks * 16}`} />
          <InfoRow k="Height" v={`Z 0–${w.max_z}`} />
          <InfoRow k="Home (respawn)" v={spawnPos ? `${Math.round(spawnPos.px)}, ${Math.round(spawnPos.py)}` : "not set"} />
          <InfoRow k="Start (last pos)" v={playerPos ? `${Math.round(playerPos.px)}, ${Math.round(playerPos.py)}` : "not set"} />
          <InfoRow k="File" v={sourcePath ? sourcePath.split("/").pop()! : "never saved"} />

          <div style={{ display: "flex", gap: 5, marginTop: 9 }}>
            <button className="rbn-btn" type="button" onClick={() => { setOpen(false); openAppMenu("properties"); }}
              title="Full world header readout — seed, sky bands, golden cubes"
              style={btnBase({ flex: 1, height: TOPBAR_BTN_H, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: FONT.body, color: TEXT })}>
              <Icon name="properties" size={ICON.xs} /> Properties…
            </button>
            <button className="rbn-btn" type="button" onClick={() => { setOpen(false); onShowWorldInfo(); }}
              title="Open the World Info dialog"
              style={btnBase({ height: TOPBAR_BTN_H, padding: "0 9px", fontSize: FONT.body, color: TEXT })}>
              Dialog
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "2px 0" }}>
      <span style={{ color: TEXT_DIM }}>{k}</span>
      <span style={{ color: TEXT, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}
