import { useState, type CSSProperties, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { MODAL_TEXT, expBadge, recessedWell } from "./designTokens";
// M1: shared floor/ceiling with FlyView3D's own in-pane slider and the ribbon 3D tab, so a value set
// here can never be silently clamped by a stricter range on either of the other two.
import { MAX_RENDER_DISTANCE, RD_MIN } from "./FlyView3D";
import { openView3dEverywhere, seedLastLayout } from "./windows/windowSeed";
import { Check, Segmented, Select, SliderRow } from "./ribbon/primitives";
import { ACCENT, FONT, ICON, RADIUS, TEXT_LABEL } from "./ribbon/tokens";
import { Icon } from "./ribbon/icons";
import { v } from "./theme/cssVars";
import { SKY_3D } from "./theme/theme";
import { SOUND_PACK_OPTIONS, type PackId } from "./sound/packs";
import { sfx } from "./sound/sfx";
import Dialog, { DialogButton } from "./ui/Dialog";
import { DialogNav, type DialogNavItem } from "./ui/DialogNav";

export const SETTINGS_KEY = "eden_settings";
/** The retired left tool rail's raw collapse key — read once by the v18 migration, then deleted. */
const LEFT_TOOLBAR_COLLAPSED_KEY = "left_toolbar_collapsed";

export interface AppSettings {
  /** Floating windows snap to the work-area edges and centre line (~12 px). Default true. */
  snapWindows: boolean;
  /** Set by the v23 migration for a user who was on the retired Quad layout: show the one-shot
   *  "Quad view was retired" toast on the next world load, then cleared (Stage 16.4). */
  pendingQuadRetiredNotice: boolean;
  defaultSaveCompressed: boolean;
  /** Compress the one-time `.bak` snapshot as `<path>.bak.zip` (deflate level 6) instead of a plain
   *  copy. Off by default — a plain copy is faster to create and, on APFS, an O(1) clone. */
  backupCompressed: boolean;
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
  /** Lamp light radius (blocks) for night lighting in the 3D fly-view. Default 4 (the Legacy profile's default). */
  lampRadius: number;
  /** Which shipped lamp-lighting behaviour the falloff curve follows: "legacy" (original 64z client,
   *  ~4-tile pool, steep falloff) or "modern" ("New Dawn"/256z, ~14-tile pool, gradual falloff).
   *  Switching profiles snaps `lampRadius` to that profile's default (see App.tsx commitLightingProfile).
   *  Default "legacy". */
  lightingProfile: "legacy" | "modern";
  /** Mouse-look sensitivity multiplier in grabbed-cursor LOOK mode. Default 1 (see FlyView3D's
   *  LOOK_SENS_BASE for the underlying rad/px rate this scales). */
  lookSensitivity: number;
  /** Mouse-look sensitivity multiplier for fly-mode drag-to-look. Default 1 (see DRAG_SENS_BASE). */
  dragSensitivity: number;
  /** Flips pitch direction (mouse up = look down) in both look and drag-to-look. Default false. */
  invertY: boolean;
  /** Autosave interval in minutes. 0 disables autosave. Default 3 (the old hardcoded AUTOSAVE_MS). */
  autosaveIntervalMin: number;
  /** Relief (hillshade) shading on the top-down map (Stage 13.2), toggled by View ▸ Render ▸ Relief.
   *  Default on. Additive — the defaults merge supplies it, no settings-version bump. */
  reliefShading: boolean;
  /** Auto-orient ramps/wedges/doors to the player's facing when placing in 3D build mode. Default true. */
  autoOrient3d: boolean;
  /** 3D pane sky-dome zenith / horizon colours (Stage 15.8). Editor-only viewer preferences — never
   *  written to the world file's sky. Defaults are the dome's original hard-coded gradient. */
  sky3dZenith: string;
  sky3dHorizon: string;
  /** Editor-only fog/sky-clear colour override; `null` = follow the world's own sky colour. Default
   *  `#8cbeff`, the Minecraft-like light blue the pane always started with. */
  fog3dColor: string | null;
  /** Soft (exponential) vs hard (linear) fog. Default false (hard). */
  fog3dSoft: boolean;
  /** 3D pane HUD (camera pill + key legend, compass/coords, perf readout). Default true. Never hides
   *  the build crosshair. */
  show3dHud: boolean;
  /** 3D pane floor grid. Default true. */
  show3dGrid: boolean;
  /** 3D pane Flood Fill mode's max air cells filled per click. Default 1000. */
  floodFillLimit: number;
  /** How far (blocks) a 3D build-mode break/place can reach. Deliberately *not* the pick reach:
   *  select / eyedropper / flood-fill keep the full `PICK_DIST` (256) because a long-range pick is
   *  informational, while a long-range edit lands where the 1-block outline is already sub-pixel —
   *  no visual confirmation of what changed. Past this cap the placement outline simply doesn't
   *  appear (build-mode hover picks at the same distance), so the refusal is legible. Default 64. */
  buildReach: number;
  /** Docked right sidebar (Inspector/Prefabs/History tabs — Elevation folded into Inspector) open on load. Default true. */
  sidebarOpen: boolean;
  /** Docked sidebar width in px, drag-resizable ~200–420. Default 260. */
  sidebarWidth: number;
  /** Docked sidebar's active tab on load. Default "inspector". */
  sidebarTab: "inspector" | "prefabs" | "history";
  /** Memory-budget preset (§6 of the 2026-08 memory-efficiency pass) — trades resident RAM against
   *  undo depth / cache hit rate / 3D streaming range. See `MEMORY_PRESETS`. Default "balanced". */
  memoryBudget: "low" | "balanced" | "high";
  /** Check github.com/hagg3/VuencEdit/releases on launch and show a splash-screen banner when a newer
   *  version is available. Default true; off means no network request is made at all. */
  checkForUpdatesOnLaunch: boolean;
  /** Bumped when a default changes in a way that must be pushed onto existing installs (see loadSettings). */
  settingsVersion: number;
  /** Which `TOUR_VERSION` (`src/tour/steps.tsx`) the onboarding coach-mark tour has been offered
   *  at. `0` (the default) means never — so a fresh install *and* every existing install whose
   *  stored blob predates this field both trigger the tour once. `bump-version.sh` is the only
   *  thing that raises `TOUR_VERSION`, to re-onboard existing users after a UI change. */
  tourVersion: number;
  /** Show the 3D pane's resident-geometry HUD + gate its sampling and the fetch/frame-time
   *  histograms behind it (ROADMAP-EDIT Stage 9.3/9.4). Off by default — the whole point of the
   *  toggle is that a diagnostic must never itself be a performance cost when nobody's watching. */
  showPerfHud: boolean;
  /** Set once the Stage 10.3 "potato profile" has run its one-time auto-adjustment (render distance
   *  → `RD_MIN`, memory preset → "low") after detecting a software WebGL rasterizer. Gates the
   *  adjustment to a single occurrence per install — without it, a user who deliberately raises
   *  render distance or memory preset back up on a known-software-rendering machine would have that
   *  choice silently reverted the next time the 3D pane mounts. Default false. */
  potatoProfileApplied: boolean;
  /** UI sound cues (UI redesign r3, Stage 14.12) — completion sounds only, never hover/pointer-rate.
   *  Default true: `{...DEFAULTS, ...parsed}` supplying this to every existing install *is* the
   *  "on by default" decision (§1 "Sounds"), same idiom as `enableFog`'s "matches the game" default. */
  uiSounds: boolean;
  /** Which synthesised pack (`src/sound/packs.ts`) plays the cues. Default "classic". */
  uiSoundPack: PackId;
  /** Master cue volume, 0–1. Default 0.8. */
  uiSoundVolume: number;
  /** Opt-in compact command-bar ribbon (UI redesign r3, Stage 14.10): a 32px icon-only command row
   *  over a 28px settings row, in place of the labelled ~96px body. Never the default — off means
   *  byte-for-byte the pre-14.10 ribbon. Also toggleable live from the ribbon's own bottom-right
   *  "Compact"/"Labels" chip and from ⌘K ("Compact Ribbon"), both of which write straight through
   *  `saveSettings` rather than waiting for this modal's Save button. */
  ribbonCompact: boolean;
  /** Motion preference (UI redesign r3, Stage 14.13): "system" defers to the OS's prefers-reduced-
   *  motion; "reduced"/"full" force it regardless of what the OS reports. Default "system". A JS
   *  gate (`src/theme/motion.ts`'s `useMotionPref`), never a CSS media query — see that file's
   *  header for why. */
  motion: "system" | "reduced" | "full";
}

/** Memory-budget preset table — the single source of truth for what each preset actually bounds.
 *  `undoBudgetBytes` reaches Rust via `set_undo_budget`; `tileBudgetBytes`/`geometryBudgetBytes` stay
 *  frontend-side as props into `MapCanvas`/`FlyView3D`. See CLAUDE.md's memory-efficiency pass notes.
 *
 *  `geometryBudgetBytes` replaced the old `vertexBudget` (3D-pane crash fix, Stage 1): a vertex costs
 *  24–36 B depending on stream and texture pack, and a 256z world reaches any vertex count 4× faster
 *  than the 64z worlds the old numbers were tuned on — so the cap now counts the thing that actually
 *  costs memory. ≈ 6 M / 16 M / 32 M textured verts, and (post upload-release) ≈ the resident GPU
 *  bytes rather than half of a doubled JS+GPU footprint. */
export const MEMORY_PRESETS: Record<AppSettings["memoryBudget"], {
  label: string;
  undoBudgetBytes: number;
  tileBudgetBytes: number;
  geometryBudgetBytes: number;
}> = {
  low:      { label: "Low",      undoBudgetBytes:  48 << 20, tileBudgetBytes: 128 << 20, geometryBudgetBytes:  192 << 20 },
  balanced: { label: "Balanced", undoBudgetBytes:  96 << 20, tileBudgetBytes: 256 << 20, geometryBudgetBytes:  512 << 20 },
  high:     { label: "High",     undoBudgetBytes: 256 << 20, tileBudgetBytes: 512 << 20, geometryBudgetBytes: 1024 << 20 },
};

/** Current settings schema version. Bump + add a case to `migrate()` when a stored default must change. */
const SETTINGS_VERSION = 23;

/** Exported so Stage 10.3's potato-profile check can test "still at the stock default" without
 *  duplicating the magic numbers — the same heuristic `migrate()` itself uses per-field above. */
export const DEFAULTS: AppSettings = {
  snapWindows: true,
  pendingQuadRetiredNotice: false,
  defaultSaveCompressed: false,
  backupCompressed: false,
  templatePath: null,
  texturePackPath: null,
  prefabDirectory: null,
  enableFog: true,
  renderDistance: 5,
  flySpeed: 1,
  sunT: 0.5,
  lampRadius: 4,
  lightingProfile: "legacy",
  lookSensitivity: 1,
  dragSensitivity: 1,
  invertY: false,
  autosaveIntervalMin: 3,
  reliefShading: true,
  autoOrient3d: true,
  sky3dZenith: SKY_3D.zenith,
  sky3dHorizon: SKY_3D.horizon,
  fog3dColor: SKY_3D.fog,
  fog3dSoft: false,
  show3dHud: true,
  show3dGrid: true,
  floodFillLimit: 1000,
  buildReach: 64,
  sidebarOpen: true,
  sidebarWidth: 260,
  sidebarTab: "inspector",
  memoryBudget: "balanced",
  checkForUpdatesOnLaunch: true,
  settingsVersion: SETTINGS_VERSION,
  tourVersion: 0,
  showPerfHud: false,
  potatoProfileApplied: false,
  uiSounds: true,
  uiSoundPack: "classic",
  uiSoundVolume: 0.8,
  ribbonCompact: false,
  motion: "system",
};

/** Stage 10.5 — the flat "balanced" default asked for ~768 MB of GPU-backed memory (512 MB geometry
 *  + 256 MB tile canvases) before a 2048²/4096² shadow map on top, tuned on a development Mac and
 *  applied to completely unknown hardware. `deviceMemory` (Chromium only — undefined in Safari/
 *  Firefox/older WebView2; spec-capped, so treat 8 as "8 or more", not exactly 8) and
 *  `hardwareConcurrency` are the only two capability hints available synchronously, before any GPU
 *  context exists — this can't see Stage 9.2/10.3's renderer-string verdict, which needs the 3D pane
 *  to actually mount first and is handled separately by the potato-profile check. Deliberately
 *  conservative: "low" trips on one weak signal, "high" needs both strong, everything else — including
 *  every machine this can't read anything about — stays "balanced". */
export function deviceAwareDefaultMemoryBudget(): AppSettings["memoryBudget"] {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;
  if ((mem != null && mem <= 4) || (cores != null && cores <= 2)) return "low";
  if (mem != null && mem >= 8 && cores != null && cores >= 8) return "high";
  return "balanced";
}

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
  // v2 → v3: added sidebarOpen/sidebarWidth/sidebarTab (docked right sidebar). No forced value
  // needed — the `{...DEFAULTS, ...parsed}` merge supplies the new fields for existing installs.
  // v3 → v4: the Elevation tab was folded into Inspector — remap installs parked on it.
  if (from < 4 && s.sidebarTab === "elevation") s.sidebarTab = "inspector";
  // v4 → v5: added the Legacy/Modern lighting profile toggle; the Legacy default radius moved from 5
  // to 4 to match the real original-client pool size. Only snap installs still parked on the old
  // untouched default — anyone who dragged the Lamp R slider keeps their chosen value.
  if (from < 5 && s.lampRadius === 5) s.lampRadius = 4;
  // v5 → v6: added backupCompressed. No forced value needed — the `{...DEFAULTS, ...parsed}` merge
  // supplies it (default false, matching the pre-existing plain-.bak behaviour).
  // v6 → v7: added the memoryBudget preset (Low/Balanced/High). No forced value needed — the
  // `{...DEFAULTS, ...parsed}` merge supplies "balanced", matching every pre-existing install's
  // actual undo/tile/vertex ceilings (96 MB / 256 MB / 30 M verts) exactly, so this is purely additive.
  // v7 → v8: the 3D pane's `vertexBudget` became `geometryBudgetBytes` and every preset's 3D ceiling
  // was retuned down (a 30 M-vertex "Balanced" was ~1.9 GB of resident geometry — the 256z fly-view
  // crash). No forced value needed: the ceilings live in `MEMORY_PRESETS` above, not in the stored
  // blob, so an existing install picks them up from the `memoryBudget` preset it already has. The
  // bump is here to record that the meaning of that preset changed.
  // v8 → v9: added buildReach (3D build-mode break/place cap, default 64). No forced value needed —
  // the `{...DEFAULTS, ...parsed}` merge supplies it. This *is* a behaviour change for existing
  // installs (build used to reach the full 256-block pick distance), which is the point: an edit
  // 250 blocks out has no legible outline. The bump records it.
  // v9 → v10: added checkForUpdatesOnLaunch (splash-screen GitHub release check). No forced value
  // needed — the `{...DEFAULTS, ...parsed}` merge supplies it (default true).
  // v10 → v11: added leftToolbarOpen (docked-left tool rail). No forced value needed — the
  // `{...DEFAULTS, ...parsed}` merge supplies it (default true).
  // v11 → v12: added tourVersion (onboarding coach-mark tour gate). No forced value needed — the
  // `{...DEFAULTS, ...parsed}` merge supplies it (default 0), which is what makes every existing
  // install see the tour once, same as a fresh one.
  // v12 → v13: removed enableExperimentalExport (OBJ/JSON/VOX export and schematic import moved to
  // the sibling EdenToMC project). Strip the stale key so it doesn't linger forever in localStorage —
  // the `{...DEFAULTS, ...parsed}` merge would otherwise keep re-adding a field nothing reads. Also
  // drop the now-orphaned `eden_schematic_presets` key (written by the deleted SchematicImportModal),
  // a separate localStorage entry outside this settings blob.
  if (from < 13) {
    delete s.enableExperimentalExport;
    try { localStorage.removeItem("eden_schematic_presets"); } catch { /* ignore */ }
  }
  // v13 → v14: fly speed was badly calibrated — the slider ran 0.1-12/60 depending on which of two
  // mismatched sliders you touched, and the old default of 1.0 actually felt like warp speed; 0.2 was
  // the value that felt right. The actual movement math was rescaled to match (FLY_SPEED_SCALE in
  // FlyView3D.tsx), so a stored value from before this version means something 5x faster than it used
  // to — clamp any pre-existing value into the new 0.1-3 range so an install that had cranked the old
  // slider up doesn't suddenly fly 5x faster than before.
  if (from < 14 && typeof s.flySpeed === "number") {
    s.flySpeed = Math.min(3, Math.max(0.1, s.flySpeed));
  }
  // v14 → v15: added showPerfHud (release-build diagnostics, ROADMAP-EDIT Stage 9). No forced
  // value needed — the `{...DEFAULTS, ...parsed}` merge supplies it (default false).
  // v15 → v16: added potatoProfileApplied (Stage 10.3 software-renderer auto-adjustment gate). No
  // forced value needed — the `{...DEFAULTS, ...parsed}` merge supplies it (default false), so every
  // existing install is eligible for exactly one auto-adjustment the next time it mounts the 3D pane
  // on a software-rendering machine, same as a fresh install.
  // v16 → v17: memoryBudget's flat "balanced" default is retuned once, device-aware (Stage 10.5).
  // Only touches installs still parked on "balanced" — the same "still at the old default" proxy for
  // "never touched" every earlier per-field migration in this function already relies on (see
  // lampRadius above); an install that explicitly *chose* Low or High is untouched either way.
  if (from < 17 && s.memoryBudget === "balanced") {
    s.memoryBudget = deviceAwareDefaultMemoryBudget();
  }
  // v17 → v18: UI redesign r3's layout (ROADMAP-EDIT 14.3/14.4, open question 1). Every install
  // moves to the map + floating windows layout (`defaultQuadView` was force-set true for *every*
  // install at v1, so "chose quad" was undetectable). The old quad-only toggles seed the window layout the
  // user inherits on their next world (`seedLastLayout`): the 3D window opens iff they had the 3D
  // pane on by default (open question 2's existing-install rule), and the Tools window keeps the
  // old left tool rail's open/collapsed state (its raw `left_toolbar_collapsed` key is retired).
  if (from < 18) {
    const toolsCollapsed = (() => {
      try { return localStorage.getItem(LEFT_TOOLBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
    })();
    seedLastLayout({
      view3dOpen: s.default3dPane === true,
      toolsOpen: s.leftToolbarOpen !== false,
      toolsCollapsed,
    });
    delete s.defaultQuadView;
    delete s.default3dPane;
    delete s.leftToolbarOpen;
    try { localStorage.removeItem(LEFT_TOOLBAR_COLLAPSED_KEY); } catch { /* ignore */ }
  }
  // v18 → v19: added uiSounds/uiSoundPack/uiSoundVolume (UI redesign r3, Stage 14.12). No forced
  // value needed — the `{...DEFAULTS, ...parsed}` merge below supplies `uiSounds: true` to every
  // existing install, which *is* the "on by default" decision (§1 "Sounds": on, Classic pack). A
  // user who then turns it off keeps that choice, same as every other additive-default migration
  // in this function.
  // v19 → v20: added ribbonCompact (UI redesign r3, Stage 14.10, the opt-in compact command-bar
  // ribbon). No forced value needed — the `{...DEFAULTS, ...parsed}` merge below supplies `false`
  // to every existing install, so nobody's ribbon changes shape on upgrade; it's purely opt-in.
  // v20 → v21: added `motion` (UI redesign r3, Stage 14.13). No forced value needed — the
  // `{...DEFAULTS, ...parsed}` merge below supplies "system" to every existing install, which just
  // continues to follow the OS's Reduce Motion setting as it always implicitly did.
  // v21 → v22: removed showQuickActions (UI polish r4, Stage 15.2) — the Quick Actions bar can no
  // longer be hidden, so the toggle and its stored value are gone. Strip the stale key so it
  // doesn't linger forever in localStorage, same as the v12 → v13 precedent above.
  if (from < 22) delete s.showQuickActions;
  // v22 → v23: Quad (legacy) was retired (UI polish r4, Stage 16.4). `workLayout`, `quad3dEnabled`
  // and `pendingLayoutNotice` are gone. A user who had switched to Quad (`workLayout === "quad"`;
  // v18 forced everyone else to "windows") gets their 3D view as an *open* 3D window and a one-shot
  // toast; `openView3dEverywhere` also covers a layout they already have stored. Everyone else just
  // has the dead keys stripped (v12 → v13 idiom).
  if (from < 23) {
    if (s.workLayout === "quad") {
      openView3dEverywhere({ view3dOpen: true, toolsOpen: true, toolsCollapsed: false });
      s.pendingQuadRetiredNotice = true;
    }
    delete s.workLayout;
    delete s.quad3dEnabled;
    delete s.pendingLayoutNotice;
  }
  // (Stage 15.8 added sky3dZenith/sky3dHorizon/fog3dColor/fog3dSoft/show3dHud/show3dGrid with no
  // version bump: purely additive, so the `{...DEFAULTS, ...parsed}` merge below supplies every
  // existing install the same look the pane always had.)
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
    // A genuinely fresh install (no blob at all) never runs `migrate()` above — v17's device-aware
    // memoryBudget pick has to be applied here instead, or every first launch would silently get the
    // flat "balanced" DEFAULTS value forever (Stage 10.5).
    if (!raw) return { ...DEFAULTS, memoryBudget: deviceAwareDefaultMemoryBudget() };
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>) {
  const current = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...patch }));
}

