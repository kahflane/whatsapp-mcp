import { defineConfig } from "tsup";

// Bundles the whole server into a single Node-runnable dist/index.js. This is what
// lets the package run without Bun:
//  • resolves our extensionless TS imports (Node's ESM loader can't on its own)
//  • strips types (no separate tsc emit step)
//  • keeps runtime deps + bun:sqlite external (npm-installed / built into Bun)
// The shipped bin runs on plain Node >= 18 via npx, and on Bun via bunx.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  external: ["bun:sqlite", "node-sqlite3-wasm"],
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: false,
  shims: false,
});
