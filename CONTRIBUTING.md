# 贡献指南

开发需要 Node.js 22 或更高版本及 pnpm。运行 `pnpm install --frozen-lockfile` 安装依赖，之后执行 `pnpm hooks:install`；提交代码前运行 `pnpm test`。

实现应遵循 DSH 公开接口和仓库现有模块边界。不得提交凭据、用户数据、内部设计资料、依赖目录或构建产物。

`README.md` 使用英文，`README.zh-CN.md` 使用中文，两者保持同步；CHANGELOG 和提交说明使用中文。提交采用 Conventional Commits，描述简洁，正文说明主要变化与验证结果；不要绕过仓库 Git hooks。
