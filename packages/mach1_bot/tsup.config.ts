import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/main.ts"],
  outDir: "dist/cli",
  format: ["cjs"],
  target: "node20",
  clean: true,
  dts: false,
  sourcemap: false,
  splitting: false,
});
