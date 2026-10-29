import React from "react";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { Empty, Icon } from "../../lib/ui/components.js";
import { ModelLogo } from "../../lib/ui/model-logo.js";
import { Select } from "../../lib/ui/select.js";
import { t, getLocale } from "../../lib/ui/i18n.js";

function tokenPrice(model: CatalogModel, kind: "input" | "output") {
  if (model.pricing?.mode === "request" || model.pricing?.mode === "expression" || model.pricing?.tiers?.length)
    return undefined;
  const base =
    model.billing?.[kind] ??
    (kind === "input" ? model.inputPrice : model.outputPrice);
  return base === undefined
    ? undefined
    : base * (model.billing?.multiplier ?? model.consumptionMultiplier ?? 1);
}

export function Prices({
  models,
  busy,
  error,
  copy,
}: {
  models: CatalogModel[];
  busy: boolean;
  error: string;
  copy: (id: string) => Promise<void>;
}) {
  const [sort, setSort] = React.useState<"input" | "output">("output");
  const rows = models
    .filter((model) => tokenPrice(model, sort) !== undefined)
    .sort(
      (a, b) =>
        tokenPrice(a, sort)! - tokenPrice(b, sort)! || a.id.localeCompare(b.id),
    );
  const max = Math.max(...rows.map((model) => tokenPrice(model, sort)!), 0);
  const price = (value?: number) =>
    value === undefined
      ? "—"
      : "$" +
        new Intl.NumberFormat(getLocale(), {
          maximumSignificantDigits: 5,
        }).format(value);
  return (
    <>
      <div className="leaderboard-price-heading">
        <span>{t("USD / 百万 Token · 已含渠道倍率")}</span>
        <Select
          aria-label={t("价格排序")}
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="output">{t("输出价格从低到高")}</option>
          <option value="input">{t("输入价格从低到高")}</option>
        </Select>
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table aria-label={t("模型价格排行")}>
            <thead>
              <tr>
                <th scope="col">{t("排名")}</th>
                <th scope="col">{t("模型 / 渠道")}</th>
                <th
                  scope="col"
                  aria-sort={sort === "input" ? "ascending" : "none"}
                >
                  {t("输入")}
                </th>
                <th
                  scope="col"
                  aria-sort={sort === "output" ? "ascending" : "none"}
                >
                  {t("输出")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((model, index) => (
                <tr key={(model.channel?.id ?? "") + ":" + model.id}>
                  <td>
                    <span className="leaderboard-rank">{index + 1}</span>
                  </td>
                  <td>
                    <div className="leaderboard-identity">
                      <span className="leaderboard-avatar">
                        <ModelLogo
                          model={model.id}
                          provider={model.provider ?? ""}
                        />
                      </span>
                      <div>
                        <a
                          href={
                            "#/models?" +
                            new URLSearchParams({
                              q: model.id,
                              ...(model.channel
                                ? { channel: model.channel.id }
                                : {}),
                            })
                          }
                        >
                          <strong>{model.name}</strong>
                        </a>
                        <small title={model.id}>
                          {[
                            model.channel?.name ?? model.provider,
                            model.id !== model.name ? model.id : undefined,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <button
                        className="ghost icon-button leaderboard-copy"
                        aria-label={t("复制模型 ID：") + model.id}
                        title={t("复制模型 ID")}
                        onClick={() => void copy(model.id)}
                      >
                        <Icon name="copy" size={13} />
                      </button>
                    </div>
                  </td>
                  {(["input", "output"] as const).map((kind) => (
                    <td
                      key={kind}
                      className={
                        sort === kind ? "leaderboard-sorted" : undefined
                      }
                    >
                      <strong>{price(tokenPrice(model, kind))}</strong>
                      {sort === kind && (
                        <div
                          className="leaderboard-price-meter"
                          aria-hidden="true"
                        >
                          <i
                            style={{
                              width:
                                (max
                                  ? (tokenPrice(model, kind)! / max) * 100
                                  : 0) + "%",
                            }}
                          />
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="status">
          <Empty
            title={
              busy
                ? t("正在加载价格…")
                : error
                  ? t("价格暂不可用")
                  : t("没有可比较的模型价格")
            }
          />
        </div>
      )}
      {!busy && (
        <p className="leaderboard-footnote">
          {t(
            "仅比较可见平台模型的固定 Token 单价；按次与阶梯计价模型请在模型目录查看。",
          )}
        </p>
      )}
    </>
  );
}
