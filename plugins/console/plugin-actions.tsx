import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Dialog } from "../../lib/ui/components.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { t } from "../../lib/ui/i18n.js";

export function PluginActions({
  plugin,
  host,
  changed,
  report,
}: {
  plugin: any;
  host: UIHost;
  changed: () => void;
  report: (message: string) => void;
}) {
  const [action, setAction] = React.useState<
    "enable" | "disable" | "uninstall"
  >();
  const [purge, setPurge] = React.useState(false),
    [busy, setBusy] = React.useState(false);
  const policy = plugin.lifecycle,
    enabled = plugin.enabled;
  const blocked = policy?.protected || policy?.dependents?.length > 0;
  const reason = policy?.protected
    ? t("基础设施")
    : policy?.dependents?.length
      ? t("被启用的插件依赖") +
        ": " +
        policy.dependents.map((p: any) => p.name).join(", ")
      : undefined;
  async function apply() {
    setBusy(true);
    try {
      const result = await host.request<any>(
        action === "uninstall"
          ? "/api/host/plugin-uninstall"
          : "/api/host/plugin-state",
        {
          method: "POST",
          body: JSON.stringify(
            action === "uninstall"
              ? { id: plugin.id, purgeData: purge }
              : { id: plugin.id, enabled: action === "enable" },
          ),
        },
      );
      if (result.cleanupPending?.length)
        report(t("插件已卸载，部分文件清理失败，请检查服务器权限"));
      setAction(undefined);
      changed();
    } catch (error) {
      report((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="ghost"
        disabled={!!(enabled && blocked)}
        title={reason}
        onClick={() => setAction(enabled ? "disable" : "enable")}
      >
        {enabled && policy?.protected
          ? t("基础设施")
          : enabled
            ? t("停用")
            : t("启用")}
      </button>
      <button
        className="ghost"
        disabled={!!blocked}
        title={reason}
        onClick={() => {
          setPurge(false);
          setAction("uninstall");
        }}
      >
        {t("卸载")}
      </button>
      {action && (
        <Dialog
          title={
            action === "uninstall"
              ? t("卸载插件")
              : action === "enable"
                ? t("启用插件")
                : t("停用插件")
          }
          close={() => {
            if (!busy) setAction(undefined);
          }}
        >
          <p>{plugin.name ?? plugin.id}</p>
          {action === "uninstall" && (
            <label className="checkbox">
              <Checkbox
                checked={purge}
                onCheckedChange={(v) => setPurge(v === true)}
              />
              {t("同时永久删除该插件的数据")}
            </label>
          )}
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setAction(undefined)}
            >
              {t("取消")}
            </button>
            <button
              className={action === "enable" ? "" : "danger"}
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? t("处理中…") : t("确认")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
