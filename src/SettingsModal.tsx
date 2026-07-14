import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, chromeButton, chromeButtonAccent, recessedWell } from "./designTokens";
import Modal from "./Modal";

export const SETTINGS_KEY = "eden_settings";

export interface AppSettings {
  defaultQuadView: boolean;
  default3dPane: boolean;
  defaultSaveCompressed: boolean;
  templatePath: string | null;
  texturePackPath: string | null;
  /** Directory the Prefab Library panel scans for .epfab files. null = app-managed default (see get_default_prefab_dir). */
  prefabDirectory: string | null;
  /** Distance fog in the 3D previews, matching the game's look. Default true (matches the game, which always fogs). */
  enableFog: boolean;
  /** 3D fly-view chunk render distance (radius in chunks). Persisted so it survives remounts. Default 5. */
  renderDistance: number;
  /** 3D fly-view fly-speed multiplier (wheel-adjustable in the pane). Persisted. Default 1. */
  flySpeed: number;
  // Night lighting / Shadows / GPU shadow map are NOT persisted: they're perf-heavy, session-only 3D
  // view modes that always start off (Ribbon-only toggles; reset on world load/close in App.tsx).
  /** Simulated sun position driving the shadow direction: 0=sunrise, 0.5=noon, 1=sunset. */
  sunT: number;
  /** Lamp light radius (blocks) for night lighting in the 3D fly-view. Default 5 (the legacy constant). */
  lampRadius: number;
}

const DEFAULTS: AppSettings = {
  defaultQuadView: false,
  default3dPane: false,
  defaultSaveCompressed: false,
  templatePath: null,
  texturePackPath: null,
  prefabDirectory: null,
  enableFog: true,
  renderDistance: 5,
  flySpeed: 1,
  sunT: 0.5,
  lampRadius: 5,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // One-time migration from old templatePath key
    if (!parsed.templatePath) {
      const legacy = localStorage.getItem("templatePath");
      if (legacy) {
        parsed.templatePath = legacy;
        localStorage.removeItem("templatePath");
      }
    }
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>) {
  const current = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...patch }));
}

const modal: React.CSSProperties = glassPanel({
  padding: "28px 32px", width: 480, borderRadius: 12, color: "#ebe9e7",
});

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
  color: "#61584f", textTransform: "uppercase", marginBottom: 12,
};

const row: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "10px 0", borderBottom: "1px solid #312c28",
};

const labelCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const labelText: React.CSSProperties = { fontSize: 14, color: "#ebe9e7" };
const labelSub: React.CSSProperties = { fontSize: 12, color: "#83786c" };

const expBadge: React.CSSProperties = {
  display: "inline-block", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
  color: "#f59e0b", border: "1px solid #92400e", borderRadius: 4,
  padding: "1px 5px", marginLeft: 7, verticalAlign: "middle",
  textTransform: "uppercase", lineHeight: "14px",
};

/** ARIA switch: a bare <button> announces as "button" with no on/off state, so screen readers
 *  couldn't tell whether a setting was enabled. `label` names it (the visible text sits in a
 *  sibling row, not inside the control). */
function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
        background: value
          ? `linear-gradient(180deg, rgba(${EDEN_TEAL},0.9) 0%, rgb(0,68,72) 100%)`
          : "linear-gradient(180deg, rgb(75,68,61) 0%, rgb(56,51,46) 100%)",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)",
        position: "relative", flexShrink: 0,
        transition: "background 0.15s",
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: value ? 21 : 3,
        width: 16, height: 16, borderRadius: "50%",
        background: "linear-gradient(180deg, rgb(243,243,243) 0%, rgb(200,200,200) 100%)",
        boxShadow: "0 1px 2px rgba(0,0,0,.4)",
        transition: "left 0.15s",
      }} />
    </button>
  );
}

interface Props {
  onClose: () => void;
  onSave: (s: AppSettings) => void;
}

