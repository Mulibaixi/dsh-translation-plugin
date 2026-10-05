# 贡献指南

## 开发准备

需要 Node.js 22 或更高版本和 pnpm。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm test
```

`hooks:install` 只设置本仓库的 `core.hooksPath`，不改全局配置。已有其他 hooks 路径时会停止安装，避免覆盖既有配置。不依赖额外 hook 管理包。

`pnpm test` 先构建，再运行 `node --test`；覆盖翻译会话、历史、旧格式兼容、模型目录、生成 bundle 和快译状态。仅构建时可执行 `pnpm build`。

快译 Host/Client Native 集成测试需另外准备完整的 DSH `0.2.0-rc.2` 组件目录。将 `DSH_RUNTIME_ROOT` 指向一个外部目录，其中包含 `dsh/node_modules/`，然后执行：

```powershell
$env:DSH_RUNTIME_ROOT = '<外部目录，内含 dsh/node_modules>'
pnpm test:native
```

`pnpm test:native` 会先构建，再通过 `node --expose-internals --test scripts/quick-host-native.integration.mjs scripts/quick-client-native.integration.mjs scripts/quick-client-mount-native.integration.mjs` 运行三个集成入口。缺少环境变量或必需组件时会明确失败；测试不会下载依赖，也不会跳过。测试使用 DSH `0.2.0-rc.2` 组件包、一次性 synthetic profile 和 synthetic provider，不读取用户 profile/凭据，也不调用真实远端模型。除 Host/Client 组件与 RPC 集成外，挂载入口使用真实 `ClientRemoteService`、Cordis 与当前 Client bundle，检查异步挂载后的自主能力查询、合成翻译及卸载。它不代替在用户 DSH Desktop 中运行。

`src/host/` 管理宿主服务，`src/client/` 管理 UI，`src/shared/` 管理共享契约，`src/memory/` 管理记忆接口实现。构建结果位于 `dist/`。在 DSH 桌面端验证前先构建，使用本地 bundle 安装后重启。若变更 `dsh.client.inject` 等 bundle 元信息，目录链接安装可能需要在插件管理器刷新或重新安装，再重启；不直接修改用户 profile。

## Client 交互与数据规范

- 核对目标 DSH 版本的实际 Client 契约。Sidebar 使用组件所属的 `sessionId` 管理显示范围，不能以全局当前会话代替。翻译会话 ID 独立，模式是该会话属性；此 UI 范围不等同于快译执行绑定主会话。
- 全局翻译设置页使用 `settings.section`，等待 slot 声明后注册，并由插件 effect 管理注册和存储监听的注销。没有活动会话时，设置页仍应可用。
- Client 本地模块仅引用 `src` 内的浏览器代码。外部依赖限 React 和已在目标版本 platform seed 中核实的 `@deepseek-ai/dsh-client-ui-primitives`，禁止引入 Node 宿主接口、文件访问、凭据或模型直调。
- 新会话默认值与历史使用 Web `localStorage`，不视为 Host 配置。有效设置使用 `patchSettingsAsync` 即时按字段合并保存，与正文写入共用锁；不能用陈旧的整页表单覆盖其他窗口未修改的字段，也不能用旧保存回执清除用户的新编辑。
- 历史保存默认关闭，启用后自动写入；关闭后保留旧历史、停止后续正文写入，已持久主题仍可保留无正文的身份与编号元数据。删除必须明确范围与确认，只清理插件命名空间；选删和清理全部都需冻结确认时的版本。
- 记忆联动删除没有后端实现时不可执行。后续须核对共享引用和用户选择，不能随历史删除整份共享记忆。
- 读取、保存、清理失败和多窗口冲突均保留当前输入并提示。部分清理失败须报告准确范围，不将 localStorage 比较写入宣称为原子事务。
- 从“+”创建的主题首会话冻结设置默认值；同主题子会话复制父会话的模式、目标语言、要求、单次上限及模型选择，输入为空。原文上限按 Unicode 码点计算，不写成 token 数。模型选择使用主窗口同一目录 RPC 和原生菜单组件，但只更新独立翻译会话，不调用主聊天的 selectModel。
- 主题 ID、主题名、会话 ID、固定序号及独立备注分别管理。同主题编号只递增，不从存活会话数量重新计算；主题重命名联动显示名，备注不参与命名和执行要求。会话档位只允许 quick 升 normal。
- 同级 React 组件使用不同角色的稳定 key；模式与目标语言控件不能共用会话 ID 作为同级 key。新建及反复切换会话时，分别检查控件数量、菜单交互和当前会话归属。
- 历史保存默认关闭，关闭后停止后续名称和正文写入。模型与推理等级 route 作为独立偏好保存，不受历史开关影响，仅包含 provider/model/effort；可恢复会话保留专属选择，完全临时会话只保存 ownerId 的最后选择供下次新首会话沿用，同主题子会话优先父选择（含 null）。不能用 owner 最后选择覆盖其他已有会话；删除会话清其专属偏好，历史清理保留 owner 默认偏好。失败保留当前选择并提示，不写入凭据、名称、原文或文件。
- 恢复回归使用同一完整存储，覆盖主题名称、会话历史与独立模型偏好，并检查目录加载后旧选择仍保留。没有独立偏好的旧历史兼容原 model；失效的目录 route 保留显示并阻止发送，不自动换模型。
- Checkbox 事件在事件处理器中读取 checked 值，再传给 React 函数式状态更新；不要在延迟执行的 updater 中读取已结束事件的 currentTarget。右键选择操作先收起相关菜单，再打开对话框或执行会话操作。
- 持久主题的结构操作需使用数据层提供的异步入口及跨窗口锁，UI 等待结果后再关闭确认框。编号元数据不含原文、译文或备注；关闭历史不允许借元数据保存新的正文。无法满足锁或存储条件时明确报错，不能退回无保护写入。
- 会话使用侧栏管理，右键与键盘菜单操作绑定具体会话 ID，不能用当前选择替代点击目标。归档保留内容且可恢复，持久化遵守历史开关；删除检查确认时的历史版本与内存内容，不能连带删除父子会话。
- 下拉与右键菜单使用原生 Menu 的 portal/定位/注销契约，避免被滚动区裁剪。模型菜单区分模型与推理等级，仅提供目录声明的等级，并正确处理允许未指定等级的 Default。
- 执行只开放快译纯文本路径，普通模式保持不可发送。开始前要求 Host 能力可用、正文有效，并且会话选择了 DSH Host 模型目录中的已配置模型及可用推理等级；插件不提供 provider 或凭据配置。
- Host 组装的快译上下文只含内置翻译提示词、当前原文、目标语言、用户显式要求及冻结后的模型 route。禁止注入工具、主聊天消息/历史、文件和 memory refs；调用不能切换或修改主聊天模型。
- 每轮已提交原文与译文只留在 Client/Host 的运行期状态中，不写入会话历史或默认 Agent 日志，重启后不恢复。历史开关只保存会话资料与当前原文草稿；旧人工稿仍按兼容数据展示。
- 输入区文件入口与 file input 在快译均禁用。普通模式仅选择一个 File、替换或移除，并显示文件名；引用按会话隔离，删除所属翻译会话、切换主窗口会话或卸载面板后释放，重启不恢复。当前不读取或解析字节、不上传、不执行文件翻译、不写入历史，界面须明确此范围，不能将文件选择等同于文件翻译能力。
- 结算未知表示 Host/provider 可能已收到请求；保持原 operation ID 并查询同一操作，不自动重发，也不将 unknown 当作明确拒绝。用户请求取消后，只有 Host 确认 `cancelled` 才结束为已取消；此流程不能误触发第二次模型调用。
- Host 运行期领域服务与 Client 本地会话保存分开。内存事务不等于磁盘事务；当前快译运行状态不提供重启恢复。DSH LLM 调用使用专用文本 adapter 和 detached Session，不经默认 Agent 或主聊天执行。

常规测试使用合成数据和模拟存储/RPC；Native 集成入口加载 DSH `0.2.0-rc.2` 组件并使用 synthetic provider。该证据只覆盖所加载组件与接口，不能写成用户桌面实测或真实远端模型成功。桌面人工检查仍包括多会话命名与切换、滚动布局、即时设置、目录菜单、自动历史保存与重启恢复、关闭后保留历史、选择性删除、存储错误、冲突和禁用/卸载。运行结果记录在仓库外，写明日期、DSH 版本、操作与观察范围。

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
3. Client 行为改动执行 `pnpm test`；其他改动按范围执行构建及必要验证。写明未验证内容，将用户桌面实测与构建/自动检查分别记录；自动通过不能替代桌面实测。
4. 对功能、兼容性和安装变化更新 CHANGELOG，并同步两份 README。
5. 初次纳入 `.githooks` 时使用 `git add --chmod=+x .githooks/commit-msg .githooks/pre-commit` 保留 Unix 可执行位。

## 版本与发布

使用 `MAJOR.MINOR.PATCH`，预发布使用 `-alpha.N`、`-beta.N` 或 `-rc.N`。`0.1.0` 为框架基线，`0.1.1` 为交互面板版本，`0.2.0` 为主题会话与 Host 执行基础版本，`0.2.1` 为会话保存回归修复版本，`0.3.0` 为纯文本快译版本，`0.3.1` 修复快译服务挂载并调整状态提示，`0.3.2` 修复会话控件并补充运行期文件选择入口，当前 `0.3.3` 独立保存模型偏好并修复历史选择与菜单收起；这些均为本地版本，不代表已经公开发布。0.x 的不兼容接口变更提高 MINOR，并明确说明迁移方法；兼容修复提高 PATCH。暂不根据提交自动发布。

发布前：

- 确认拟发布版本、目标 DSH 版本与实测范围；重新构建。
- 为 CHANGELOG 中的待发布变化添加准确版本、日期及兼容性说明。
- 核对 `package.json`、README 与发布版本一致；检查依赖和许可证。
- 用 `npm pack --dry-run` 检查包内容，只包含产物、bundle patch、双语 README、CHANGELOG 和 LICENSE 等公开文件。
- npm 发布前需明确授权并处理 `private: true`；没有授权时保持该保护。
- 标签使用 `v<version>`，发行说明使用中文。推送、创建公开发行和发布包均应依据当次发布授权执行。
