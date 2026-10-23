import { build, type Plugin } from "esbuild";
import { readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../plugins/", import.meta.url));
const jsepLicense = await readFile(
  new URL("../node_modules/jsep/LICENSE", import.meta.url),
  "utf8",
);
const expressionLicense: Plugin = {
  name: "billing-expression-license",
  setup(builder) {
    builder.onLoad(
      { filter: /[\\/]jsep[\\/]dist[\\/].*\.js$/ },
      async (args) => ({
        contents:
          "/*!\n" +
          jsepLicense +
          "\n*/\n" +
          (await readFile(args.path, "utf8")),
        loader: "js",
      }),
    );
  },
};
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(root, entry.name);
  if (!existsSync(resolve(directory, "manifest.json"))) continue;
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
    plugins: [expressionLicense],
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
      plugins: [expressionLicense],
      banner: ["model-catalog", "console"].includes(entry.name)
        ? {
            js:
              "/*!\n" +
              (await readFile(
                resolve(root, "model-catalog", "THIRD_PARTY_NOTICES.md"),
                "utf8",
              )) +
              "\n*/",
          }
        : undefined,
      loader: { ".svg": "text" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
}
