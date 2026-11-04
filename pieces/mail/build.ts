import * as esbuild from "npm:esbuild@0.25.12";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
esbuild.stop();
