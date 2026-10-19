// Plain JS so tsdown can load it on Node 22 without a TypeScript loader.
import { defineConfig } from "tsdown";

/**
 * The attachment parser child (server/mail/extract/sandbox.ts): ONE self-contained file, every dependency bundled in,
 * no code splitting and no imports but node: builtins. The child runs with no file-system access, so it can't load
 * anything besides the code it's sent. Source mode builds the same thing on first use (server/mail/extract/bundle.ts).
 */
export const parserConfig = {
  entry: { "attachment-parser": "server/mail/extract/child.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  fixedExtension: false,
  sourcemap: false,
  dts: false,
  // Everything bundled; only these two packages may be (a new dependency fails the build until it's vetted and
  // listed); the output may import nothing but node: builtins.
  deps: { alwaysBundle: [/./], onlyBundle: ["unpdf", "@xmldom/xmldom"], onlyImport: [] },
  outputOptions: { codeSplitting: false },
};

export default defineConfig([
  {
    // content-worker runs email cleaning off the main thread (server/mail/pool.ts loads it next to cli.js).
    entry: { cli: "server/cli.ts", "content-worker": "server/mail/content-worker.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node22",
    // Keep the `bin` path stable (dist/cli.js) and only clean server output, so dist/web survives.
    fixedExtension: false,
    clean: ["dist/*.js", "dist/*.js.map", "dist/skill"],
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    copy: [{ from: "server/skill/SKILL.md", to: "dist/skill" }],
  },
  // After the server build's clean (configs build in order).
  { ...parserConfig, outDir: "dist", clean: false },
]);
