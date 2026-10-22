import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Select } from "../../lib/ui/select.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
export function UserPricing({
  host,
  userId,
}: {
  host: UIHost;
  userId: string;
}) {
  const policy = useLoad<any>(
    () =>
      host.request(
        "/api/plugins/official.billing/admin/pricing-user?userId=" +
          encodeURIComponent(userId),
      ),
    [userId],
  );
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!policy.data) return <Notice message={policy.error} />;
  return (
    <form
      className="card"
      key={JSON.stringify(policy.data)}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setMessage("");
        try {
          await host.request(
            "/api/plugins/official.billing/admin/pricing-user",
            {
              method: "PUT",
              body: JSON.stringify({
                userId,
                group: f.get("group"),
                userMultiplier: Number(f.get("userMultiplier")),
                reason: f.get("reason"),
              }),
            },
          );
          policy.reload();
          setMessage(tr("已保存"));
        } catch (error) {
          setMessage((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>{tr("计费分组与倍率")}</h2>
      <Notice message={message || policy.error} />
      <div className="form-grid">
        <label>
          {tr("计费分组")}
          <Select name="group" defaultValue={policy.data.group}>
            {Object.entries(policy.data.groups).map(
              ([id, g]: [string, any]) => (
                <option key={id} value={id}>
                  {g.name} · ×{g.multiplier}
                </option>
              ),
            )}
          </Select>
        </label>
        <label>
          {tr("用户倍率")}
          <input
            name="userMultiplier"
            type="number"
            min="0"
            max="1000"
            step="any"
            required
            defaultValue={policy.data.userMultiplier}
          />
        </label>
        <label>
          {tr("审计原因")}
          <input name="reason" required maxLength={256} />
        </label>
      </div>
      <button disabled={busy}>{tr("保存并应用")}</button>
    </form>
  );
}
