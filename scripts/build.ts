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
const sharedUiExternals = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@pluhub/ui-sdk",
];
// CommonJS dependencies need the same shared runtime as native ES module imports.
const sharedUiBanner = `
import __pluhubReact from "react";
import * as __pluhubDOM from "react-dom";
import * as __pluhubClient from "react-dom/client";
import * as __pluhubJSX from "react/jsx-runtime";
import * as __pluhubSDK from "@pluhub/ui-sdk";
const __pluhubModules = {
  "react": __pluhubReact,
  "react-dom": __pluhubDOM,
  "react-dom/client": __pluhubClient,
  "react/jsx-runtime": __pluhubJSX,
  "react/jsx-dev-runtime": __pluhubJSX,
  "@pluhub/ui-sdk": __pluhubSDK,
};
const require = (id) => {
  if (Object.hasOwn(__pluhubModules, id)) return __pluhubModules[id];
  throw new Error("Unsupported browser module: " + id);
};
`;
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
      ...(entry.name === "playground"
        ? {
            outdir: out,
            entryNames: "ui",
            chunkNames: "chunk-[name]-[hash]",
            splitting: true,
          }
        : { outfile: resolve(out, "ui.js") }),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2023",
      jsx: "automatic",
      minify: true,
      external: sharedUiExternals,
      plugins: [expressionLicense],
      banner: {
        js: sharedUiBanner + (["model-catalog", "console", "leaderboard"].includes(entry.name)
          ?
              "/*!\n" +
              (await readFile(
                resolve(root, "model-catalog", "THIRD_PARTY_NOTICES.md"),
                "utf8",
              )) +
              "\n*/"
          : ""),
      },
      loader: { ".svg": "text" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
  if (entry.name === "console") {
    await build({
      entryPoints: {
        "vendor-react": resolve(directory, "vendor/react.ts"),
        "vendor-jsx-runtime": resolve(directory, "vendor/jsx-runtime.ts"),
        "vendor-react-dom": resolve(directory, "vendor/react-dom.ts"),
        "vendor-react-dom-client": resolve(directory, "vendor/react-dom-client.ts"),
        "vendor-ui-sdk": "@pluhub/ui-sdk",
      },
      outdir: out,
      splitting: true,
      chunkNames: "chunk-vendor-[hash]",
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2023",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    });
  }
  if (entry.name === "playground")
    await build({
      entryPoints: [resolve(directory, "ui.css")],
      outfile: resolve(out, "ui.css"),
      bundle: true,
      minify: true,
      loader: { ".woff2": "dataurl" },
      plugins: [
        {
          name: "modern-math-fonts",
          setup(builder) {
            builder.onLoad(
              { filter: /katex\.min\.css$/ },
              async ({ path }) => ({
                contents: (await readFile(path, "utf8")).replace(
                  /,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
                  "",
                ),
                loader: "css",
                resolveDir: resolve(path, ".."),
              }),
            );
          },
        },
      ],
    });
}
