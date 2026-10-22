import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost, Extension } from "@pluhub/ui-sdk";
import { Icon } from "../../lib/ui/components.js";
import type { ThemeMode } from "./theme.js";
const usd = (value: number) =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 1_000_000);
export function AccountMenu({
  host,
  user,
  extensions,
  mode,
  change,
  logout,
  path,
}: {
  host: UIHost;
  user: any;
  extensions: Extension[];
  mode: ThemeMode;
  change: (mode: ThemeMode) => void;
  logout: () => Promise<void>;
  path: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [wallet, setWallet] = React.useState<any>();
  const [subscriptions, setSubscriptions] = React.useState<any[]>();
  const [error, setError] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const id = React.useId();
  const themeNames = {
    system: tr("跟随系统"),
    light: tr("浅色"),
    dark: tr("深色"),
  };
  const nextTheme =
    mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const has = (path: string) => extensions.some((e) => e.path === path);
  const billing = has("/billing"),
    commerce = has("/commerce");
  React.useEffect(() => {
    setOpen(false);
  }, [path, user.id]);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setWallet(undefined);
    setSubscriptions(undefined);
    setError("");
    Promise.all([
      billing
        ? host.request("/api/plugins/official.billing/wallet")
        : undefined,
      commerce
        ? host.request<any[]>("/api/plugins/official.commerce/subscriptions")
        : undefined,
    ]).then(
      ([wallet, subscriptions]) => {
        if (live) {
          setWallet(wallet);
          setSubscriptions(subscriptions);
        }
      },
      () => {
        if (live) setError(tr("暂时无法加载余额或订阅"));
      },
    );
    return () => {
      live = false;
    };
  }, [open, billing, commerce, refresh, user.id, host]);
  const active = subscriptions?.filter(
    (s) =>
      ["active", "cancel_at_period_end"].includes(s.status) &&
      s.period_end > Date.now(),
  );
  return (
    <div
      className="account-menu-root"
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <div className="account">
        <button
          className="account-trigger"
          ref={trigger}
          aria-label={tr("打开账号菜单：") + user.username}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="avatar">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-identity">
            <strong>{user.username}</strong>
            <small>
              {user.role === "admin"
                ? tr("管理员")
                : user.parentId
                  ? tr("企业子账号")
                  : user.accountType === "enterprise"
                    ? tr("企业主账号")
                    : tr("个人账号")}
            </small>
          </span>
          <Icon name="chevrons" size={14} />
        </button>
        <button
          className="ghost icon-button"
          aria-label={
            tr("颜色模式：") +
            themeNames[mode] +
            tr("，点击切换为") +
            themeNames[nextTheme]
          }
          title={tr("颜色模式：") + themeNames[mode]}
          onClick={() => change(nextTheme)}
        >
          <Icon
            name={
              mode === "system" ? "monitor" : mode === "dark" ? "moon" : "sun"
            }
            size={17}
          />
        </button>
      </div>
      {open && (
        <section
          id={id}
          className="account-popover"
          role="region"
          aria-label={tr("账号菜单")}
        >
          <div className="account-popover-heading">
            <strong>{user.username}</strong>
            <small>
              {user.role === "admin"
                ? tr("管理员")
                : user.parentId
                  ? tr("企业子账号")
                  : user.accountType === "enterprise"
                    ? tr("企业主账号")
                    : tr("个人账号")}
            </small>
          </div>
          {(billing || commerce) && (
            <div className="account-wallet" aria-live="polite">
              {error ? (
                <div className="account-load-error">
                  {error}
                  <button
                    className="ghost"
                    onClick={() => setRefresh((v) => v + 1)}
                  >
                    {tr("重试")}
                  </button>
                </div>
              ) : (
                <>
                  {billing && (
                    <>
                      <span>{tr("可用余额 · USD")}</span>
                      <strong>
                        {wallet ? usd(wallet.available) : tr("加载中…")}
                      </strong>
                      {wallet && (
                        <small>
                          {tr("总余额")}
                          {usd(wallet.balance)} {tr("· 冻结")}
                          {usd(wallet.held)}
                        </small>
                      )}
                    </>
                  )}
                  {commerce && (
                    <small>
                      {active
                        ? active.length
                          ? tr("{0} 项有效订阅", {
                              "0": textValue(active.length),
                            })
                          : tr("暂无有效订阅")
                        : tr("正在加载订阅…")}
                    </small>
                  )}
                </>
              )}
            </div>
          )}
          <div className="account-menu-links">
            {has("/account") && (
              <a href="#/account">
                <Icon name="users" size={16} />
                {tr("账号与安全")}
              </a>
            )}
            {has("/auth") && (
              <a href="#/auth">
                <Icon name="key" size={16} />
                {tr("API 密钥")}
              </a>
            )}
            {(billing || commerce) && (
              <a href={billing ? "#/billing" : "#/commerce"}>
                <Icon name="money" size={16} />
                {tr("钱包与订阅")}
              </a>
            )}
            {has("/tickets") && (
              <a href="#/tickets">
                <Icon name="support" size={16} />
                {tr("我的工单")}
              </a>
            )}
          </div>
          <button
            className="account-signout"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await logout();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="logout" size={16} />
            {busy ? tr("正在退出…") : tr("退出登录")}
          </button>
        </section>
      )}
    </div>
  );
}
