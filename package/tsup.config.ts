import { defineConfig } from "tsup";

export default defineConfig(({ watch = false }) => ({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "entities/index": "src/entities/index.ts",
    "migrations/index": "src/migrations/index.ts",
  },
  format: ["esm", "cjs"],
  splitting: false,
  watch,
  outDir: "dist",
  esbuildOptions(options) {
    options.minifyIdentifiers = true;
    options.minifySyntax = true;
    options.minifyWhitespace = true;
    options.keepNames = true;
  },
}));
