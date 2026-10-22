import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../plugins/", import.meta.url));
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name === "subscription-accounts") continue; // Retired aggregate; retained only as migration history.
  const directory = resolve(root, entry.name);
  const out = resolve(directory, "dist");
  if (!out.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new Error("Build output is outside the plugin workspace");
  await rm(out, { recursive: true, force: true });
  await build({
    entryPoints: [resolve(directory, "index.ts")],
    outfile: resolve(out, "index.js"),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
  });
  if (existsSync(resolve(directory, "ui.tsx")))
    await build({
      entryPoints: [resolve(directory, "ui.tsx")],
      outfile: resolve(out, "ui.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2023",
      jsx: "automatic",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    });
}
