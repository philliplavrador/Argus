// esbuild inject shim: the Agent SDK is ESM and reads `import.meta.url`;
// bundled to CJS that becomes undefined and createRequire() throws at load.
// The define in esbuild.mjs rewrites every `import.meta.url` to this value.
export let import_meta_url = require('node:url').pathToFileURL(__filename);
