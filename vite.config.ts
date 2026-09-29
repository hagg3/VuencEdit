import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// Short git hash for the Diagnostics report (17.1). Falls back to "unknown" where there is no .git
// (the flattened public mirror, a source tarball) rather than failing the build.
async function gitShortHash(): Promise<string> {
  try {
    // @ts-expect-error node builtin; no @types/node in this project
    const { execSync } = await import("node:child_process");
    return String(execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })).trim() || "unknown";
  } catch { return "unknown"; }
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: { __GIT_HASH__: JSON.stringify(await gitShortHash()) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