export default function SettingsModal({ onClose, onSave }: Props) {
  const [local, setLocal] = useState<AppSettings>(() => loadSettings());
  const [resetHint, setResetHint] = useState(false);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setLocal(s => ({ ...s, [key]: value }));
  }

  async function browsePath() {
    const selected = await open({ filters: [{ name: "Eden World", extensions: ["eden"] }] });
    if (selected && !Array.isArray(selected)) set("templatePath", selected);
  }

  async function browseTexturePack() {
    // Same filters as the Ribbon's own picker — the loader detects zip-vs-atlas by content, and a
    // bare atlas.png is a supported pack, so a .zip-only filter hid half the valid inputs.
    const selected = await open({
      filters: [
        { name: "Texture Pack or Atlas", extensions: ["zip", "png", "jpg", "jpeg", "bmp"] },
        { name: "Zip Pack", extensions: ["zip"] },
        { name: "Atlas Image", extensions: ["png", "jpg", "jpeg", "bmp"] },
      ],
    });
    if (selected && !Array.isArray(selected)) set("texturePackPath", selected);
  }

  async function browsePrefabDir() {
    const selected = await open({ directory: true });
    if (selected && !Array.isArray(selected)) set("prefabDirectory", selected);
  }

  function handleSave() {
    saveSettings(local);
    onSave(local);
    onClose();
  }

  return (
    <Modal onClose={onClose} zIndex={1000} labelledBy="settings-title">
      <div style={modal}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <span id="settings-title" style={{ fontSize: 18, fontWeight: 700 }}>Settings</span>
          <button
            onClick={onClose}
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#83786c")}
            style={{ background: "none", border: "none", color: "#83786c", fontSize: 20, cursor: "pointer", lineHeight: 1, transition: "color .1s" }}
          >✕</button>
        </div>

        {/* GENERAL section */}
        <div style={sectionLabel}>General</div>

        <div style={row}>
          <div style={labelCol}>
            <span style={labelText}>
              Default to Quad view
              <span style={expBadge}>Experimental</span>
            </span>
            <span style={labelSub}>Opens the editor in 4-pane layout (Top + Front + Side + 3D)</span>
          </div>
          <Toggle value={local.defaultQuadView} onChange={v => set("defaultQuadView", v)} label="Default to Quad view" />
        </div>

        <div style={row}>
          <div style={labelCol}>
            <span style={labelText}>
              Enable 3D pane by default
              <span style={expBadge}>Experimental</span>
            </span>
            <span style={labelSub}>Streams 3D geometry — can be slow on large worlds</span>
          </div>
          <Toggle value={local.default3dPane} onChange={v => set("default3dPane", v)} label="Enable 3D pane by default" />
        </div>

        <div style={{ ...row, borderBottom: "none" }}>
          <div style={labelCol}>
            <span style={labelText}>Fog in 3D views</span>
            <span style={labelSub}>Fades distant terrain like the game does; turn off to inspect far terrain</span>
          </div>
          <Toggle value={local.enableFog} onChange={v => set("enableFog", v)} label="Fog in 3D views" />
        </div>

        {/* Night lighting / Shadows / GPU shadow map are perf-heavy, session-only view modes — they
            live in the Ribbon's 3D/View Lighting group (⚡ badged) and always start off, so they're
            deliberately not persisted defaults here. */}

        <div style={{ height: 20 }} />

        {/* FILES section */}
        <div style={sectionLabel}>Files</div>

        <div style={row}>
          <div style={labelCol}>
            <span style={labelText}>Save compressed by default</span>
            <span style={labelSub}>New worlds save as .zip; overridden by the loaded world's format</span>
          </div>
          <Toggle value={local.defaultSaveCompressed} onChange={v => set("defaultSaveCompressed", v)} label="Save compressed by default" />
        </div>

        <div style={{ ...row, borderBottom: "none", alignItems: "flex-start", paddingTop: 12 }}>
          <div style={{ ...labelCol, flex: 1, marginRight: 12 }}>
            <span style={labelText}>Eden.eden template path <span style={{ fontSize: 10, fontWeight: 600, color: "#f59e0b", background: "#292209", border: "1px solid #78350f", borderRadius: 4, padding: "1px 5px", verticalAlign: "middle" }}>experimental</span></span>
            <span style={labelSub}>Used for the template overlay feature</span>
            <div style={{
              marginTop: 8, display: "flex", gap: 8, alignItems: "center",
            }}>
              <div style={{
                ...recessedWell,
                flex: 1, fontSize: 12, color: local.templatePath ? "#afa69d" : "#61584f",
                borderRadius: 6,
                padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                direction: "rtl", textAlign: "left",
              }}>
                {local.templatePath ?? "Not set"}
              </div>
              <button
                onClick={browsePath}
                style={chromeButton({ padding: "5px 12px", fontSize: 12, flexShrink: 0 })}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = `inset 0 0 0 1px rgba(${EDEN_TEAL},.6), 0 .5px .5px rgba(255,255,255,.2)`)}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)")}
              >
                Browse…
              </button>
              {local.templatePath && (
                <button
                  onClick={() => set("templatePath", null)}
                  style={{
                    background: "none", border: "none", color: "#61584f",
                    fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0,
                  }}
                  title="Clear"
                >✕</button>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...row, borderBottom: "none", alignItems: "flex-start", paddingTop: 12 }}>
          <div style={{ ...labelCol, flex: 1, marginRight: 12 }}>
            <span style={labelText}>Texture pack path</span>
            <span style={labelSub}>ZIP of PNGs — adds textures to 3D views and block picker icons</span>
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                ...recessedWell,
                flex: 1, fontSize: 12, color: local.texturePackPath ? "#afa69d" : "#61584f",
                borderRadius: 6,
                padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                direction: "rtl", textAlign: "left",
              }}>
                {local.texturePackPath ?? "Not set"}
              </div>
              <button
                onClick={browseTexturePack}
                style={chromeButton({ padding: "5px 12px", fontSize: 12, flexShrink: 0 })}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = `inset 0 0 0 1px rgba(${EDEN_TEAL},.6), 0 .5px .5px rgba(255,255,255,.2)`)}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)")}
              >
                Browse…
              </button>
              {local.texturePackPath && (
                <button
                  onClick={() => set("texturePackPath", null)}
                  style={{
                    background: "none", border: "none", color: "#61584f",
                    fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0,
                  }}
                  title="Clear"
                >✕</button>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...row, borderBottom: "none", alignItems: "flex-start", paddingTop: 12 }}>
          <div style={{ ...labelCol, flex: 1, marginRight: 12 }}>
            <span style={labelText}>Prefab library folder</span>
            <span style={labelSub}>Scanned by the Prefab Library panel. Leave unset to use the app's own folder.</span>
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                ...recessedWell,
                flex: 1, fontSize: 12, color: local.prefabDirectory ? "#afa69d" : "#61584f",
                borderRadius: 6,
                padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                direction: "rtl", textAlign: "left",
              }}>
                {local.prefabDirectory ?? "App default"}
              </div>
              <button
                onClick={browsePrefabDir}
                style={chromeButton({ padding: "5px 12px", fontSize: 12, flexShrink: 0 })}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = `inset 0 0 0 1px rgba(${EDEN_TEAL},.6), 0 .5px .5px rgba(255,255,255,.2)`)}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,.5), 0 .5px .5px rgba(255,255,255,.15)")}
              >
                Browse…
              </button>
              {local.prefabDirectory && (
                <button
                  onClick={() => set("prefabDirectory", null)}
                  style={{
                    background: "none", border: "none", color: "#61584f",
                    fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0,
                  }}
                  title="Clear"
                >✕</button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 28 }}>
          {/* Restores every persisted setting — including the ones only reachable from the 3D pane's
              own sliders (render distance, fly speed, sun position, lamp radius), which had no
              Settings row and so no way back to their defaults. Staged like any other edit: it
              doesn't persist until Save. */}
          <button
            onClick={() => { setLocal({ ...DEFAULTS }); setResetHint(true); }}
            style={chromeButton({ color: "#afa69d", padding: "7px 18px", fontSize: 13 })}
          >
            Reset to defaults
          </button>
          {resetHint && (
            <span style={{ color: "#f59e0b", fontSize: 11 }}>Defaults restored — Save to apply</span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={chromeButton({ color: "#afa69d", padding: "7px 18px", fontSize: 13 })}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={chromeButtonAccent(EDEN_TEAL, `rgb(${EDEN_TEAL})`, { color: "#fff", padding: "7px 18px", fontSize: 13, fontWeight: 600 })}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
