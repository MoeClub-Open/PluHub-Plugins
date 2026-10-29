import { it, expect } from "vitest";
import {
  readPortal,
  publicPortal,
  localizePortal,
} from "../plugins/console/portal.js";
import { requestLocale } from "../lib/ui/locale.js";
import {
  onboardingChecks,
  setupRedirect,
} from "../plugins/console/onboarding.js";

it("validates bounded public content and does not mutate snapshots or publish disabled drafts", () => {
  const raw = {
    portal: {
      title: " My portal ",
      pages: [
        {
          slug: "help",
          title: " Help ",
          body: " <script>not executed</script> ",
        },
      ],
    },
  };
  const before = structuredClone(raw);
  const result = readPortal(raw);
  expect(result.title).toBe("My portal");
  expect(result.pages[0].body).toBe("<script>not executed</script>");
  expect(raw).toEqual(before);
  expect(publicPortal({ portal: { ...result, enabled: false } }).pages).toEqual(
    [],
  );
  expect(
    JSON.stringify(publicPortal({ portal: { ...result, enabled: false } })),
  ).not.toContain("not executed");
  for (const portal of [
    { primaryUrl: "javascript:alert(1)" },
    { docsUrl: "//evil.example" },
    { primaryUrl: "https://user:pass@evil.example" },
    { primaryUrl: "#/setup" },
    { features: Array(7).fill({ title: "a", description: "b" }) },
    { pages: [{ slug: "../admin", title: "A", body: "b" }] },
    {
      pages: [
        { slug: "a", title: "A", body: "b" },
        { slug: "a", title: "B", body: "c" },
      ],
    },
    { secretRefs: ["env:SECRET"] },
    { title: "x".repeat(161) },
  ])
    expect(() => readPortal({ portal })).toThrow();
});

it("localizes default and custom public content while sharing layout and hiding disabled translations", () => {
  const raw = {
    portal: {
      title: "中文标题",
      translations: {
        "en-US": {
          title: "English title",
          docsUrl: "https://docs.example/en",
          pages: [{ slug: "help", title: "Help", body: "English help" }],
        },
      },
    },
  };
  const before = structuredClone(raw);
  const portal = readPortal(raw);
  expect(localizePortal(readPortal({}), "en-US", "zh-CN").primaryLabel).toBe(
    "Browse models",
  );
  expect(localizePortal(portal, "en-US", "zh-CN")).toMatchObject({
    title: "English title",
    layout: "split",
    docsUrl: "https://docs.example/en",
  });
  expect(localizePortal(portal, "zh-CN", "zh-CN").title).toBe("中文标题");
  expect(raw).toEqual(before);
  expect(
    JSON.stringify(publicPortal({ portal: { ...portal, enabled: false } })),
  ).not.toContain("English help");
  for (const value of [
    { primaryUrl: "javascript:alert(1)" },
    { enabled: false },
    { pages: [{ slug: "../bad", title: "Help", body: "body" }] },
  ])
    expect(() =>
      readPortal({ portal: { translations: { "en-US": value } } }),
    ).toThrow();
  expect(
    requestLocale(
      new Request("https://test/", {
        headers: { "accept-language": "zh-CN;q=0,en-GB;q=0.9,zh-TW;q=0.5" },
      }),
      "zh-CN",
    ),
  ).toBe("en-US");
});

it("requires matching public origin and secure cookies before creating the administrator", () => {
  const config = {
    required: true,
    stage: "site" as const,
    publicOrigin: "https://hub.example",
    secureCookie: false,
  };
  expect(onboardingChecks(config, "https://other.example")).toEqual({
    origin: false,
    cookie: false,
  });
  config.secureCookie = true;
  expect(onboardingChecks(config, "https://hub.example")).toEqual({
    origin: true,
    cookie: true,
  });
});

it("routes first install separately and never reopens completed setup or redirects public previews", () => {
  for (const path of [
    "/",
    "/console",
    "/login",
    "/register",
    "/public/help",
    "/settings",
  ])
    expect(setupRedirect(true, path, false)).toBe("/setup");
  expect(setupRedirect(true, "/setup", false)).toBeUndefined();
  expect(setupRedirect(false, "/setup", false)).toBe("/login");
  expect(setupRedirect(false, "/setup", true)).toBe("/console");
  for (const path of ["/", "/public/help", "/console", "/settings"])
    expect(setupRedirect(false, path, true)).toBeUndefined();
});
