import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

export const SETTINGS_KEY = "eden_settings";

export interface AppSettings {
  defaultQuadView: boolean;
  default3dPane: boolean;
  defaultSaveCompressed: boolean;
  templatePath: string | null;
  texturePackPath: string | null;
}

const DEFAULTS: AppSettings = {
  defaultQuadView: false,
  default3dPane: false,
  defaultSaveCompressed: false,
  templatePath: null,
  texturePackPath: null,
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

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 1000,
};

const modal: React.CSSProperties = {
  background: "#1a1f2e", border: "1px solid #2d3448",
  borderRadius: 12, padding: "28px 32px", width: 480,
  boxShadow: "0 16px 48px rgba(0,0,0,0.6)", color: "#e2e8f0",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
  color: "#475569", textTransform: "uppercase", marginBottom: 12,
};

const row: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "10px 0", borderBottom: "1px solid #1e293b",
};

const labelCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const labelText: React.CSSProperties = { fontSize: 14, color: "#e2e8f0" };
const labelSub: React.CSSProperties = { fontSize: 12, color: "#64748b" };

const expBadge: React.CSSProperties = {
  display: "inline-block", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
  color: "#f59e0b", border: "1px solid #92400e", borderRadius: 4,
  padding: "1px 5px", marginLeft: 7, verticalAlign: "middle",
  textTransform: "uppercase", lineHeight: "14px",
};

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
        background: value ? "#3b82f6" : "#334155", position: "relative", flexShrink: 0,
        transition: "background 0.15s",
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: value ? 21 : 3,
        width: 16, height: 16, borderRadius: "50%",
        background: "#fff", transition: "left 0.15s",
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

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setLocal(s => ({ ...s, [key]: value }));
  }

  async function browsePath() {
    const selected = await open({ filters: [{ name: "Eden World", extensions: ["eden"] }] });
    if (selected && !Array.isArray(selected)) set("templatePath", selected);
  }

  async function browseTexturePack() {
    const selected = await open({ filters: [{ name: "Texture Pack", extensions: ["zip"] }] });
    if (selected && !Array.isArray(selected)) set("texturePackPath", selected);
  }

  function handleSave() {
    saveSettings(local);
    onSave(local);
    onClose();
  }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Settings</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#64748b", fontSize: 20, cursor: "pointer", lineHeight: 1 }}
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
          <Toggle value={local.defaultQuadView} onChange={v => set("defaultQuadView", v)} />
        </div>

        <div style={{ ...row, borderBottom: "none" }}>
          <div style={labelCol}>
            <span style={labelText}>
              Enable 3D pane by default
              <span style={expBadge}>Experimental</span>
            </span>
            <span style={labelSub}>Streams 3D geometry — can be slow on large worlds</span>
          </div>
          <Toggle value={local.default3dPane} onChange={v => set("default3dPane", v)} />
        </div>

        <div style={{ height: 20 }} />

        {/* FILES section */}
        <div style={sectionLabel}>Files</div>

        <div style={row}>
          <div style={labelCol}>
            <span style={labelText}>Save compressed by default</span>
            <span style={labelSub}>New worlds save as .zip; overridden by the loaded world's format</span>
          </div>
          <Toggle value={local.defaultSaveCompressed} onChange={v => set("defaultSaveCompressed", v)} />
        </div>

        <div style={{ ...row, borderBottom: "none", alignItems: "flex-start", paddingTop: 12 }}>
          <div style={{ ...labelCol, flex: 1, marginRight: 12 }}>
            <span style={labelText}>Eden.eden template path <span style={{ fontSize: 10, fontWeight: 600, color: "#f59e0b", background: "#292209", border: "1px solid #78350f", borderRadius: 4, padding: "1px 5px", verticalAlign: "middle" }}>experimental</span></span>
            <span style={labelSub}>Used for the template overlay feature</span>
            <div style={{
              marginTop: 8, display: "flex", gap: 8, alignItems: "center",
            }}>
              <div style={{
                flex: 1, fontSize: 12, color: local.templatePath ? "#94a3b8" : "#475569",
                background: "#0f1117", border: "1px solid #2d3448", borderRadius: 6,
                padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                direction: "rtl", textAlign: "left",
              }}>
                {local.templatePath ?? "Not set"}
              </div>
              <button
                onClick={browsePath}
                style={{
                  background: "#232a3d", border: "1px solid #2d3448", color: "#94a3b8",
                  borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", flexShrink: 0,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#2d3a52")}
                onMouseLeave={e => (e.currentTarget.style.background = "#232a3d")}
              >
                Browse…
              </button>
              {local.templatePath && (
                <button
                  onClick={() => set("templatePath", null)}
                  style={{
                    background: "none", border: "none", color: "#475569",
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
                flex: 1, fontSize: 12, color: local.texturePackPath ? "#94a3b8" : "#475569",
                background: "#0f1117", border: "1px solid #2d3448", borderRadius: 6,
                padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                direction: "rtl", textAlign: "left",
              }}>
                {local.texturePackPath ?? "Not set"}
              </div>
              <button
                onClick={browseTexturePack}
                style={{
                  background: "#232a3d", border: "1px solid #2d3448", color: "#94a3b8",
                  borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", flexShrink: 0,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#2d3a52")}
                onMouseLeave={e => (e.currentTarget.style.background = "#232a3d")}
              >
                Browse…
              </button>
              {local.texturePackPath && (
                <button
                  onClick={() => set("texturePackPath", null)}
                  style={{
                    background: "none", border: "none", color: "#475569",
                    fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0,
                  }}
                  title="Clear"
                >✕</button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 28 }}>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "1px solid #334155", color: "#94a3b8",
              borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer",
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "#475569")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              background: "#3b82f6", border: "none", color: "#fff",
              borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", fontWeight: 600,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "#2563eb")}
            onMouseLeave={e => (e.currentTarget.style.background = "#3b82f6")}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
