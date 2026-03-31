import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main/index.ts",
    preload: "src/main/preload.ts",
  },
  clean: true,
  format: ["cjs"],
  outDir: "dist-electron",
  target: "es2022",
  sourcemap: false,
});
