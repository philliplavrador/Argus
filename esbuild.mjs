import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuild = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

await mkdir("dist", { recursive: true });
await copyFile("media/argus.svg", "dist/argus.svg");

if (watch) {
  const ctx1 = await esbuild.context(extensionBuild);
  const ctx2 = await esbuild.context(webviewBuild);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
} else {
  await Promise.all([esbuild.build(extensionBuild), esbuild.build(webviewBuild)]);
}
