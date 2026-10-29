# PluHub 官方插件

PluHub 的官方插件实现，包括控制台、账号、模型路由、协议适配、个人渠道、计费与支付等。插件独立构建和发布，通过公开 SDK 与能力接口协作。

运行与部署见 [PluHub](https://github.com/MoeClub-Open/PluHub)，使用及配置说明统一在 [文档目录](https://github.com/MoeClub-Open/PluHub/blob/main/docs/README.md) 维护。

## 构建

同级的 `PluHub-Spec` 和 `PluHub` 需先构建公开包。完整工作区的安装顺序和运行环境见 [贡献指南](https://github.com/MoeClub-Open/PluHub/blob/main/CONTRIBUTING.md)。

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm typecheck` 检查类型，`scripts/build.ts` 生成每个插件的独立前后端包；`pnpm test` 运行插件检查。完整集成由本仓 CI 调用主仓的固定版本流程执行。

## 目录与开发

| 目录                   | 内容                                                    |
| ---------------------- | ------------------------------------------------------- |
| `plugins/<name>/`      | Manifest、后端 `index.ts`、可选前端 `ui.tsx` 及内部模块 |
| `plugins/<name>/dist/` | 安装包中的前后端产物                                    |
| `lib/`                 | 跨插件复用的纯工具、协议工厂、存储和界面组件            |
| `tests/`               | 插件行为与协议检查                                      |

前端入口导出 `mount(element, host)` 并返回注销函数。共享库不导入插件，插件不引用其他插件或宿主的私有源码。

- [插件 API](https://github.com/MoeClub-Open/PluHub/blob/main/docs/PLUGIN_API.md)：权限、能力调用、页面挂载和设置聚合。
- [插件架构](https://github.com/MoeClub-Open/PluHub/blob/main/docs/PLUGIN_ARCHITECTURE.md)：数据归属、请求及资金链路。
- [依赖与安装](https://github.com/MoeClub-Open/PluHub/blob/main/docs/PLUGIN_DEPENDENCIES.md)：版本、依赖解析和授权。
- [注册源与更新](https://github.com/MoeClub-Open/PluHub/blob/main/docs/PLUGIN_REGISTRY.md)：发布目录、在线安装及更新。

## 许可证

[Apache-2.0](LICENSE)。
