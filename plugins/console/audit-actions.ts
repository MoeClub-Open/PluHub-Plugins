import { t as tr } from "../../lib/ui/i18n.js";

const actions: Record<string, string> = {
  "PUT /api/host/config": "更新系统配置",
  "PUT /api/plugins/official.ai-router/configuration": "更新渠道与模型配置",
  "POST /api/plugins/official.users/users": "创建用户",
  "PATCH /api/plugins/official.users/users": "修改用户",
  "POST /api/plugins/official.auth/users": "创建用户账号",
  "POST /api/plugins/official.auth/admin/keys/revoke": "撤销用户密钥",
  "POST /api/plugins/official.auth/admin/sessions/revoke": "撤销用户会话",
  "POST /api/plugins/official.auth/admin/factors/reset": "重置用户验证方式",
  "POST /api/plugins/official.billing/adjust": "调整用户余额",
  "POST /api/plugins/official.billing/reconcile": "核对调用费用",
  "POST /api/plugins/official.byok/admin/channels/block": "调整用户渠道状态",
  "PUT /api/host/registry/sources": "更新插件注册源",
  "POST /api/host/registry/install": "安装或更新插件",
  "POST /api/host/plugin-updates/apply": "应用插件更新",
  "POST /api/host/plugin-updates/cancel": "取消插件更新",
};

export function auditAction(method: string, path: string) {
  const known = actions[method + " " + path];
  if (known) return tr(known);
  const plugin = /^\/api\/plugins\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (plugin) {
    const verb = method === "DELETE" ? tr("删除") : method === "POST" ? tr("创建或执行") : tr("修改");
    return verb + " · " + plugin[1];
  }
  return tr("管理操作");
}
