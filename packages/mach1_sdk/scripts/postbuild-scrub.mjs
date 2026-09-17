import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../dist/", import.meta.url);

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!full.endsWith(".js")) {
      continue;
    }
    const src = readFileSync(full, "utf8");
    const out = src.replace(/\/\*[\s\S]*?\*\//g, "");
    if (out !== src) {
      writeFileSync(full, out);
    }
  }
}

walk(root.pathname);
