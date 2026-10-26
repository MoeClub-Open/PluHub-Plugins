# PluHub 官方插件

插件独立构建与安装，不导入宿主私有源码。需要同级 PluHub 和 PluHub-Spec 已构建公开包。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

每个 plugins/name 目录含 Manifest、后端源码及独立产物。可选 ui.tsx 导出 mount(element, host)，并返回注销函数。包内包含前后端 Bundle。

`tsc` 只检查类型，`scripts/build.ts` 生成各插件的 `dist/`；不生成仓库根目录的重复编译产物。`lib/` 按 `ai/`、`commerce/`、`http/`、`identity/`、`storage/`、`ui/` 分组，仅此插件使用的实现放在 `plugins/name/` 内。共享库不导入插件，插件之间通过公开能力协作。完整目录约定见主仓 `docs/STRUCTURE.md`。

基础插件：Listener、HTTP Transport、Console、Users、Auth、AI Router。

产品插件：Model Catalog 提供模型搜索与接入详情；Observability 提供 SQLite 请求元数据、用量汇总及按用户隔离的日志；Leaderboard 提供用户榜、模型榜和当前用户排名；Playground 使用登录会话经标准入口发起流式对话。共有 35 个官方插件，新站预装全部插件，默认启用 18 个基础插件。Workflow 和 Protocol Converter 已移除；标准协议转换和渠道图由 Router 及共享协议工具实现。排行榜统计范围、保留和隐私边界见主仓 `docs/LEADERBOARD.md`。

Auth 管理身份、会话及密钥授权。平台密钥绑定一个使用分组，个人密钥绑定自己的个人渠道；模型范围、有效期及请求上限随身份传递。Rate Limit 统一执行密钥和全局限流，共用计数并取较严格上限。`x-pluhub-channel` 只能选择当前范围内的渠道，密钥不能通过参数切换分组。旧平台渠道绑定由离线迁移转为受限分组，不保留第二种编辑模式。AI Router 提供渠道与模型的表单配置、启停及显式测试请求。Console 支持明暗主题与移动端导航，用户页面通过 Manifest 的 `ui.public` 展示，后端独立检查权限。

管理员设置按「渠道与路由」「流量控制」「支付与商业」「安全与验证」聚合，组内使用二级导航。插件通过可选 `ui.group`、`ui.order` 声明位置；`ui.pages` 可在同一入口模块提供额外页面，通过公开 `UIHost.page` 区分。额外页面默认仅管理员可见，不继承主页面的 `public`。个人充值、账单和账号安全仍位于用户控制台。未声明或未知分组的第三方扩展保留独立入口；停用插件后统一注销其所有页面。契约说明见主仓 `docs/PLUGIN_API.md`。

支付适配器使用 `ui.group: "payment-adapters"`，统一列入「支付与商业 → 支付方式」的可搜索列表，点击后挂载各插件的配置模块；不会按适配器增加导航项。商品与订阅、计费与余额继续使用 `payments`，原支付配置链接仍可直达对应模块。

「系统设置」总览支持搜索，进入设置后侧栏切换为分类导航。渠道管理提供搜索、状态/协议筛选、分页和跨页选择，可批量启停并在停用前确认范围；密钥授权仅在凭证引用变化时同步。操作方式见主仓 `docs/GATEWAY.md`。

Console 的 `config.branding` 支持站点名称、Logo/图标、主题色、登录文案和页脚联系链接；「站点与品牌」页面提供预览和热更新。仅使用原有 `http.route` 权限，公开品牌数据与受保护的配置写入分开。界面层级参考 Stripe，新增 `Ctrl/Cmd+K` 页面入口搜索；不自动修改邮件模板及托管支付页面。

AI 插件分为两组：ingress-* 面向客户端，upstream-* 面向服务商；支持 OpenAI Chat Completions、Responses、Anthropic、Gemini。通过 AI 契约和路由组合。