// ── Layout primitives (UI redesign r3, Stage 14.17 — Dialog/DialogNav chrome) ────────────────────

const rowDivider = `1px solid ${v("border-modalHairline")}`;

/** Two-column settings row (plan §3.3): label + one-line description on the left, one control
 *  right-aligned. Replaces the old "checkbox + stacked label" rows. */
function SettingRow({
  label, badge, description, children, last, align = "center",
}: {
  label: string; badge?: ReactNode; description?: ReactNode; children: ReactNode;
  last?: boolean; align?: CSSProperties["alignItems"];
}) {
  return (
    <div style={{
      display: "flex", alignItems: align, justifyContent: "space-between", gap: 16,
      padding: "9px 0", borderBottom: last ? "none" : rowDivider,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: FONT.body, color: MODAL_TEXT.primary, display: "flex", alignItems: "center" }}>
          {label}{badge}
        </span>
        {description && (
          <span style={{ fontSize: FONT.label, color: MODAL_TEXT.secondary, lineHeight: 1.4 }}>
            {description}
          </span>
        )}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{children}</div>
    </div>
  );
}

/** Small-caps section heading (`FONT.label`/`TEXT_LABEL`), the plan's `md-sec`/`md-cap`. */
function SectionHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div style={{
      fontSize: FONT.label, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
      color: TEXT_LABEL, margin: first ? "0 0 6px" : "16px 0 6px",
    }}>
      {children}
    </div>
  );
}

