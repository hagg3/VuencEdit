import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { EDEN_TEAL, EDEN_TEAL_READABLE, glassPanel, glassTab, chromeButton, chromeButtonAccent, recessedWell, expBadge } from "./designTokens";
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
  /** Floating Quick Actions bar under the ribbon while a selection or clipboard exists. Default true. */
  showQuickActions: boolean;
  /** Mouse-look sensitivity multiplier in grabbed-cursor LOOK mode. Default 1 (see FlyView3D's
   *  LOOK_SENS_BASE for the underlying rad/px rate this scales). */
  lookSensitivity: number;
  /** Mouse-look sensitivity multiplier for fly-mode drag-to-look. Default 1 (see DRAG_SENS_BASE). */
  dragSensitivity: number;
  /** Flips pitch direction (mouse up = look down) in both look and drag-to-look. Default false. */
  invertY: boolean;
  /** Autosave interval in minutes. 0 disables autosave. Default 3 (the old hardcoded AUTOSAVE_MS). */
  autosaveIntervalMin: number;
  /** Auto-orient ramps/wedges/doors to the player's facing when placing in 3D build mode. Default true. */
  autoOrient3d: boolean;
  /** Shows OBJ/VMF export menu items. Both are buggy/unfinished; off by default so most users never see them. */
  enableExperimentalExport: boolean;
  /** Bumped when a default changes in a way that must be pushed onto existing installs (see loadSettings). */
  settingsVersion: number;
}

/** Current settings schema version. Bump + add a case to `migrate()` when a stored default must change. */
const SETTINGS_VERSION = 2;

const DEFAULTS: AppSettings = {
  defaultQuadView: true,
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
  showQuickActions: true,
  lookSensitivity: 1,
  dragSensitivity: 1,
  invertY: false,
  autosaveIntervalMin: 3,
  autoOrient3d: true,
  enableExperimentalExport: false,
  settingsVersion: SETTINGS_VERSION,
};

/** Push new defaults onto an install that already has a stored settings blob. A plain
 *  `{...DEFAULTS, ...parsed}` merge can't do this: `parsed` holds the *old* explicit value, which
 *  always wins. Returns true if anything changed (caller persists). Users who later turn a migrated
 *  setting back off keep their choice — the version has already advanced by then. */
function migrate(s: Record<string, unknown>): boolean {
  const from = typeof s.settingsVersion === "number" ? s.settingsVersion : 0;
  if (from >= SETTINGS_VERSION) return false;
  // v0 → v1: quad view became the default layout (beta feedback — it's how people actually work).
  if (from < 1) s.defaultQuadView = true;
  // v1 → v2: added lookSensitivity/dragSensitivity/invertY/autosaveIntervalMin. No forced value
  // needed — the raised look-mode base rate lives in FlyView3D's LOOK_SENS_BASE constant, not a
  // stored setting, so existing installs get the snappier feel automatically once the `{...DEFAULTS,
  // ...parsed}` merge supplies the new fields. The version bump just marks the schema current.
  s.settingsVersion = SETTINGS_VERSION;
  return true;
}

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
    // Only migrate a blob that actually exists — a fresh install just takes DEFAULTS (already v1),
    // and writing on first read would turn every load into a localStorage write.
    if (raw && migrate(parsed)) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULTS, ...parsed }));
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
  padding: "20px 26px 18px", width: 520, maxHeight: "84vh", borderRadius: 12, color: "#ebe9e7",
  display: "flex", flexDirection: "column",
});

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
  color: "#61584f", textTransform: "uppercase", marginBottom: 8,
};

const row: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 10,
  padding: "6px 0", borderBottom: "1px solid #312c28",
};

const labelCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1 };
const labelText: React.CSSProperties = { fontSize: 13, color: "#ebe9e7" };
const labelSub: React.CSSProperties = { fontSize: 11, color: "#83786c" };

/** Checkbox, not the old pill switch: switches are a touchscreen affordance (a large drag/tap
 *  target for thumbs) and read as mobile-coded in a desktop preferences panel. `role="checkbox"`
 *  + `aria-checked` gives the same screen-reader state a switch did; `label` names it since the
 *  visible text sits in a sibling row, not inside the control. */
