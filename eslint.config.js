import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
);
