import { t as tr } from "../../lib/ui/i18n.js";
export const pluginCategories = [
  {
    id: "core",
    get title() {
      return tr("基础设施");
    },
  },
  {
    id: "identity",
    get title() {
      return tr("账号与验证");
    },
  },
  {
    id: "routing",
    get title() {
      return tr("模型服务");
    },
  },
  {
    id: "ingress",
    get title() {
      return tr("入口协议");
    },
  },
  {
    id: "upstream",
    get title() {
      return tr("上游适配");
    },
  },
  {
    id: "commerce",
    get title() {
      return tr("计费与支付");
    },
  },
  {
    id: "traffic",
    get title() {
      return tr("流量控制");
    },
  },
  {
    id: "operations",
    get title() {
      return tr("观测与支持");
    },
  },
  {
    id: "tools",
    get title() {
      return tr("模型工具");
    },
  },
  {
    id: "other",
    get title() {
      return tr("其他");
    },
  },
];

export const pluginStates: Record<string, string> = {
  get Discovered() {
    return tr("已发现");
  },
  get Validated() {
    return tr("已校验");
  },
  get Installed() {
    return tr("已安装");
  },
  get Resolved() {
    return tr("依赖已解析");
  },
  get Starting() {
    return tr("启动中");
  },
  get Ready() {
    return tr("就绪");
  },
  get Active() {
    return tr("运行中");
  },
  get Draining() {
    return tr("排空中");
  },
  get Stopped() {
    return tr("已停用");
  },
  get Failed() {
    return tr("异常");
  },
};

type Plugin = {
  id: string;
  name?: string;
  description?: string;
  state: string;
  manifest: {
    category?: string;
    name?: string;
    description?: string;
    provides?: string[];
    ui?: { group?: string; path?: string };
  };
};

export function pluginCategory(plugin: Plugin) {
  const manifest = plugin.manifest;
  if (manifest.category) return manifest.category;
  // Keep previously installed packages useful without rewriting their manifests.
  const group = manifest.ui?.group;
  if (["payments", "payment-adapters"].includes(group ?? "")) return "commerce";
  if (["security", "verification-services"].includes(group ?? ""))
    return "identity";
  if (group === "routing") return "routing";
  if (group === "traffic") return "traffic";
  if (["/models", "/playground"].includes(manifest.ui?.path ?? ""))
    return "tools";
  const capabilities = manifest.provides ?? [];
  if (capabilities.some((c) => c.startsWith("ai.ingress."))) return "ingress";
  if (capabilities.some((c) => c.startsWith("ai.upstream."))) return "upstream";
  return "other";
}

export function pluginCategoryTitle(id: string) {
  return pluginCategories.find((category) => category.id === id)?.title ?? id;
}

export function pluginCategoryOptions(plugins: Plugin[]) {
  const counts = new Map<string, number>();
  for (const plugin of plugins) {
    const id = pluginCategory(plugin);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const known = pluginCategories.map((category) => category.id);
  return [
    ...known,
    ...[...counts.keys()].filter((id) => !known.includes(id)).sort(),
  ]
    .filter((id) => counts.has(id))
    .map((id) => ({
      id,
      title: pluginCategoryTitle(id),
      count: counts.get(id)!,
    }));
}

export function filterPlugins<T extends Plugin>(
  plugins: T[],
  query: string,
  category: string,
  state: string,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return plugins.filter((plugin) => {
    const id = pluginCategory(plugin);
    const text = [
      plugin.name,
      plugin.id,
      plugin.description,
      plugin.manifest.name,
      plugin.manifest.description,
      id,
      pluginCategoryTitle(id),
      plugin.state,
      pluginStates[plugin.state],
      plugin.name ? tr(plugin.name) : "",
      plugin.description ? tr(plugin.description) : "",
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (!category || id === category) &&
      (!state || plugin.state === state) &&
      words.every((word) => text.includes(word))
    );
  });
}
