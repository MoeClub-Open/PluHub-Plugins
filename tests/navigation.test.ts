import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  navigation,
  searchSettings,
  paymentAdapterSelection,
  paymentMethodsPath,
  verificationPath,
  verificationTab,
  consoleNavigation,
  loginDestination,
  authLink,
  channelSettingsDestination,
} from "../plugins/console/navigation.js";

it("returns to the selected model after authentication and rejects external or management destinations", () => {
  const target = "/playground?model=provider%2Fmodel";
  const hash = "/login?next=" + encodeURIComponent(target);
  expect(loginDestination(hash)).toBe(target);
  expect(authLink("register", hash)).toBe(
    "#/register?next=" + encodeURIComponent(target),
  );
  expect(loginDestination(authLink("register", hash))).toBe(target);
  for (const value of [
    "https://example.com",
    "//example.com",
    "/plugins",
    "/settings",
    "/playground#other",
    "/playground\n",
    "/playground?" + "x".repeat(2048),
  ])
    expect(loginDestination("/login?next=" + encodeURIComponent(value))).toBe(
      "/console",
    );
  expect(authLink("login", "/register")).toBe("#/login");
});

// Exercise the actual plugin declarations, including personal + admin pages.
const pages = [
  "console",
  "auth",
  "commerce",
  "billing",
  "payments-epay",
  "payments-stripe",
  "mailer",
  "turnstile",
  "byok",
  "users",
  "observability",
  "ai-router",
  "rate-limit",
  "token-speed",
  "auto-router",
].flatMap((name) => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../plugins/" + name + "/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  return [manifest.ui, ...(manifest.ui.pages ?? [])].map((page, index) => ({
    ...page,
    id: index === 0 ? manifest.id : manifest.id + ":page:" + (index - 1),
    url: "/extensions/" + manifest.id + "/ui.js",
  }));
});

it("separates global limits from channel execution settings", () => {
  const nav = navigation(pages, true, "/channels");
  expect(nav.section?.id).toBe("routing");
  expect(nav.section?.pages.map((p) => p.path)).toEqual([
    "/channels",
    "/settings/traffic",
    "/settings/user-channels",
  ]);
  expect(nav.searchEntries.map((p) => p.path)).not.toEqual(
    expect.arrayContaining(["/rate-limit", "/token-speed", "/auto-router"]),
  );
  expect(channelSettingsDestination("/rate-limit")).toBe("/settings/traffic");
  expect(channelSettingsDestination("/token-speed")).toBe("/settings/traffic");
  expect(channelSettingsDestination("/auto-router")).toBe(
    "/channels?panel=routing",
  );
  expect(channelSettingsDestination("/billing")).toBeUndefined();
  expect(channelSettingsDestination("/settings/traffic")).toBeUndefined();
  for (const query of ["限流", "TPS", "自动路由"])
    expect(
      searchSettings(nav.sections, query).flatMap((section) =>
        section.pages.map((page) => page.path),
      ),
    ).toEqual(
      query === "自动路由" ? ["/channels"] : ["/channels", "/settings/traffic"],
    );
  expect(
    navigation(
      pages.filter((p) => p.path !== "/channels"),
      true,
      "/settings/traffic",
    ).selected?.path,
  ).toBe("/settings/traffic");
});

it("groups actual payment and identity settings while preserving personal pages and third-party extensions", () => {
  const all = [
    ...pages,
    {
      id: "third.party",
      title: "Custom",
      path: "/custom",
      url: "/custom.js",
      group: "custom",
    },
  ];
  const nav = navigation(all, true, "/payments-epay");
  expect(navigation(all, true, "/settings/branding").section?.id).toBe("site");
  expect(navigation(all, false, "/settings/branding").selected).toBeUndefined();
  expect(nav.section?.id).toBe("payments");
  expect(nav.section?.pages.map((p) => p.path)).toEqual([
    paymentMethodsPath,
    "/settings/commerce",
    "/settings/billing",
  ]);
  expect(nav.standalone.map((p) => p.path)).toEqual(
    expect.arrayContaining(["/auth", "/commerce", "/billing", "/custom"]),
  );
  expect(navigation(all, false, "/settings/auth").selected).toBeUndefined();
  expect(navigation(all, false, "/settings/payments").selected).toBeUndefined();
  expect(navigation(all, false, "/auth").allowed.map((p) => p.path)).toEqual([
    "/auth",
    "/account",
    "/commerce",
    "/billing",
    "/byok",
    "/activity",
  ]);
});

it("groups enabled wallet pages once and preserves account and third-party navigation on plugin removal", () => {
  const allowed = navigation(pages, false, "/commerce").standalone;
  const grouped = consoleNavigation(allowed, "/commerce");
  expect(grouped.account.filter((e) => e.title === "钱包与订阅")).toHaveLength(
    1,
  );
  expect(grouped.walletActive).toBe(true);
  expect(grouped.profile?.path).toBe("/account");
  expect(grouped.other).toEqual([]);
  const remaining = consoleNavigation(
    [
      ...allowed.filter((e) => e.path !== "/billing"),
      { id: "third", path: "/custom", title: "Custom", url: "/ui.js" },
    ],
    "/commerce",
  );
  expect(remaining.account.find((e) => e.title === "钱包与订阅")?.path).toBe(
    "/commerce",
  );
  expect(remaining.other.map((e) => e.path)).toEqual(["/custom"]);
});

