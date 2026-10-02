# DeepSeek 翻译插件

[English](README.md) | [简体中文](README.zh-CN.md)

用于 DeepSeek Harness（DSH）的翻译工作区插件。项目处于早期开发阶段，已经提供可安装的 bundle 和工作区占位面板，尚未实现翻译执行。

## 功能与状态

- DSH bundle，包含 Host 框架服务和 Web Client 入口。
- 右侧 Sidebar 中的**翻译工作区**入口与占位面板。
- 会话、源文本单元、模型选择、执行尝试和译文修订的共享 TypeScript 契约。
- 为后续记忆能力预留的空 `MemoryPort` 实现。

文本输入、模型调用、Host/Client 通信、持久化和译文导出尚未实现。当前框架还不能用于实际翻译。

## 兼容性

用户已确认本地 Windows DSH 桌面端能够安装、卸载本插件，并加载工作区占位面板。开发期间核对的目标桌面运行时为 `0.2.0-rc.2`。此结果只确认框架 UI；其他版本、操作系统和独立 Web profile 尚未验证。

## 本地构建与安装

需要 Node.js 22 或更高版本、pnpm，以及支持本地 bundle 的 DSH 安装。

在插件目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

在 DSH 插件管理器中将本目录作为 `dsh-translation-plugin` 本地 bundle 安装，启用后重启 DSH。安装前需要构建，因为运行产物生成在 `dist/`，不进入 Git。以目录链接方式安装时，修改后重新构建同一目录，再重启 DSH。

若此前以 `dsh-deepseek-translation-plugin` 安装，请先卸载旧 bundle，再以新名称安装本目录。实现 ID 改变后，已有 Sidebar 标签可能需要重新打开。

## 打开工作区

进入一个会话并展开右侧 Sidebar，从引导页打开**翻译工作区**入口；只有一个引导入口时，空 Sidebar 可能直接打开该页面。没有活动会话的首页不显示 Sidebar 工作区。当前面板只显示框架占位内容，没有翻译操作控件。

停止使用时，在 DSH 插件管理器中禁用 bundle；需要移除注册时，在管理器中卸载。不要手动删除 DSH profile。若启动失败，使用桌面端恢复选项禁用第三方插件，再查看诊断日志。

## 贡献与发布

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。中英文 README 必须同步。提交采用 Conventional Commits，描述和正文使用中文。内部设计和调查文档在本仓库之外管理。

用户可观察的变化见 [CHANGELOG.md](CHANGELOG.md)。当前已记录本地 `v0.1.0` 框架基线，尚未公开发布插件包；`private: true` 用于防止意外发布到 npm。

## 许可证

[MIT](LICENSE)。
