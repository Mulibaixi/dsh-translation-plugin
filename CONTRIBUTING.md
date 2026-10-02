# 贡献指南

## 开发准备

需要 Node.js 22 或更高版本和 pnpm。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm build
```

`hooks:install` 只设置本仓库的 `core.hooksPath`，不改全局配置。已有其他 hooks 路径时会停止安装，避免覆盖既有配置。不依赖额外 hook 管理包。

`src/host/` 管理宿主服务，`src/client/` 管理 UI，`src/shared/` 管理共享契约，`src/memory/` 管理记忆接口实现。构建结果位于 `dist/`。在 DSH 桌面端验证前先构建，使用本地 bundle 安装后重启。

## 文件与文档边界

允许提交：源码、构建脚本、锁文件、用户文档、贡献规范、更新日志、许可证和仓库工具。

禁止提交：内部开发设计、方案、需求拆解、研究与排错记录、开发计划、profile patch、崩溃日志、翻译数据、凭据、依赖和构建产物。

本工作区内部资料统一放到仓库上级目录的 `docs/plugin-development/dsh-translation-plugin/`。公开 README 不链接内部资料，不引用本机绝对路径。克隆后的贡献者可以使用仓库外的等价位置。

`.gitignore` 排除常见内部文档位置；`pre-commit` 再检查暂存区的禁止路径，避免 `git add -f` 绕过忽略规则。工具无法判断所有文档的语义，仍需人工检查提交内容。

## 双语规则

`README.md` 使用英文，`README.zh-CN.md` 使用中文，两份文档的功能、限制、安装步骤、兼容性和许可证信息同步。CHANGELOG 和本指南使用中文。代码标识符、协议字段及技术名词保留原文。

## 提交信息

采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)：

```text
type(scope)!: 中文描述

使用中文说明修改原因、行为变化和验证结果。

BREAKING CHANGE: 用中文说明破坏性变更和迁移方法。
```

scope、`!`、正文和 footer 按需要填写。类型允许 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`；scope 使用小写英文、数字或连字符。标题不超过 72 个 Unicode 字符，不以句号结尾。描述必须包含中文，正文使用中文；英文标识符和标准 Git trailer 可以保留。

示例：

```text
feat(client): 添加翻译输入面板
fix(client): 修复工作区引导入口注册
docs: 同步中英文安装说明
chore(repo): 建立开源项目与提交规范
refactor(host)!: 调整翻译会话事件协议
```

`commit-msg` 校验标题、空行、中文描述和正文；不校验代码行为。不要通过 `--no-verify` 绕过检查。项目现有提交保持原样，新规则从后续提交生效。自动产生的合并或回退说明也应整理成上述格式。

## 提交前检查

1. 每次提交围绕一个主要目的，明确选择文件，查看 `git diff --cached`。
2. 执行 `pnpm check:policy`，核对暂存区没有内部文档、用户数据或构建产物。
3. 按改动执行构建及必要验证，写明未验证内容；将用户桌面实测与本地构建检查分别记录。
4. 对功能、兼容性和安装变化更新 CHANGELOG，并同步两份 README。
5. 初次纳入 `.githooks` 时使用 `git add --chmod=+x .githooks/commit-msg .githooks/pre-commit` 保留 Unix 可执行位。

## 版本与发布

使用 `MAJOR.MINOR.PATCH`，预发布使用 `-alpha.N`、`-beta.N` 或 `-rc.N`。当前 `0.1.0` 为本地框架基线，不代表已经公开发布。0.x 的不兼容接口变更提高 MINOR，并明确说明迁移方法；兼容修复提高 PATCH。暂不根据提交自动发布。

发布前：

- 确认拟发布版本、目标 DSH 版本与实测范围；重新构建。
- 为 CHANGELOG 中的待发布变化添加准确版本、日期及兼容性说明。
- 核对 `package.json`、README 与发布版本一致；检查依赖和许可证。
- 用 `npm pack --dry-run` 检查包内容，只包含产物、bundle patch、双语 README、CHANGELOG 和 LICENSE 等公开文件。
- npm 发布前需明确授权并处理 `private: true`；没有授权时保持该保护。
- 标签使用 `v<version>`，发行说明使用中文。推送、创建公开发行和发布包均应依据当次发布授权执行。
