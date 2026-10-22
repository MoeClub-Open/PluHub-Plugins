import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { PluginInstallPlan } from "@pluhub/contracts";
import { Dialog } from "../../lib/ui/components.js";
import { Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";

type Input = {
  path: string;
  sources: string[];
  config: Record<string, unknown>;
  dependencyConfigs: Record<string, Record<string, unknown>>;
};
export function Install({
  client,
  done,
}: {
  client: UIHost;
  done: () => void;
}) {
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [review, setReview] = React.useState<{
    plan: PluginInstallPlan;
    input: Input;
  }>();
  const [approved, setApproved] = React.useState<Record<string, boolean>>({});
  const additions =
    review?.plan.plugins.filter((plugin) => plugin.action === "install") ?? [];
  const authorized = additions.every(
    (plugin) => !plugin.permissions.length || approved[plugin.id],
  );
  return (
    <>
      <details className="card">
        <summary>{tr("安装本地插件")}</summary>
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            try {
              const fields = new FormData(event.currentTarget);
              const input: Input = {
                path: String(fields.get("path")),
                sources: String(fields.get("sources") ?? "")
                  .split("\n")
                  .map((value) => value.trim())
                  .filter(Boolean),
                config: JSON.parse(String(fields.get("config") || "{}")),
                dependencyConfigs: JSON.parse(
                  String(fields.get("dependencyConfigs") || "{}"),
                ),
              };
              const plan = await client.request<PluginInstallPlan>(
                "/api/host/install-plan",
                { method: "POST", body: JSON.stringify(input) },
              );
              setApproved({});
              setReview({ plan, input });
            } catch (error) {
              setMessage((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {tr("服务器插件目录或安装包")}
            <input name="path" required placeholder="/opt/plugins/example" />
          </label>
          <label>
            {tr("依赖来源，每行一个目录或安装包")}
            <textarea name="sources" placeholder="/opt/pluhub/plugins" />
          </label>
          <details className="full">
            <summary>{tr("初始配置")}</summary>
            <label>
              {tr("插件配置 JSON")}
              <textarea name="config" defaultValue="{}" spellCheck={false} />
            </label>
            <label>
              {tr("依赖插件配置 JSON")}
              <textarea
                name="dependencyConfigs"
                defaultValue="{}"
                spellCheck={false}
              />
            </label>
          </details>
          <div className="form-actions">
            <button disabled={busy}>
              {busy ? tr("正在解析…") : tr("检查依赖")}
            </button>
          </div>
        </form>
        <Notice message={message} />
      </details>
      {review && (
        <Dialog
          title={tr("确认插件与依赖")}
          close={() => {
            if (!busy) setReview(undefined);
          }}
        >
          <Notice message={message} />
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{tr("插件")}</th>
                  <th>{tr("版本")}</th>
                  <th>{tr("操作")}</th>
                  <th>{tr("权限授权")}</th>
                </tr>
              </thead>
              <tbody>
                {review.plan.plugins.map((plugin) => (
                  <tr key={plugin.id}>
                    <td title={[plugin.id, ...plugin.dependencies].join("\n")}>
                      {plugin.name}
                    </td>
                    <td>
                      <code title={plugin.sha256}>{plugin.version}</code>
                    </td>
                    <td>
                      {plugin.action === "keep" ? tr("复用已安装") : tr("安装")}
                    </td>
                    <td>
                      {plugin.action === "keep" ? (
                        tr("保持现有授权")
                      ) : plugin.permissions.length ? (
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={!!approved[plugin.id]}
                            aria-label={tr("允许 {0} 的权限", {
                              "0": plugin.name,
                            })}
                            onChange={(event) =>
                              setApproved({
                                ...approved,
                                [plugin.id]: event.target.checked,
                              })
                            }
                          />
                          {plugin.permissions.join(", ")}
                        </label>
                      ) : (
                        tr("无需额外权限")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              type="button"
              disabled={busy || !authorized}
              onClick={async () => {
                setBusy(true);
                setMessage("");
                try {
                  const permission = (id: string) =>
                    additions.find((plugin) => plugin.id === id)?.permissions ??
                    [];
                  await client.request("/api/host/install", {
                    method: "POST",
                    body: JSON.stringify({
                      ...review.input,
                      expectedPlan: review.plan.fingerprint,
                      grants: permission(review.plan.root),
                      dependencyGrants: Object.fromEntries(
                        additions
                          .filter((plugin) => plugin.id !== review.plan.root)
                          .map((plugin) => [plugin.id, permission(plugin.id)]),
                      ),
                    }),
                  });
                  setReview(undefined);
                  setMessage(tr("插件已安装"));
                  done();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr("正在安装…") : tr("确认安装")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
