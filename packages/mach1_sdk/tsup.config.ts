import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig } from "tsup";

function collectEntries(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};

  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }

      const entryKey = relative("src", fullPath).replace(/\.ts$/, "");
      entries[entryKey] = fullPath;
    }
  }

  walk(dir);

  return entries;
}

export default defineConfig({
  clean: true,
  dts: false,
  entry: collectEntries("src"),
  format: ["esm"],
  legalComments: "none",
  minify: true,
  noExternal: [
    /^@0xmonaco\/core$/,
    /^@0xmonaco\/types$/,
    /^http-status-codes$/,
    /^viem$/,
    /^viem\//,
  ],
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node20",
});
