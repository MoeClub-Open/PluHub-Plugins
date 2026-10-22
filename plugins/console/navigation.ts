import { t as tr } from "../../lib/ui/i18n.js";
import type { Extension } from "@pluhub/ui-sdk";

export function loginDestination(hash: string) {
  const next = new URLSearchParams(hash.split("?").slice(1).join("?")).get(
    "next",
  );
  return next &&
    next.length <= 2048 &&
    /^\/(?:playground|models|auth)(?:\?[^#\u0000-\u001f]*)?$/.test(next)
    ? next
    : "/console";
}

export function authLink(page: "login" | "register", hash: string) {
  const next = loginDestination(hash);
  return (
    "#/" +
    page +
    (next === "/console" ? "" : "?next=" + encodeURIComponent(next))
  );
}

export const paymentMethodsPath = "/settings/payment-methods";
export const paymentAdapterGroup = "payment-adapters";
export const verificationPath = "/settings/verification";
export const verificationProviderGroup = "verification-services";
export const channelSettingsGroup = "channel-settings";
export function channelSettingsDestination(path: string) {
  return path === "/rate-limit" ||
    path === "/token-speed" ||
    path === "/settings/traffic"
    ? "/ai-router?panel=limits"
    : path === "/auto-router"
      ? "/ai-router?panel=routing"
      : undefined;
}
export const systemPages: Extension[] = [
  {
    id: "console:logs",
    get title() {
      return tr("运行日志");
    },
    path: "/logs",
    url: "",
    group: "system",
    order: 25,
  },
  {
    id: "console:audit",
    get title() {
      return tr("管理操作记录");
    },
    path: "/audit",
    url: "",
    group: "system",
    order: 30,
  },
  {
    id: "console:plugins",
    get title() {
      return tr("插件管理");
    },
    path: "/plugins",
    url: "",
    group: "system",
    order: 10,
  },
  {
    id: "console:status",
    get title() {
      return tr("系统状态");
    },
    path: "/status",
    url: "",
    group: "system",
    order: 20,
  },
];
export function verificationTab(hash: string) {
  const [path, query] = hash.split("?");
  const legacy: Record<string, string> = {
    "/settings/auth": "account",
    "/mailer": "email",
    "/turnstile": "captcha",
  };
  return legacy[path!] ?? new URLSearchParams(query).get("tab") ?? "account";
}
type SettingsPage = Extension & { searchTerms?: string };

export function paymentAdapterSelection(adapters: Extension[], hash: string) {
  const [path, query] = hash.split("?");
  const id = new URLSearchParams(query).get("adapter");
  return adapters.find((adapter) =>
    path === paymentMethodsPath ? adapter.id === id : adapter.path === path,
  );
}

export const groups = [
  {
    id: "site",
    get title() {
      return tr("站点与品牌");
    },
    icon: "settings",
    get description() {
      return tr("设置站点标识、外观、登录文案与联系信息。");
    },
  },
  {
    id: "routing",
    get title() {
      return tr("渠道与路由");
    },
    icon: "channels",
    get description() {
      return tr("配置上游渠道、模型路由与功能工作流。");
    },
  },
  {
    id: "payments",
    get title() {
      return tr("支付与商业");
    },
    icon: "money",
    get description() {
      return tr("统一配置支付方式、商品订阅与计费。");
    },
  },
  {
    id: "security",
    get title() {
      return tr("安全与验证");
    },
    icon: "shield",
    get description() {
      return tr("管理站点登录注册、邮件与验证码服务。");
    },
  },
  {
    id: "system",
    get title() {
      return tr("系统管理");
    },
    icon: "settings",
    get description() {
      return tr("管理插件安装与启停，查看宿主和网关的运行状态。");
    },
  },
];

export function navigation(
  extensions: Extension[],
  admin: boolean,
  path: string,
) {
  const available = extensions.filter(
    (e) =>
      e.id !== "official.console" && e.path !== "/setup" && (admin || e.public),
  );
  const paymentAdapters = admin
    ? available
        .filter((e) => e.group === paymentAdapterGroup)
        .sort(
          (a, b) =>
            (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
        )
    : [];
  const paymentMethods: SettingsPage = {
    id: "console:payment-methods",
    title: tr("支付方式"),
    path: paymentMethodsPath,
    url: "",
    group: "payments",
    order: 10,
    searchTerms: paymentAdapters.map((adapter) => adapter.title).join(" "),
  };
  const verificationProviders = admin
    ? available
        .filter((e) => e.group === verificationProviderGroup)
        .sort(
          (a, b) =>
            (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
        )
    : [];
  const verification: SettingsPage = {
    id: "console:verification",
    title: tr("登录与验证"),
    path: verificationPath,
    url: "",
    group: "security",
    order: 10,
    searchTerms:
      tr(
        "注册 邮箱 邮件 SMTP Turnstile 验证码 人机验证 TOTP Passkey FIDO2 硬件安全密钥 ",
      ) + verificationProviders.map((e) => e.title).join(" "),
  };
  const allowed: SettingsPage[] = available
    .filter(
      (e) =>
        e.group !== paymentAdapterGroup &&
        e.group !== verificationProviderGroup &&
        (e.group !== channelSettingsGroup ||
          !available.some((p) => p.path === "/ai-router")),
    )
    .map((entry) =>
      entry.path === "/ai-router"
        ? {
            ...entry,
            searchTerms: [
              tr("流程图"),
              tr("请求限流"),
              tr("输出 TPS"),
              tr("自动路由"),
              ...available
                .filter((e) => e.group === channelSettingsGroup)
                .map((e) => e.title),
            ].join(" "),
          }
        : entry,
    );
  if (admin) allowed.push(paymentMethods, verification, ...systemPages);
  const sections = admin
    ? groups
        .map((group) => ({
          ...group,
          path: "/settings/" + group.id,
          pages: allowed
            .filter((e) => !e.public && e.group === group.id)
            .sort(
              (a, b) =>
                (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
            ),
        }))
        .filter((group) => group.pages.length)
    : [];
  const selected =
    allowed.find((e) => e.path === path) ??
    (verificationProviders.some((provider) => provider.path === path)
      ? verification
      : undefined) ??
    (paymentAdapters.some((adapter) => adapter.path === path)
      ? paymentMethods
      : undefined) ??
    sections.find((group) => group.path === path)?.pages[0];
  const section = sections.find((group) => group.pages.includes(selected!));
  const standalone = allowed.filter(
    (e) => !sections.some((group) => group.pages.includes(e)),
  );
  const personal = allowed.filter((e) => e.public);
  const management = standalone.filter((e) => !e.public);
  const managementMode =
    admin &&
    (path === "/admin" ||
      path === "/settings" ||
      !!section ||
      (!!selected && !selected.public));
  const searchEntries = managementMode
    ? [
        { path: "/admin", title: tr("全站总览") },
        { path: "/settings", title: tr("系统设置") },
        ...allowed.filter((e) => !e.public),
      ]
    : [
        { path: "/console", title: tr("总览") },
        ...personal,
        ...(admin ? [{ path: "/admin", title: tr("管理后台") }] : []),
      ];
  return {
    allowed,
    sections,
    selected,
    section,
    standalone,
    paymentAdapters,
    verificationProviders,
    personal,
    management,
    managementMode,
    searchEntries,
  };
}

export type SettingsSection = ReturnType<typeof navigation>["sections"][number];

/** Group enabled public extensions without duplicating wallet or account links. */
export function consoleNavigation(extensions: Extension[], path: string) {
  const pick = (paths: string[]) =>
    paths.flatMap((p) => extensions.filter((e) => e.path === p));
  const tools = pick(["/models", "/playground", "/activity", "/leaderboard"]);
  const wallet = pick(["/billing", "/commerce"]);
  const account = pick(["/auth", "/byok", "/tickets"]);
  if (wallet.length) account.push({ ...wallet[0]!, title: tr("钱包与订阅") });
  const profile = extensions.find((e) => e.path === "/account");
  const managed = new Set(
    [...tools, ...account, ...wallet, ...(profile ? [profile] : [])].map(
      (e) => e.path,
    ),
  );
  return {
    tools,
    account,
    wallet,
    profile,
    walletActive: wallet.some((e) => e.path === path),
    other: extensions.filter((e) => !managed.has(e.path)),
  };
}

export function searchSettings(sections: SettingsSection[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sections
    .map((section) => ({
      ...section,
      pages: section.pages.filter((page) => {
        const text = [
          section.title,
          section.description,
          page.title,
          page.path,
          page.id,
          page.searchTerms,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((section) => section.pages.length > 0);
}