it("keeps the administrator's personal navigation identical to users with only one management search entry", () => {
  const user = navigation(pages, false, "/console");
  const admin = navigation(pages, true, "/console");
  expect(admin.personal).toEqual(user.personal);
  expect(admin.managementMode).toBe(false);
  expect(
    admin.searchEntries.filter(
      (e) => !user.searchEntries.some((u) => u.path === e.path),
    ),
  ).toEqual([{ path: "/admin", title: "管理后台" }]);
  for (const path of [
    "/users",
    "/plugins",
    "/settings",
    "/settings/branding",
    "/admin/activity",
  ])
    expect(admin.searchEntries.some((e) => e.path === path)).toBe(false);
});

it("keeps management pages and legacy links in the backend and rejects them for ordinary users", () => {
  for (const path of [
    "/admin",
    "/users",
    "/plugins",
    "/status",
    "/audit",
    "/settings",
    "/settings/branding",
    "/mailer",
    "/payments-epay",
  ]) {
    const admin = navigation(pages, true, path);
    expect(admin.managementMode, path).toBe(true);
    expect(admin.searchEntries.some((e) => e.path === "/auth")).toBe(false);
    const user = navigation(pages, false, path);
    expect(user.managementMode, path).toBe(false);
    expect(user.selected, path).toBeUndefined();
    expect(user.searchEntries.some((e) => e.path === "/admin")).toBe(false);
  }
  expect(
    navigation(pages, true, "/users").management.map((e) => e.path),
  ).toContain("/users");
});

it("keeps the site-wide activity page in the foreground", () => {
  for (const admin of [true, false]) {
    const nav = navigation(pages, admin, "/activity");
    expect(nav.managementMode).toBe(false);
    expect(nav.selected?.path).toBe("/activity");
  }
});

it("keeps public third-party pages in the foreground and private third-party pages in the backend", () => {
  const extra = [
    {
      id: "custom.public",
      title: "Public",
      path: "/custom-public",
      url: "/public.js",
      public: true,
      group: "routing",
    },
    {
      id: "custom.private",
      title: "Private",
      path: "/custom-private",
      url: "/private.js",
    },
  ];
  for (const admin of [false, true]) {
    const nav = navigation([...pages, ...extra], admin, "/custom-public");
    expect(nav.managementMode).toBe(false);
    expect(nav.personal.map((e) => e.path)).toContain("/custom-public");
    expect(nav.personal.map((e) => e.path)).not.toContain("/custom-private");
  }
  const backend = navigation([...pages, ...extra], true, "/custom-private");
  expect(backend.managementMode).toBe(true);
  expect(backend.management.map((e) => e.path)).toContain("/custom-private");
});

it("places the site leaderboard in model services for ordinary users and removes it when stopped", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../plugins/leaderboard/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const extension = {
    id: manifest.id,
    ...manifest.ui,
    url: "/extensions/official.leaderboard/ui.js",
  };
  const available = navigation([...pages, extension], false, "/leaderboard");
  expect(available.selected?.path).toBe("/leaderboard");
  const grouped = consoleNavigation(available.standalone, "/leaderboard");
  expect(grouped.tools.map((e) => e.path)).toContain("/leaderboard");
  expect(grouped.other.map((e) => e.path)).not.toContain("/leaderboard");
  expect(
    consoleNavigation(pages, "/leaderboard").tools.map((e) => e.path),
  ).not.toContain("/leaderboard");
});

it("keeps first-install setup out of navigation and search, including legacy extension metadata", () => {
  expect(pages.some((page) => page.path === "/setup")).toBe(false);
  const legacy = {
    id: "official.console:legacy-setup",
    title: "初始化向导",
    path: "/setup",
    url: "/ui.js",
    group: "site",
    public: false,
  };
  const nav = navigation([...pages, legacy], true, "/settings");
  expect(nav.allowed.some((page) => page.path === "/setup")).toBe(false);
  expect(
    nav.sections
      .flatMap((section) => section.pages)
      .some((page) => page.path === "/setup"),
  ).toBe(false);
  expect(searchSettings(nav.sections, "初始化")).toEqual([]);
  expect(
    nav.sections
      .find((section) => section.id === "site")
      ?.pages.map((page) => page.path),
  ).toEqual(["/settings/branding", "/settings/portal"]);
});