function Checkbox({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="checkbox"
      aria-checked={value}
      aria-label={label}
      style={{
        width: 16, height: 16, borderRadius: 4, border: "none", cursor: "pointer",
        padding: 0, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        background: value
          ? `linear-gradient(180deg, rgba(${EDEN_TEAL},0.9) 0%, rgb(0,68,72) 100%)`
          : "rgb(30,27,25)",
        boxShadow: value
          ? `inset 0 0 0 1px rgba(${EDEN_TEAL},.7)`
          : "inset 0 0 0 1px rgba(0,0,0,.5), inset 0 1px 2px rgba(0,0,0,.4)",
        transition: "background 0.1s, box-shadow 0.1s",
      }}
    >
      {value && (
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: "block" }}>
          <path d="M1.5 5 L4 7.5 L8.5 2" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** Staged sliders write straight into `local` (no live IPC to debounce, unlike the Ribbon's
 *  display/commit split) — a plain controlled input is fine here since nothing applies until Save. */
function Slider({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format?: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ ...row, flexDirection: "column", alignItems: "stretch", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={labelText}>{label}</span>
        <span style={{ ...labelSub, fontVariantNumeric: "tabular-nums" }}>{(format ?? String)(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: `rgb(${EDEN_TEAL})` }}
      />
    </div>
  );
}

interface Props {
  onClose: () => void;
  onSave: (s: AppSettings) => void;
}

type SettingsTab = "general" | "3d" | "editor" | "files";

export default function SettingsModal({ onClose, onSave }: Props) {
  const [local, setLocal] = useState<AppSettings>(() => loadSettings());
  const [resetHint, setResetHint] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");

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

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "3d", label: "3D View" },
    { id: "editor", label: "Editor" },
    { id: "files", label: "Files" },
  ];

  return (
    <Modal onClose={onClose} zIndex={1000} labelledBy="settings-title">
      <div style={modal}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span id="settings-title" style={{ fontSize: 18, fontWeight: 700 }}>Settings</span>
          <button
            onClick={onClose}
            title="Close settings" aria-label="Close settings"
            onMouseEnter={e => (e.currentTarget.style.color = EDEN_TEAL_READABLE)}
            onMouseLeave={e => (e.currentTarget.style.color = "#83786c")}
            style={{ background: "none", border: "none", color: "#83786c", fontSize: 20, cursor: "pointer", lineHeight: 1, transition: "color .1s" }}
          >✕</button>
        </div>

        {/* Tab strip */}
        <div style={{ display: "flex", gap: 2, marginBottom: 4, flexShrink: 0 }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                ...glassTab(tab === t.id),
                color: tab === t.id ? EDEN_TEAL_READABLE : "#61584f",
                fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                padding: "6px 14px", borderRadius: "4px 4px 0 0",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab body (scrolls; header/tabs/footer stay put) */}
        <div style={{ flex: 1, overflowY: "auto", paddingTop: 8, minHeight: 0 }}>
          {tab === "general" && (
            <>
              <div style={row}>
                <Checkbox value={local.defaultQuadView} onChange={v => set("defaultQuadView", v)} label="Default to Quad view" />
                <div style={labelCol}>
                  <span style={labelText}>
                    Default to Quad view
                    <span style={expBadge({ marginLeft: 7, verticalAlign: "middle" })}>exp</span>
                  </span>
                  <span style={labelSub}>Opens the editor in 4-pane layout (Top + Front + Side + 3D)</span>
                </div>
              </div>

              <div style={row}>
                <Checkbox value={local.default3dPane} onChange={v => set("default3dPane", v)} label="Enable 3D pane by default" />
                <div style={labelCol}>
                  <span style={labelText}>
                    Enable 3D pane by default
                    <span style={expBadge({ marginLeft: 7, verticalAlign: "middle" })}>exp</span>
                  </span>
                  <span style={labelSub}>Streams 3D geometry — can be slow on large worlds</span>
                </div>
              </div>

              <div style={row}>
                <Checkbox value={local.showQuickActions} onChange={v => set("showQuickActions", v)} label="Quick Actions bar" />
                <div style={labelCol}>
                  <span style={labelText}>Quick Actions bar</span>
                  <span style={labelSub}>Floating copy/fill/paste + paste Z-offset bar, shown while a selection or clipboard exists</span>
                </div>
              </div>

              <div style={{ ...row, borderBottom: "none" }}>
                <Checkbox value={local.enableExperimentalExport} onChange={v => set("enableExperimentalExport", v)} label="Experimental exports (OBJ/VMF)" />
                <div style={labelCol}>
                  <span style={labelText}>
                    Experimental exports (OBJ/VMF)
                    <span style={expBadge({ marginLeft: 7, verticalAlign: "middle" })}>exp</span>
                  </span>
                  <span style={labelSub}>Shows File → Export OBJ… and Export VMF (Hammer)… — both are still buggy</span>
                </div>
              </div>
            </>
          )}

          {tab === "3d" && (
            <>
              <Slider
                label="Look sensitivity" value={local.lookSensitivity} min={0.25} max={4} step={0.05}
                format={v => `${v.toFixed(2)}×`}
                onChange={v => set("lookSensitivity", v)}
              />
              <div style={{ ...labelSub, marginTop: -2, marginBottom: 10 }}>
                Mouselook speed in grabbed-cursor LOOK mode (Z from orbit)
              </div>

              <Slider
                label="Fly-drag sensitivity" value={local.dragSensitivity} min={0.25} max={4} step={0.05}
                format={v => `${v.toFixed(2)}×`}
                onChange={v => set("dragSensitivity", v)}
              />
              <div style={{ ...labelSub, marginTop: -2, marginBottom: 10 }}>
                Look speed while drag-looking (left-drag) in FLY mode
              </div>

              <div style={row}>
                <Checkbox value={local.invertY} onChange={v => set("invertY", v)} label="Invert Y axis" />
                <div style={labelCol}>
                  <span style={labelText}>Invert Y axis</span>
                  <span style={labelSub}>Flips pitch: mouse up looks down</span>
                </div>
              </div>

              <div style={row}>
                <Checkbox value={local.enableFog} onChange={v => set("enableFog", v)} label="Fog in 3D views" />
                <div style={labelCol}>
                  <span style={labelText}>Fog in 3D views</span>
                  <span style={labelSub}>Fades distant terrain like the game does; turn off to inspect far terrain</span>
                </div>
              </div>

              {/* Night lighting / Shadows / GPU shadow map are perf-heavy, session-only view modes —
                  they live in the Ribbon's 3D/View Lighting group (⚡ badged) and always start off,
                  so they're deliberately not persisted defaults here. */}

              <div style={{ height: 6 }} />
              <div style={sectionLabel}>3D pane sliders</div>

              <Slider
                label="Render distance" value={local.renderDistance} min={2} max={32} step={1}
                format={v => `${Math.round(v)} chunks`}
                onChange={v => set("renderDistance", Math.round(v))}
              />
              <div style={{ height: 8 }} />

              <Slider
                label="Fly speed" value={local.flySpeed} min={0.1} max={12} step={0.1}
                format={v => `${v.toFixed(1)}×`}
                onChange={v => set("flySpeed", v)}
              />
              <div style={{ height: 8 }} />

              <Slider
                label="Sun angle" value={local.sunT} min={0} max={1} step={0.01}
                format={v => (v < 0.03 ? "sunrise" : v > 0.97 ? "sunset" : v === 0.5 ? "noon" : v.toFixed(2))}
                onChange={v => set("sunT", v)}
              />
              <div style={{ height: 8 }} />

              <Slider
                label="Lamp radius" value={local.lampRadius} min={2} max={32} step={1}
                format={v => `${Math.round(v)} blocks`}
                onChange={v => set("lampRadius", Math.round(v))}
              />
              <div style={{ ...labelSub, marginTop: 4 }}>
                These four are also editable from the 3D pane / Ribbon directly — surfaced here so Reset to defaults has somewhere visible to reset them to.
              </div>
            </>
          )}

          {tab === "editor" && (
            <>
              <div style={row}>
                <Checkbox value={local.defaultSaveCompressed} onChange={v => set("defaultSaveCompressed", v)} label="Save compressed by default" />
                <div style={labelCol}>
                  <span style={labelText}>Save compressed by default</span>
                  <span style={labelSub}>New worlds save as .zip; overridden by the loaded world's format</span>
                </div>
              </div>

              <div style={{ height: 6 }} />
              <Slider
                label="Autosave interval" value={local.autosaveIntervalMin} min={0} max={15} step={1}
                format={v => (v === 0 ? "Off" : `${Math.round(v)} min`)}
                onChange={v => set("autosaveIntervalMin", Math.round(v))}
              />
              <div style={{ ...labelSub, marginTop: 4 }}>
                How often an in-progress world is snapshotted to a recovery sidecar. 0 disables autosave.
              </div>
            </>
          )}

          {tab === "files" && (
            <>
              <div style={{ ...row, alignItems: "flex-start", paddingTop: 4 }}>
                <div style={{ ...labelCol, flex: 1, marginRight: 12 }}>
                  <span style={labelText}>Eden.eden template path <span style={expBadge({ fontSize: 10, fontWeight: 600, padding: "1px 5px", verticalAlign: "middle" })}>exp</span></span>
                  <span style={labelSub}>Eden.eden is the pre-generated template bundled with the game. Point this at your copy to show its terrain faded behind the gaps in a sparse/normal world's map (View ▾ → Template Overlay), or to "Expand from Template" and bake it into a full world file.</span>
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
                        title="Clear" aria-label="Clear this path"
                      >✕</button>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ ...row, alignItems: "flex-start", paddingTop: 8 }}>
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
                        title="Clear" aria-label="Clear this path"
                      >✕</button>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ ...row, borderBottom: "none", alignItems: "flex-start", paddingTop: 8 }}>
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
                        title="Clear" aria-label="Clear this path"
                      >✕</button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px solid #312c28", flexShrink: 0 }}>
          {/* Restores every persisted setting, including ones surfaced in the 3D View tab. Staged
              like any other edit: it doesn't persist until Save. */}
          <button
            onClick={() => { setLocal({ ...DEFAULTS }); setResetHint(true); }}
            style={chromeButton({ color: "#afa69d", padding: "7px 18px", fontSize: 13 })}
          >
            Reset to defaults
          </button>
          {resetHint && (
            <span style={{ color: "#f59e0b", fontSize: 11 }}>
              Defaults restored — Save to apply.
            </span>
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