入口自动识别 Codex、Claude Code 和兼容客户端的会话 Header、Claude 新旧 `metadata.user_id`、请求体会话字段与 `prompt_cache_key`；没有明确标识时，使用首轮用户消息摘要。会话按用户、API Key、渠道和提供商节点隔离，只保存派生标识。订阅账号绑定持久保存，闲置一小时过期，使用时续期；绑定账号并发已满时最多等待 15 秒，超时返回 429。账号停用、删除、授权失效、冷却或被移出渠道后，下次请求重新选择并绑定当前池内的可用账号；不会在已开始的响应中切号重试。Codex 缓存键和会话 Header、Claude 会话元数据、Antigravity 会话 ID 保持稳定。无明确会话标识且客户端截断或改写首轮消息时，摘要会变化，无法保证延续原绑定。

订阅插件每 30 秒运行后台维护，提前 5 分钟刷新 OAuth；健康账号每 5 分钟查询额度，冷却账号约每分钟检查恢复，查询失败按退避间隔重试。维护仅访问 OAuth 与额度控制接口。刷新合并轮换后的 Refresh Token，保留额度冷却；无效授权需要重新登录。额度耗尽按提供商的全局窗口、模型或模型系列隔离并持久保存，只有新的额度查询确认恢复后重新纳入路由；Code review 等独立功能额度不阻塞普通生成。自动路由跳过当前不可用的订阅目标，恢复后重新参与选择。当前请求在返回首个标准化事件前，可因明确的认证、限额或服务错误切换同渠道内的其他账号，最多尝试三个不同账号；HTTP 或 SSE 的认证错误均先刷新一次。请求开始返回事件后只记录冷却并结束错误，不重放或拼接结果；传输状态不明的网络错误也不自动重放。切换后的账号成为该会话的新绑定，已结束的失败请求不会在后台重新执行。

Users 与 Auth 各自拥有 SQLite 数据库及事务迁移，通过用户能力协作。Auth 不读取 Users 表。上游凭证使用环境变量引用，与用户 API Key 分离。

Auto Router 将既有物理渠道组合成虚拟提供商，支持自动模型、自动思考强度及两者同时调整；Token Speed 对每个请求使用显式 tokenizer 进行输出节拍控制。配置说明见主仓 docs/AUTO_ROUTING.md。邮件与验证插件：Mailer 提供带 TLS 的 SMTP 发件能力；人机验证插件提供 Turnstile、reCAPTCHA v2/v3 和极验 v4 的服务端校验。Auth 提供验证邮箱注册/登录、TOTP 与恢复码、FIDO2 安全密钥和 Passkey。配置、恢复与测试说明见主仓 docs/IDENTITY.md。详细协议矩阵与运行方式见主仓 README。

许可证：Apache-2.0。

AI Router 的每个渠道统一通过流程图组合功能；协议与连接属于上游调用节点，自动路由也是节点。旧 Workflow 配置由离线迁移转换，不再提供其能力或页面。AI Router 支持隐式/显式模型重定向，调用身份与最终计费保持独立。说明见主仓 `docs/WORKFLOWS.md`。Listener 新增存活/就绪探针与显式可信代理配置；容器部署见 `docs/DOCKER.md`。

商业与订阅上游插件包括 Billing、Commerce、Stripe、易支付、BYOK、Rate Limit、Codex、Claude Subscription、Antigravity。配置说明位于主仓 docs/COMMERCIAL.md。插件通过公开 SDK 与 Spec 协作，支付与计费默认关闭。

BYOK 提供用户独立的个人渠道、可编辑服务商预设、模型原价与输入/输出消耗倍率、公开报价同步、渠道流程图及 API Key 渠道绑定。详见主仓 `docs/PERSONAL_CHANNELS.md`。

工单与支持 Tickets 插件提供用户新建、分类、优先级、双方回复、关闭与重新打开；管理入口在「系统管理 → 工单管理」。数据通过独立 SQLite 迁移保存，需控制台会话，支持用户隔离、幂等提交、并发版本检查、配额和分页。Console 账号菜单显示真实可用余额、冻结及订阅，主题可跟随系统，统一下拉组件支持键盘与主题样式。

路由执行、自动路由候选和费用试算共用 AI Router 的 `resolution.ts`。Auto Router 仅提供决策能力 `ai.auto-routing@1`，不再提供旧生成适配器；Token Speed 仅提供 `ai.output-pace@2`。费用试算不调用远程决策、生成接口或租约接口，不能确定目标时返回明确错误。插件所有权、请求和资金流程见主仓 `docs/PLUGIN_ARCHITECTURE.md`；生产适用边界见 `docs/IMPLEMENTATION.md`。