it("falls back to remaining providers and drops empty groups when plugins are stopped", () => {
  const enabled = pages.filter(
    (p) => !p.id.startsWith("official.payments-stripe"),
  );
  const remaining = navigation(enabled, true, "/settings/payments");
  expect(remaining.selected?.path).toBe(paymentMethodsPath);
  expect(remaining.paymentAdapters.map((p) => p.path)).toEqual([
    "/payments-epay",
  ]);
  const stopped = enabled.filter((p) => p.group !== "payment-adapters");
  expect(navigation(stopped, true, paymentMethodsPath).paymentAdapters).toEqual(
    [],
  );
  expect(navigation(stopped, true, paymentMethodsPath).selected?.path).toBe(
    paymentMethodsPath,
  );
  expect(navigation(stopped, true, "/payments-epay").selected).toBeUndefined();
});

it("searches only available settings with case-insensitive multiword terms and no private results for ordinary users", () => {
  const admin = navigation(pages, true, "/settings");
  expect(
    searchSettings(admin.sections, "  STRIPE 支付  ")
      .flatMap((section) => section.pages)
      .map((page) => page.path),
  ).toEqual([paymentMethodsPath]);
  expect(
    searchSettings(admin.sections, "登录")
      .flatMap((section) => section.pages)
      .some((page) => page.path === verificationPath),
  ).toBe(true);
  expect(searchSettings(admin.sections, "does-not-exist")).toEqual([]);
  expect(
    searchSettings(navigation(pages, false, "/settings").sections, "stripe"),
  ).toEqual([]);
});

it("aggregates all verification services and keeps system management available only to admins", () => {
  const admin = navigation(pages, true, "/turnstile");
  expect(admin.verificationProviders).toHaveLength(3);
  expect(admin.selected?.path).toBe(verificationPath);
  expect(admin.section?.pages.map((p) => p.path)).toEqual([
    verificationPath,
    "/settings/access-keys",
  ]);
  expect(admin.allowed.some((p) => p.group === "verification-services")).toBe(
    false,
  );
  for (const [path, tab] of [
    ["/settings/auth", "account"],
    ["/mailer", "email"],
    ["/turnstile", "captcha"],
  ]) {
    expect(navigation(pages, true, path!).selected?.path).toBe(
      verificationPath,
    );
    expect(verificationTab(path!)).toBe(tab);
  }
  expect(verificationTab(verificationPath + "?tab=passkeys")).toBe("passkeys");
  for (const path of ["/plugins", "/status", "/audit"]) {
    expect(navigation(pages, true, path).section?.id).toBe("system");
    expect(navigation(pages, false, path).selected).toBeUndefined();
  }
  expect(
    searchSettings(admin.sections, "Turnstile")
      .flatMap((s) => s.pages)
      .map((p) => p.path),
  ).toEqual([verificationPath]);
  expect(navigation(pages, false, verificationPath).selected).toBeUndefined();
});

it("keeps tenant resource management separate from personal pages and available only to administrators", () => {
  for (const [path, group] of [
    ["/settings/access-keys", "security"],
    ["/settings/user-channels", "routing"],
    ["/audit", "system"],
  ]) {
    const admin = navigation(pages, true, path);
    expect(admin.selected?.path).toBe(path);
    expect(admin.section?.id).toBe(group);
    expect(navigation(pages, false, path).selected).toBeUndefined();
  }
  expect(navigation(pages, false, "/byok").selected?.path).toBe("/byok");
});

it("keeps one payment menu for many third-party adapters and resolves both nested and old links", () => {
  const thirdParty = Array.from({ length: 20 }, (_, index) => ({
    id: "third.payment." + index,
    title: "Provider " + index,
    path: "/third-payment-" + index,
    url: "/third/payment-" + index + ".js",
    group: "payment-adapters",
    public: true,
  }));
  const all = [...pages, ...thirdParty];
  const nav = navigation(all, true, thirdParty[0].path);
  expect(nav.paymentAdapters).toHaveLength(22);
  expect(nav.section?.pages.map((page) => page.path)).toEqual([
    paymentMethodsPath,
    "/settings/commerce",
    "/settings/billing",
  ]);
  expect(nav.selected?.path).toBe(paymentMethodsPath);
  expect(nav.allowed.some((page) => page.group === "payment-adapters")).toBe(
    false,
  );
  expect(nav.standalone.some((page) => page.group === "payment-adapters")).toBe(
    false,
  );
  expect(
    paymentAdapterSelection(nav.paymentAdapters, thirdParty[0].path)?.id,
  ).toBe(thirdParty[0].id);
  expect(
    paymentAdapterSelection(
      nav.paymentAdapters,
      paymentMethodsPath + "?adapter=third.payment.0",
    )?.id,
  ).toBe(thirdParty[0].id);
  expect(
    paymentAdapterSelection(nav.paymentAdapters, paymentMethodsPath),
  ).toBeUndefined();
  expect(
    paymentAdapterSelection(
      nav.paymentAdapters.filter((p) => p.id !== thirdParty[0].id),
      paymentMethodsPath + "?adapter=third.payment.0",
    ),
  ).toBeUndefined();
  expect(navigation(all, false, thirdParty[0].path).selected).toBeUndefined();
  expect(navigation(all, false, paymentMethodsPath).paymentAdapters).toEqual(
    [],
  );
});
