import React from "react";
import type { ServiceGroup, Upstream } from "@pluhub/contracts/ai";
import type { UIHost } from "@pluhub/ui-sdk";
import { Dialog, Icon } from "../../lib/ui/components.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { serviceGroups } from "./groups.js";

export function Groups({
  host,
  groups,
  upstreams,
  save,
  busy,
}: {
  host: UIHost;
  groups?: Record<string, ServiceGroup>;
  upstreams: Record<string, Upstream>;
  save: (
    update: (r: { groups?: Record<string, ServiceGroup> }) => void,
  ) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = React.useState<{
    id: string;
    group: ServiceGroup;
  }>();
  const [message, setMessage] = React.useState("");
  const restricted = !!editing?.group.userIds;
  const users = useLoad<{ id: string; username: string }[]>(
    () =>
      restricted
        ? host.request("/api/plugins/official.users/users")
        : Promise.resolve([]),
    [restricted],
  );
  const all = serviceGroups({ groups });
  const patch = (value: Partial<ServiceGroup>) =>
    setEditing(
      (current) =>
        current && { ...current, group: { ...current.group, ...value } },
    );
  return (
    <>
      <div className="list-toolbar">
        <button
          disabled={busy}
          onClick={() => {
            setMessage("");
            setEditing({
              id: crypto.randomUUID(),
              group: { name: "", channelIds: [], multiplier: 1 },
            });
          }}
        >
          <Icon name="plus" size={15} />
          {tr("添加分组")}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("使用分组")}</th>
              <th>{tr("可用渠道")}</th>
              <th>{tr("分组倍率")}</th>
              <th>{tr("访问权限")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(all).map(([id, group]) => (
              <tr key={id}>
                <td>{group.name}</td>
                <td>
                  {group.channelIds
                    ? group.channelIds
                        .map((id) => upstreams[id]?.name ?? id)
                        .join("、") || tr("无可用渠道")
                    : tr("全部平台渠道")}
                </td>
                <td>×{group.multiplier ?? 1}</td>
                <td>
                  {group.userIds
                    ? tr("指定用户") + " · " + group.userIds.length
                    : tr("全部用户")}
                </td>
                <td>{tr(group.enabled === false ? "已停用" : "已启用")}</td>
                <td>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      setMessage("");
                      setEditing({ id, group: structuredClone(group) });
                    }}
                  >
                    {tr("编辑")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Dialog
          title={tr(
            editing.id !== "default" && !groups?.[editing.id]
              ? "添加使用分组"
              : "编辑使用分组",
          )}
          close={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <Notice message={message || users.error} />
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await save((r) => {
                  r.groups = { ...r.groups, [editing.id]: editing.group };
                });
                setEditing(undefined);
              } catch (error) {
                setMessage((error as Error).message);
              }
            }}
          >
            <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
              <div className="form-grid">
                <label>
                  {tr("分组名称")}
                  <input
                    required
                    maxLength={128}
                    value={editing.group.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
                <label>
                  {tr("分组倍率")}
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="any"
                    required
                    value={editing.group.multiplier ?? 1}
                    onChange={(e) =>
                      patch({ multiplier: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="checkbox">
                  <Checkbox
                    checked={editing.group.enabled !== false}
                    onCheckedChange={(value) =>
                      patch({ enabled: value === true })
                    }
                  />
                  {tr("启用分组")}
                </label>
                <fieldset className="full">
                  <legend>{tr("可用渠道")}</legend>
                  {editing.id === "default" && (
                    <label className="checkbox">
                      <Checkbox
                        checked={!editing.group.channelIds}
                        onCheckedChange={(v) =>
                          patch({ channelIds: v ? undefined : [] })
                        }
                      />
                      {tr("全部平台渠道")}
                    </label>
                  )}
                  {Object.entries(upstreams).map(([id, channel]) => (
                    <label className="checkbox" key={id}>
                      <Checkbox
                        checked={
                          !editing.group.channelIds ||
                          editing.group.channelIds.includes(id)
                        }
                        onCheckedChange={(value) => {
                          const current =
                            editing.group.channelIds ?? Object.keys(upstreams);
                          patch({
                            channelIds: value
                              ? [...current, id]
                              : current.filter((item) => item !== id),
                          });
                        }}
                      />
                      {channel.name || id}
                      {channel.enabled === false ? " · " + tr("已停用") : ""}
                    </label>
                  ))}
                  {editing.group.channelIds
                    ?.filter((id) => !upstreams[id])
                    .map((id) => (
                      <label className="checkbox" key={id}>
                        <Checkbox
                          checked
                          onCheckedChange={() =>
                            patch({
                              channelIds: editing.group.channelIds!.filter(
                                (item) => item !== id,
                              ),
                            })
                          }
                        />
                        {id} · {tr("不可用")}
                      </label>
                    ))}
                </fieldset>
                <label className="full">
                  {tr("访问权限")}
                  <Select
                    value={editing.group.userIds ? "restricted" : "public"}
                    onChange={(e) =>
                      patch({
                        userIds:
                          e.target.value === "restricted" ? [] : undefined,
                      })
                    }
                  >
                    <option value="public">{tr("全部用户")}</option>
                    <option value="restricted">{tr("指定用户")}</option>
                  </Select>
                </label>
                {editing.group.userIds && (
                  <fieldset className="full">
                    <legend>{tr("允许使用的用户")}</legend>
                    {[
                      ...(users.data ?? []),
                      ...editing.group.userIds
                        .filter((id) => !users.data?.some((u) => u.id === id))
                        .map((id) => ({ id, username: id })),
                    ].map((user) => (
                      <label className="checkbox" key={user.id}>
                        <Checkbox
                          checked={editing.group.userIds!.includes(user.id)}
                          onCheckedChange={(value) =>
                            patch({
                              userIds: value
                                ? [...editing.group.userIds!, user.id]
                                : editing.group.userIds!.filter(
                                    (id) => id !== user.id,
                                  ),
                            })
                          }
                        />
                        {user.username}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
              <p className="field-note">
                {tr(
                  "实际消耗按模型价格、渠道倍率和分组倍率计算。停用分组后，绑定密钥将停止调用。",
                )}
              </p>
              <div className="form-actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setEditing(undefined)}
                >
                  {tr("取消")}
                </button>
                <button>{tr("保存")}</button>
              </div>
            </fieldset>
          </form>
        </Dialog>
      )}
    </>
  );
}
