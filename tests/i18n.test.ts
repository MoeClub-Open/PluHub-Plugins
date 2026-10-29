import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { translateMessage } from "@pluhub/ui-sdk";
import { en } from "../lib/ui/locales/en.js";
import { authError } from "../plugins/console/auth-errors.js";
import {
  bindInternationalization,
  configureMessages,
  getLocale,
  getLanguagePreference,
  initializeLanguage,
  setLanguagePreference,
  setAccountLanguage,
  setSiteLanguage,
  subscribeLanguage,
  syncLanguagePreferences,
  t,
} from "../lib/ui/i18n.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cjk = /[\u3400-\u9fff]/u;
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: { lang: "zh-CN", dataset: {} },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { languages: [], language: "" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  bindInternationalization();
  configureMessages({ "en-US": en });
});
afterEach(() => {
  bindInternationalization();
  configureMessages({});
  vi.unstubAllGlobals();
});

it("uses the site default only without a browser choice and preserves an explicit choice", () => {
  initializeLanguage("en-US");
  expect(getLocale()).toBe("en-US");
  expect(getLanguagePreference()).toBeUndefined();
  expect(t("保存")).toBe("Save");
  const feedback = "如邮箱符合条件，验证码已发送。";
  expect(authError(feedback)).toBe(en[feedback]);
  expect(authError("Invalid email verification code")).toBe(
    en["邮箱验证码不正确，请检查后重试。"],
  );
  expect(authError("toString")).toBe("toString");
  setLanguagePreference("zh-CN");
  expect(authError(feedback)).toBe(feedback);
  expect(authError("Invalid email verification code")).toBe(
    "邮箱验证码不正确，请检查后重试。",
  );
  setSiteLanguage("en-US");
  expect(getLocale()).toBe("zh-CN");
  initializeLanguage("en-US");
  expect(getLocale()).toBe("zh-CN");
  expect(localStorage.getItem("pluhub.language")).toBe("zh-CN");
  setSiteLanguage("zh-CN");
  expect(t("保存")).toBe("保存");
});
it("follows browser languages until explicitly changed and isolates guest and account choices", async () => {
  vi.stubGlobal("navigator", {
    languages: ["de-DE", "en-GB"],
    language: "de-DE",
  });
  initializeLanguage("zh-CN");
  expect(getLocale()).toBe("en-US");
  setLanguagePreference("zh-CN");
  setAccountLanguage("alice", null);
  expect(getLocale()).toBe("en-US");
  const save = vi.fn().mockResolvedValue(undefined);
  const stop = syncLanguagePreferences(save);
  setLanguagePreference("zh-CN");
  await vi.waitFor(() =>
    expect(save).toHaveBeenCalledWith("zh-CN", expect.any(AbortSignal)),
  );
  setLanguagePreference("auto");
  await vi.waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(null, expect.any(AbortSignal)),
  );
  expect(getLocale()).toBe("en-US");
  vi.stubGlobal("navigator", { languages: ["zh-Hant-TW"], language: "zh-TW" });
  window.dispatchEvent(new Event("languagechange"));
  expect(getLocale()).toBe("zh-CN");
  setLanguagePreference("en-US");
  setAccountLanguage();
  expect(getLocale()).toBe("zh-CN");
  expect(localStorage.getItem("pluhub.language")).toBe("zh-CN");
  stop();
});
it("resolves account language before browser cache and clears it when the account changes", () => {
  initializeLanguage("zh-CN");
  setLanguagePreference("en-US");
  setAccountLanguage("alice", "zh-CN");
  expect(getLocale()).toBe("zh-CN");
  setSiteLanguage("en-US");
  expect(getLocale()).toBe("zh-CN");
  setAccountLanguage("bob", null);
  expect(getLocale()).toBe("en-US");
  setAccountLanguage("bob", "zh-CN");
  setAccountLanguage();
  expect(getLocale()).toBe("en-US");
});
it("automatically serializes account saves and keeps the last rapid language choice", async () => {
  initializeLanguage("zh-CN");
  setAccountLanguage("alice", "zh-CN");
  let finish!: () => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const stop = syncLanguagePreferences(save);
  setLanguagePreference("en-US");
  setLanguagePreference("zh-CN");
  setLanguagePreference("en-US");
  expect(save).toHaveBeenCalledTimes(1);
  finish();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls.map((call) => call[0])).toEqual(["en-US", "en-US"]);
  expect(getLocale()).toBe("en-US");
  expect(localStorage.getItem("pluhub.language")).toBeNull();
  stop();
});
it("cancels old-account saves on logout and reports genuine save failures", async () => {
  initializeLanguage("zh-CN");
  setAccountLanguage("alice", "zh-CN");
  const onError = vi.fn();
  const save = vi.fn(
    (_locale: string, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );
  const stop = syncLanguagePreferences(save, onError);
  setLanguagePreference("en-US");
  setLanguagePreference("zh-CN");
  setAccountLanguage();
  await Promise.resolve();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]![1].aborted).toBe(true);
  expect(onError).not.toHaveBeenCalled();
  stop();
  setAccountLanguage("bob", "zh-CN");
  const failed = syncLanguagePreferences(async () => {
    throw Error("offline");
  }, onError);
  setLanguagePreference("en-US");
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(getLocale()).toBe("en-US");
  failed();
});
it("syncs the same account across tabs without overwriting a different account preference", () => {
  initializeLanguage("en-US");
  setAccountLanguage("alice", "zh-CN");
  const stop = syncLanguagePreferences();
  localStorage.setItem("pluhub.language", "en-US");
  const change = (id: string) =>
    window.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "pluhub.language.account",
        newValue: JSON.stringify({ id, language: "en-US" }),
      }),
    );
  change("bob");
  expect(getLocale()).toBe("zh-CN");
  change("alice");
  expect(getLocale()).toBe("en-US");
  stop();
});
it("switches safely without browser storage and ignores unsupported saved preferences", () => {
  localStorage.setItem("pluhub.language", "<script>bad</script>");
  initializeLanguage("en-US");
  expect(getLocale()).toBe("en-US");
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
    removeItem: () => {
      throw Error("blocked");
    },
  });
  initializeLanguage("zh-CN");
  expect(() => setLanguagePreference("en-US")).not.toThrow();
  expect(getLocale()).toBe("en-US");
  setLanguagePreference("bad" as any);
  setSiteLanguage("bad" as any);
  expect(getLocale()).toBe("en-US");
});
it("notifies separate plugin roots and synchronizes preferences across tabs", () => {
  initializeLanguage("zh-CN");
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = subscribeLanguage(first),
    stopSecond = subscribeLanguage(second),
    stopStorage = syncLanguagePreferences();
  setLanguagePreference("en-US");
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  localStorage.setItem("pluhub.language", "zh-CN");
  window.dispatchEvent(
    Object.assign(new Event("storage"), { key: "pluhub.language" }),
  );
  expect(getLocale()).toBe("zh-CN");
  expect(first).toHaveBeenCalledTimes(2);
  stopFirst();
  stopSecond();
  stopStorage();
  setLanguagePreference("en-US");
  expect(first).toHaveBeenCalledTimes(2);
});
it("interpolates without changing user text and allows plugin-owned SDK catalogs", () => {
  const model = "用户模型 <script>alert(1)</script>";
  expect(
    translateMessage(
      "en-US",
      "模型 {name}",
      { "en-US": { "模型 {name}": "Model {name}" } },
      { name: model },
    ),
  ).toBe("Model " + model);
  expect(translateMessage("en-US", "Unknown {value}", {}, { value: 0 })).toBe(
    "Unknown 0",
  );
  expect(translateMessage("en-US", "Unknown {missing}", {})).toBe(
    "Unknown {missing}",
  );
  expect(translateMessage("en-US", "toString", { "en-US": {} })).toBe(
    "toString",
  );
  expect(translateMessage("en-US", "__proto__", { "en-US": {} })).toBe(
    "__proto__",
  );
  const custom = vi.fn((source: string) => "Plugin: " + source);
  bindInternationalization({
    locale: "en-US",
    t: custom,
    subscribe: () => () => {},
  });
  expect(t("Hello")).toBe("Plugin: Hello");
  expect(custom).toHaveBeenCalledTimes(1);
});
it("has complete English messages and preserves interpolation variables", async () => {
  const missing: string[] = [];
  async function walk(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name !== "dist") await walk(file);
        continue;
      }
      if (
        !file.endsWith(".tsx") &&
        !["navigation.ts", "plugin-list.ts"].includes(item.name)
      )
        continue;
      const source = await readFile(file, "utf8"),
        ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ["tr", "t"].includes(node.expression.getText(ast)) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = node.arguments[0].text;
          if (cjk.test(key) && !Object.hasOwn(en, key)) missing.push(key);
        }
        if (
          ts.isJsxText(node) &&
          cjk.test(node.text) &&
          node.text.trim() !== "简体中文"
        )
          missing.push("Untranslated JSX: " + node.text.trim());
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  await walk(join(root, "lib/ui"));
  await walk(join(root, "plugins"));
  for (const directory of await readdir(join(root, "plugins"))) {
    const source = await readFile(
      join(root, "plugins", directory, "manifest.json"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!source) continue;
    const manifest = JSON.parse(source);
    for (const value of [
      manifest.name,
      manifest.description,
      manifest.ui?.title,
      ...(manifest.ui?.pages ?? []).map((page: any) => page.title),
    ])
      if (
        typeof value === "string" &&
        cjk.test(value) &&
        !Object.hasOwn(en, value)
      )
        missing.push(value);
  }
  expect([...new Set(missing)]).toEqual([]);
  const placeholders = (source: string) =>
    [...source.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [key, value] of Object.entries(en))
    expect(placeholders(value), key).toEqual(placeholders(key));
});
