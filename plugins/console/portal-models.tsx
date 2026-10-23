import type { CatalogModel } from "@pluhub/contracts/ai";
import type { UIHost } from "@pluhub/ui-sdk";
import { ModelLogo } from "../../lib/ui/model-logo.js";
import { useLoad } from "../../lib/ui/mount.js";
import { t, getLocale } from "../../lib/ui/i18n.js";

export const featuredModelId = (model: CatalogModel) =>
  JSON.stringify([model.channel?.id ?? "", model.id]);

export function PortalModels({
  host,
  selected,
}: {
  host: UIHost;
  selected: string[];
}) {
  const { data } = useLoad<CatalogModel[]>(() =>
    host.request("/api/plugins/official.model-catalog/public"),
  );
  const available = (data ?? []).filter(
    (model) =>
      (model.operations ?? ["chat"]).includes("chat") &&
      model.pricing?.mode !== "request",
  );
  const models = (
    selected.length
      ? available.filter((model) => selected.includes(featuredModelId(model)))
      : available
  ).slice(0, selected.length ? 8 : 5);
  const price = (model: CatalogModel, kind: "input" | "output") => {
    if (model.pricing?.mode === "expression") return t("阶梯计价");
    const base =
      model.billing?.[kind] ??
      (kind === "input" ? model.inputPrice : model.outputPrice);
    if (base === undefined) return "—";
    const value =
      base * (model.billing?.multiplier ?? model.consumptionMultiplier ?? 1);
    return (
      "$" +
      new Intl.NumberFormat(getLocale(), {
        maximumSignificantDigits: 5,
      }).format(value)
    );
  };
  if (!models.length) return null;
  return (
    <section className="portal-models" aria-label={t("精选模型")}>
      <div className="panel-heading">
        <h2>{t("精选模型")}</h2>
        <span className="muted">USD / 1M Tokens</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("模型 / 渠道")}</th>
              <th>{t("输入")}</th>
              <th>{t("输出")}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={(model.channel?.id ?? "") + ":" + model.id}>
                <td>
                  <a
                    className="portal-model-name"
                    href={
                      "#/models?" +
                      new URLSearchParams({
                        q: model.id,
                        ...(model.channel ? { channel: model.channel.id } : {}),
                      })
                    }
                  >
                    <ModelLogo
                      model={model.id}
                      provider={model.provider ?? ""}
                    />
                    <span>
                      <strong>{model.name}</strong>
                      <small>
                        {model.channel?.name ?? model.provider} · ×
                        {model.billing?.multiplier ??
                          model.consumptionMultiplier ??
                          1}
                      </small>
                    </span>
                  </a>
                </td>
                <td>{price(model, "input")}</td>
                <td>{price(model, "output")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
