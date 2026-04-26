import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: false,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
