import { it, expect } from "vitest";
import { readPortal, publicPortal } from "../plugins/console/portal.js";
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