/** A file/directory path setting: label + description on top, a recessed path well + Browse +
 *  optional Clear below. Kept as its own row shape (not the plain two-column `SettingRow`) since a
 *  full path needs more width than a right-aligned control column leaves it. */
function PathRow({
  label, badge, description, value, placeholder, onBrowse, onClear, last,
}: {
  label: string; badge?: ReactNode; description: ReactNode; value: string | null; placeholder: string;
  onBrowse: () => void; onClear?: () => void; last?: boolean;
}) {
  return (
    <div style={{ padding: "9px 0", borderBottom: last ? "none" : rowDivider }}>
      <div style={{ fontSize: FONT.body, color: MODAL_TEXT.primary, display: "flex", alignItems: "center" }}>
        {label}{badge}
      </div>
      <div style={{ fontSize: FONT.label, color: MODAL_TEXT.secondary, lineHeight: 1.4, marginTop: 2 }}>
        {description}
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{
          ...recessedWell, flex: 1, fontSize: FONT.body,
          color: value ? MODAL_TEXT.secondary : MODAL_TEXT.label,
          borderRadius: RADIUS.md, padding: "5px 10px", overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", direction: "rtl", textAlign: "left",
        }}>
          {value ?? placeholder}
        </div>
        <DialogButton onClick={onBrowse}>Browse…</DialogButton>
        {value && onClear && (
          <button
            type="button" onClick={onClear} title="Clear" aria-label="Clear this path"
            style={{
              background: "none", border: "none", color: MODAL_TEXT.secondary, cursor: "pointer",
              padding: "0 4px", display: "flex", flexShrink: 0,
            }}
          >
            <Icon name="close" size={ICON.xs} tone="inherit" />
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  /** Settings ▸ Layout ▸ Reset window positions — applies immediately (not staged until Save);
   *  omitted on the splash screen, where there are no windows to reset. */
  onResetWindows?: () => void;
  /** Paste lens (14.9): live `wins.lens.open` state + toggle, mirroring the View ▸ Windows ▸ Paste
   *  Lens command — the *window*, not visibility (it only actually shows while a paste is armed).
   *  Applies immediately, like `onResetWindows`; omitted on the splash screen for the same reason. */
  lensWindowOpen?: boolean;
  onToggleLensWindow?: () => void;
  /** Which tab to open on (⌘K "Sound Settings…" opens straight on Sounds). */
  initialTab?: SettingsTab;
}

export type SettingsTab = "general" | "layout" | "3d" | "editor" | "sounds" | "files";

const NAV_ITEMS: DialogNavItem[] = [
  { id: "general", icon: "settings", label: "General" },
  { id: "layout", icon: "windows", label: "Layout & windows" },
  { id: "3d", icon: "pane3d", label: "3D View" },
  { id: "editor", icon: "pen", label: "Editor" },
  { id: "sounds", icon: "wavy", label: "Sounds" },
  { id: "files", icon: "open", label: "Files" },
];

export default function SettingsModal({
  onClose, onSave, onResetWindows, lensWindowOpen, onToggleLensWindow, initialTab = "general",
}: Props) {
  const [local, setLocal] = useState<AppSettings>(() => loadSettings());
  const [resetHint, setResetHint] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);

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
    <Dialog
      size="md" icon="settings" title="Settings" onClose={onClose}
      nav={<DialogNav items={NAV_ITEMS} value={tab} onChange={id => setTab(id as SettingsTab)} />}
      footer={
        <>
          {/* Restores every persisted setting, including ones surfaced in the 3D View tab. Staged
              like any other edit: it doesn't persist until Save. D0's left-slot convention: a
              footer child with marginRight:"auto" — no dedicated slot component. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: "auto" }}>
            <DialogButton onClick={() => { setLocal({ ...DEFAULTS }); setResetHint(true); }}>
              Reset to defaults
            </DialogButton>
            {resetHint && (
              <span style={{ color: ACCENT.warm, fontSize: FONT.label }}>
                Defaults restored — Save to apply.
              </span>
            )}
          </div>
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={handleSave}>Save</DialogButton>
        </>
      }
    >
      {tab === "general" && (
        <>
          <SettingRow label="Check for updates on launch"
            description="Checks github.com/hagg3/VuencEdit/releases and shows a banner on the splash screen if a newer version is out">
            <Check checked={local.checkForUpdatesOnLaunch} onChange={v => set("checkForUpdatesOnLaunch", v)} label="" title="Check for updates on launch" />
          </SettingRow>

          <SettingRow label="Motion"
            description={<>Chrome animations — popover open, contextual tabs appearing, the edit-completion outline. "System" follows the OS's Reduce Motion setting.</>}>
            <Segmented
              ariaLabel="Motion"
              value={local.motion}
              onChange={v => set("motion", v)}
              options={[
                { id: "system", label: "System" },
                { id: "reduced", label: "Reduced" },
                { id: "full", label: "Full" },
              ]}
            />
          </SettingRow>

          <SettingRow last label="Memory budget"
            description={
              <>
                Trades resident RAM against undo depth, tile-cache hit rate, and 3D streaming range.
                {" "}{MEMORY_PRESETS[local.memoryBudget].label} ≈ {MEMORY_PRESETS[local.memoryBudget].undoBudgetBytes / (1 << 20)} MB undo
                + {MEMORY_PRESETS[local.memoryBudget].tileBudgetBytes / (1 << 20)} MB tiles
                + {MEMORY_PRESETS[local.memoryBudget].geometryBudgetBytes / (1 << 20)} MB 3D geometry.
              </>
            }>
            <Segmented
              ariaLabel="Memory budget"
              value={local.memoryBudget}
              onChange={v => set("memoryBudget", v)}
              options={(Object.keys(MEMORY_PRESETS) as (keyof typeof MEMORY_PRESETS)[]).map(key => ({
                id: key, label: MEMORY_PRESETS[key].label,
              }))}
            />
          </SettingRow>
        </>
      )}

      {tab === "layout" && (
        <>
          <SectionHeading first>Ribbon</SectionHeading>
          <SettingRow
            label="Compact ribbon (command bar)" badge={<Badge>exp</Badge>}
            description="An icon-only command row over a settings row, instead of the labelled ribbon. Experimental and disabled for now (2026-09-28) — the ribbon's own corner toggle was removed.">
            <Check checked={local.ribbonCompact} onChange={v => set("ribbonCompact", v)} label="" title="Compact ribbon (command bar) — experimental, disabled" disabled />
          </SettingRow>

          <SectionHeading>Work area</SectionHeading>
          <SettingRow last={!onToggleLensWindow && !onResetWindows} label="Snap windows"
            description="Floating windows snap to the work-area edges and centre line while you drag them">
            <Check checked={local.snapWindows} onChange={v => set("snapWindows", v)} label="" title="Snap windows" />
          </SettingRow>

          {onToggleLensWindow && (
            <SettingRow last={!onResetWindows} label="Paste lens: show while pasting"
              description="Front/side elevations with Z controls, appearing at the paste ghost — same as View ▸ Windows ▸ Paste Lens (⌥P)">
              <Check checked={lensWindowOpen ?? false} onChange={() => onToggleLensWindow()} label="" title="Paste lens: show while pasting" />
            </SettingRow>
          )}

          {onResetWindows && (
            <SettingRow last label="Reset window positions"
              description="Puts every window back where it starts on a fresh install (this world only; takes effect now).">
              <DialogButton onClick={onResetWindows}>Reset window positions</DialogButton>
            </SettingRow>
          )}
        </>
      )}

      {tab === "3d" && (
        <>
          <SettingRow label="Look sensitivity" description="Mouselook speed in grabbed-cursor LOOK mode (Z from orbit)">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.lookSensitivity} min={0.25} max={4} step={0.05}
              format={v => `${v.toFixed(2)}×`}
              onChange={v => set("lookSensitivity", v)}
            />
          </SettingRow>

          <SettingRow label="Fly-drag sensitivity" description="Look speed while drag-looking (left-drag) in FLY mode">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.dragSensitivity} min={0.25} max={4} step={0.05}
              format={v => `${v.toFixed(2)}×`}
              onChange={v => set("dragSensitivity", v)}
            />
          </SettingRow>

          <SettingRow label="Invert Y axis" description="Flips pitch: mouse up looks down">
            <Check checked={local.invertY} onChange={v => set("invertY", v)} label="" title="Invert Y axis" />
          </SettingRow>

          <SettingRow label="Fog in 3D views" description="Fades distant terrain like the game does; turn off to inspect far terrain">
            <Check checked={local.enableFog} onChange={v => set("enableFog", v)} label="" title="Fog in 3D views" />
          </SettingRow>

          {/* Night lighting / Shadows / GPU shadow map are perf-heavy, session-only view modes —
              they live in the Ribbon's 3D/View Lighting group (⚡ badged) and always start off,
              so they're deliberately not persisted defaults here. */}

          <SettingRow last label="3D performance HUD" description="Resident-geometry readout in the 3D pane; also feeds Help ▸ Diagnostics">
            <Check checked={local.showPerfHud} onChange={v => set("showPerfHud", v)} label="" title="3D performance HUD" />
          </SettingRow>

          <SectionHeading>3D pane sliders</SectionHeading>

          <SettingRow label="Render distance">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.renderDistance} min={RD_MIN} max={MAX_RENDER_DISTANCE} step={1}
              format={v => `${Math.round(v)} chunks`}
              onChange={v => set("renderDistance", Math.round(v))}
            />
          </SettingRow>

          <SettingRow label="Fly speed">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.flySpeed} min={0.1} max={3} step={0.1}
              format={v => `${v.toFixed(1)}×`}
              onChange={v => set("flySpeed", v)}
            />
          </SettingRow>

          <SettingRow label="Sun angle">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.sunT} min={0} max={1} step={0.01}
              format={v => (v < 0.03 ? "sunrise" : v > 0.97 ? "sunset" : v === 0.5 ? "noon" : v.toFixed(2))}
              onChange={v => set("sunT", v)}
            />
          </SettingRow>

          <SettingRow label="Lamp radius">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.lampRadius} min={2} max={32} step={1}
              format={v => `${Math.round(v)} blocks`}
              onChange={v => set("lampRadius", Math.round(v))}
            />
          </SettingRow>

          <SettingRow label="Build reach"
            description="How far a 3D build-mode break/place can reach. Past it the placement outline doesn't appear and a click does nothing. Select, eyedropper and flood fill still reach 256.">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.buildReach} min={8} max={256} step={8}
              format={v => `${Math.round(v)} blocks`}
              onChange={v => set("buildReach", Math.round(v))}
            />
          </SettingRow>

          <SettingRow last label="Lighting profile"
            description="Legacy (~4-tile, steep falloff) vs Modern/New Dawn (~14-tile, gradual falloff). Switching snaps Lamp radius to that profile's default.">
            <Segmented
              ariaLabel="Lighting profile"
              value={local.lightingProfile}
              onChange={v => {
                set("lightingProfile", v);
                set("lampRadius", v === "legacy" ? 4 : 14);
              }}
              options={[
                { id: "legacy", label: "Legacy" },
                { id: "modern", label: "New Dawn" },
              ]}
            />
          </SettingRow>

          <div style={{ fontSize: FONT.label, color: MODAL_TEXT.secondary, marginTop: 8 }}>
            These are also editable from the 3D pane / Ribbon directly — surfaced here so Reset to defaults has somewhere visible to reset them to.
          </div>
        </>
      )}

      {tab === "editor" && (
        <>
          <SettingRow label="Save compressed by default" description="New worlds save as .zip; overridden by the loaded world's format">
            <Check checked={local.defaultSaveCompressed} onChange={v => set("defaultSaveCompressed", v)} label="" title="Save compressed by default" />
          </SettingRow>

          <SettingRow last label="Compress backups" description="The one-time pre-save snapshot is written as .bak.zip instead of a plain .bak copy">
            <Check checked={local.backupCompressed} onChange={v => set("backupCompressed", v)} label="" title="Compress backups" />
          </SettingRow>

          <SectionHeading>Autosave</SectionHeading>
          <SettingRow last label="Autosave interval" description="How often an in-progress world is snapshotted to a recovery sidecar. 0 disables autosave.">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.autosaveIntervalMin} min={0} max={15} step={1}
              format={v => (v === 0 ? "Off" : `${Math.round(v)} min`)}
              onChange={v => set("autosaveIntervalMin", Math.round(v))}
            />
          </SettingRow>
        </>
      )}

      {tab === "sounds" && (
        <>
          <SettingRow label="UI sounds"
            description="Synthesised completion cues (tab/menu switches, copy/paste, save, rotate/mirror, undo/redo, drag start and drop, errors). Never on hover, never at pointer or stamp rate.">
            <Check checked={local.uiSounds} onChange={v => set("uiSounds", v)} label="" title="UI sounds" />
          </SettingRow>

          <SettingRow label="Sound pack" description="Choosing a pack plays a sample">
            <Select<PackId>
              value={local.uiSoundPack}
              options={SOUND_PACK_OPTIONS}
              onChange={id => { set("uiSoundPack", id); sfx.preview("copy", id, local.uiSoundVolume); }}
              ariaLabel="Sound pack"
              width={170}
            />
          </SettingRow>

          <SettingRow last label="Volume">
            <SliderRow label="" labelWidth={0} width={130}
              value={local.uiSoundVolume} min={0} max={1} step={0.05}
              format={v => `${Math.round(v * 100)}%`}
              onChange={v => set("uiSoundVolume", v)}
            />
          </SettingRow>
        </>
      )}

      {tab === "files" && (
        <>
          <PathRow
            label="Eden.eden template path" badge={<Badge>exp</Badge>}
            description="Eden.eden is the pre-generated template bundled with the game. Point this at your copy to show its terrain faded behind the gaps in a sparse/normal world's map (View ▾ → Template Overlay), or to &quot;Expand from Template&quot; and bake it into a full world file."
            value={local.templatePath} placeholder="Not set"
            onBrowse={browsePath} onClear={() => set("templatePath", null)}
          />

          <PathRow
            label="Texture pack path"
            description="ZIP of PNGs — adds textures to 3D views and block picker icons"
            value={local.texturePackPath} placeholder="Not set"
            onBrowse={browseTexturePack} onClear={() => set("texturePackPath", null)}
          />

          <PathRow last
            label="Prefab library folder"
            description="Scanned by the Prefab Library panel. Leave unset to use the app's own folder."
            value={local.prefabDirectory} placeholder="App default"
            onBrowse={browsePrefabDir} onClear={() => set("prefabDirectory", null)}
          />
        </>
      )}
    </Dialog>
  );
}

/** Local alias — `Badge` from `ribbon/primitives.tsx` is the one "exp" badge treatment app-wide,
 *  keeping the same visual as `designTokens.ts`'s `expBadge()` recipe it's re-backed by. */
function Badge({ children }: { children: ReactNode }) {
  return <span style={expBadge({ marginLeft: 7, verticalAlign: "middle" })}>{children}</span>;
}
