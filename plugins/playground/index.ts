import { definePlugin } from "@pluhub/sdk";
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
          "ai.catalog@2",
          catalogScope(request, ctx),
        );
        const allowed = ctx.principal?.attributes?.models as
          string[] | undefined;
        return Response.json(
          models.filter((m) => !allowed?.length || allowed.includes(m.id)),
          {
            headers: {
              "cache-control": "private, no-store",
              vary: "Cookie, Authorization",
            },
          },
        );
      },
    });
  },
});
