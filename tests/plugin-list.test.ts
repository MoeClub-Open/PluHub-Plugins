import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  filterPlugins,
  pluginCategory,
  pluginCategoryOptions,
  pluginCategories,
} from "../plugins/console/plugin-list.js";

const plugins = readdirSync(new URL("../plugins/", import.meta.url)).map(
  (name) => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../plugins/" + name + "/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      state: "Active",
      manifest,
    };
  },
);

it("classifies every official plugin without hiding plugins or inventing empty category filters", () => {
  const known = new Set(pluginCategories.map((c) => c.id));
  expect(
    plugins.every((p) => p.manifest.category && known.has(p.manifest.category)),
  ).toBe(true);
  const options = pluginCategoryOptions(plugins);
  expect(options.reduce((n, c) => n + c.count, 0)).toBe(plugins.length);
  expect(options.every((c) => c.count > 0)).toBe(true);
  expect(filterPlugins(plugins, "", "", "")).toEqual(plugins);
});

it("combines category, state and multiword search while preserving name and description fallbacks", () => {
  const rows = plugins.map((p) =>
    p.id === "official.payments-stripe"
      ? { ...p, name: undefined, description: undefined, state: "Stopped" }
      : p,
  );
  expect(
    filterPlugins(rows, "STRIPE 已停用", "commerce", "Stopped").map(
      (p) => p.id,
    ),
  ).toEqual(["official.payments-stripe"]);
  expect(filterPlugins(rows, "stripe", "ingress", "Stopped")).toEqual([]);
  expect(filterPlugins(rows, "stripe", "commerce", "Active")).toEqual([]);
  expect(filterPlugins(rows, "计费 支付", "", "").length).toBeGreaterThan(0);
  expect(filterPlugins(rows, "missing-plugin", "", "")).toEqual([]);
});

it("supports custom categories and uncategorized legacy plugins, including persistent tool packages", () => {
  const base = { id: "third.party", state: "Failed" };
  const custom = { ...base, manifest: { category: "community.monitoring" } };
  const legacy = {
    ...base,
    id: "old.tool",
    manifest: { ui: { path: "/playground" } },
  };
  const unknown = { ...base, id: "old.unknown", manifest: {} };
  const options = pluginCategoryOptions([custom, legacy, unknown]);
  expect(options).toEqual([
    { id: "tools", title: "模型工具", count: 1 },
    { id: "other", title: "其他", count: 1 },
    { id: "community.monitoring", title: "community.monitoring", count: 1 },
  ]);
  expect(
    filterPlugins(
      [custom, legacy, unknown],
      "异常",
      "community.monitoring",
      "Failed",
    ),
  ).toEqual([custom]);
  expect(
    pluginCategory({
      ...base,
      manifest: { provides: ["ai.upstream.custom@1"] },
    }),
  ).toBe("upstream");
  expect(
    pluginCategory({
      ...base,
      manifest: { category: "routing", provides: ["ai.upstream.custom@1"] },
    }),
  ).toBe("routing");
});
