import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Raw colour literals (UI redesign r3, Stage 14.1). Every colour comes from `src/theme/theme.ts`;
// a `#hex` string literal — or one inside a template literal, i.e. a CSS string — is an error in
// the directories listed below. The glob grows file by file as Stage 14.15 migrates the rest, so
// "no new errors" holds for files that haven't been cleaned yet. Deliberately *not* linted: the
// theme itself, and colour *data* (`blockDefs.ts`, `texturePack.ts`, game paint tables).
const RAW_HEX_MSG = "Raw colour literal — use a role from src/theme/theme.ts (or a ribbon/tokens re-export).";
const rawHexRule = ["error",
  { selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]", message: RAW_HEX_MSG },
  { selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]", message: RAW_HEX_MSG },
];
export const RAW_HEX_CLEAN_FILES = [
  "src/ribbon/**/*.{ts,tsx}",
  "src/windows/**/*.{ts,tsx}",
  "src/lens/**/*.{ts,tsx}",
  "src/hotbar/**/*.{ts,tsx}",
  "src/picker/**/*.{ts,tsx}",
  "src/commands/**/*.{ts,tsx}",
  "src/ui/**/*.{ts,tsx}",
  "src/Ribbon.tsx",
  "src/designTokens.ts",
  "src/HelpModal.tsx",
  "src/SettingsModal.tsx",
  "src/NewWorldModal.tsx",
  "src/WorldBrowserModal.tsx",
  "src/MaterializeModal.tsx",
  "src/UploadModal.tsx",
  "src/RecoveryModal.tsx",
  "src/DiagnosticsModal.tsx",
  "src/Modal.tsx",
  "src/AboutModal.tsx",
  "src/WorldInfoModal.tsx",
  "src/panels/**/*.{ts,tsx}",
];

// One slider primitive (Stage 15.5): every single-value slider goes through `SliderRow` and every
// dual-value one through `RangeSlider` (both in ribbon/primitives.tsx) instead of a raw native
// element, so the Windows sensitivity fixes (min track width, shift-drag fine, wheel/arrow step,
// click-to-type) apply everywhere instead of only where someone remembered to use the primitive.
// `primitives.tsx` itself is exempt (it's where `RangeSlider` legitimately uses the real element).
const rangeInputRule = {
  selector: 'JSXAttribute[name.name="type"][value.value="range"]',
  message: "Raw <input type=\"range\"> — use SliderRow (single value) or RangeSlider (dual value) from ribbon/primitives.tsx.",
};

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/", "uploadcode/", "EdenWorldManipulator2.0/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The codebase deliberately uses []-deps + ref mirrors in places; keep the
      // rule visible as a warning so new violations surface without blocking CI.
      "react-hooks/exhaustive-deps": "warn",
      // react-hooks v6 opinionated rules — flag long-standing patterns (setState in
      // effects, inline subcomponents, ref reads in render). Real cleanup targets for
      // the App state refactor; warnings until then so the gate passes on current code.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none",
      }],
      // Style preferences the existing code doesn't follow — not worth churn now.
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // `primitives.tsx` gets only the raw-hex rule (it's exempt from the range-input rule below) —
  // split out first since flat config's per-file rule merge is last-write-wins per rule name, not
  // additive, so a later block naming "no-restricted-syntax" for the same file would otherwise
  // silently replace this one instead of adding to it.
  {
    files: ["src/ribbon/primitives.tsx"],
    rules: { "no-restricted-syntax": rawHexRule },
  },
  {
    files: RAW_HEX_CLEAN_FILES,
    ignores: ["src/**/*.test.ts", "src/ribbon/primitives.tsx"],
    rules: { "no-restricted-syntax": ["error", ...rawHexRule.slice(1), rangeInputRule] },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: RAW_HEX_CLEAN_FILES,
    rules: { "no-restricted-syntax": ["error", rangeInputRule] },
  },
  // Command registry lock (UI redesign r3, 14.6; commands sub-plan §4.2): a ribbon tab renders
  // commands only through `ribbon/Cmd.tsx`, so ⌘K, Help and the ribbon read one registry. A
  // hand-rolled button primitive in a tab is a build failure, not a drift to discover later.
  // Non-command controls (Segmented, SliderRow, NumField, Check, Swatch, …) stay importable.
  {
    files: ["src/ribbon/tabs/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "../primitives",
          importNames: [
            "LargeButton", "SmallButton", "IconButton", "CommandButton", "ToggleButton",
            "SplitButton", "DropdownButton", "MenuItem",
          ],
          message: "Ribbon tabs render commands through ribbon/Cmd.tsx (<Cmd id>); add the command to commands/meta.ts + bind.ts.",
        }],
      }],
    },
  },
);
