# 贡献指南

开发需要 Node.js 22 或更高版本及 pnpm。运行 `pnpm install --frozen-lockfile` 安装依赖，之后执行 `pnpm hooks:install`；提交代码前运行 `pnpm test`。

实现应遵循 DSH 公开接口和仓库现有模块边界。不得提交凭据、用户数据、内部设计资料、依赖目录或构建产物。

测试文件仅用于本地验证，不得提交。包括测试用例、测试夹具、快照、测试专用 SDK 探针和集成测试脚本；已有被 Git 跟踪的测试文件，其本次修改也不得暂存或提交。删除重复或无意义的测试，按改动保留并运行必要的本地验证。提交前明确选择源码、构建工具及公开文档，不使用全量暂存；Git hooks 会拒绝新增或修改的测试文件。

已有测试应通过 `git rm --cached` 停止跟踪并提交索引删除，保留本地文件；不删除本地测试，也不重写历史。`.gitignore` 只阻止未跟踪文件入库，不能代替已有测试的停止跟踪操作。

`README.md` 使用英文，`README.zh-CN.md` 使用中文，两者保持同步；CHANGELOG 和提交说明使用中文。提交采用 Conventional Commits，描述简洁，正文说明主要变化与验证结果；不要绕过仓库 Git hooks。

开发中的变更可先记入 CHANGELOG 的 `Unreleased`；每次本地版本提交时，更新版本号并将对应变化整理到带版本号与日期的章节。本地提交及版本记录不代表 npm 或远程发行页发布；远程发布仍需用户明确授权。

本地 Native 验证运行 `pnpm test:native`，需先准备相应的本地测试脚本，并将 `DSH_RUNTIME_ROOT` 指向含 `dsh/node_modules` 的外部 DSH rc.2 组件目录。Composer 联动还需匹配的 protocol 1 宿主补丁和扩展。测试用临时会话与合成 provider，不能据此宣称真实提供商或桌面安装已验证。
