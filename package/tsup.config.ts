import { defineConfig } from "tsup";

export default defineConfig(({ watch = false }) => ({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  splitting: false,
  watch,
  esbuildOptions(options) {
    options.minifyIdentifiers = false;
    options.minifySyntax = true;
    options.minifyWhitespace = true;
  },
}));
