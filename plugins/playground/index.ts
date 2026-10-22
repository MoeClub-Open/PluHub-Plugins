import { definePlugin, json } from "@pluhub/sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { catalogScope } from "../../lib/ai/catalog-scope.js";
export default definePlugin({
  setup(host) {
    host.api({
      method: "GET",
      path: "/models",
      access: "authenticated",
      async handle(request, ctx) {
        const models = await host.call<CatalogModel[]>(
          "ai.catalog@1",
          catalogScope(request, ctx),
        );
        const allowed = ctx.principal?.attributes?.models as
          | string[]
          | undefined;
        return json(
          models.filter((m) => !allowed?.length || allowed.includes(m.id)),
        );
      },
    });
  },
});
