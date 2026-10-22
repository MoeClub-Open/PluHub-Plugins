import { t as tr } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { ModelRedirect } from "@pluhub/contracts/ai";

export function Redirects({
  rules,
  targets,
  save,
}: {
  rules: Record<string, ModelRedirect>;
  targets: string[];
  save: (update: (router: any) => void) => void;
}) {
  const [source, setSource] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [mode, setMode] = React.useState<"implicit" | "explicit">("implicit");
  return (
    <section className="panel">
      <h2>{tr("模型重定向")}</h2>
      <p className="muted">{tr("隐式保留原模型名，显式返回目标模型名。")}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save((r) => {
            r.redirects ??= {};
            r.redirects[source] = { target, mode };
          });
        }}
      >
        <label>
          {tr("请求模型")}
          <input
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={tr("例如 legacy-model")}
          />
        </label>
        <label>
          {tr("目标模型")}
          <input
            required
            list="redirect-targets"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <datalist id="redirect-targets">
          {targets.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <label>
          {tr("返回方式")}
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="implicit">{tr("隐式 · 保持原名")}</option>
            <option value="explicit">{tr("显式 · 显示目标")}</option>
          </Select>
        </label>
        <button type="submit">{tr("保存规则")}</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("请求模型")}</th>
              <th>{tr("目标模型")}</th>
              <th>{tr("返回方式")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(rules).map(([id, rule]) => (
              <tr key={id}>
                <td>
                  <code>{id}</code>
                </td>
                <td>{rule.target}</td>
                <td>
                  {rule.mode === "explicit" ? tr("显式") : tr("隐式")}
                  {rule.enabled === false ? tr(" · 已停用") : ""}
                </td>
                <td className="actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setSource(id);
                      setTarget(rule.target);
                      setMode(rule.mode);
                    }}
                  >
                    {tr("编辑")}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      save((r) => {
                        r.redirects[id].enabled = rule.enabled === false;
                      })
                    }
                  >
                    {rule.enabled === false ? tr("启用") : tr("停用")}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      save((r) => {
                        delete r.redirects[id];
                      })
                    }
                  >
                    {tr("删除")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
