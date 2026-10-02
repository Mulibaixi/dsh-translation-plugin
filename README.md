# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A translation workspace plugin for DeepSeek Harness (DSH). The project is in early development: the installable bundle and workspace placeholder are available; translation execution is not implemented yet.

## Features and status

- DSH bundle with a Host framework service and a Web Client entry.
- A **Translation Workspace** entry in the right Sidebar and a placeholder panel.
- Shared TypeScript contracts for sessions, source units, model selection, attempts and revisions.
- An empty `MemoryPort` implementation reserved for future memory integration.

Text input, model execution, Host/Client transport, persistent storage and translation export are not implemented. This is not yet a usable translator.

## Compatibility

The user has confirmed local Windows DSH Desktop installation, removal and workspace placeholder loading. The target Desktop runtime inspected during development is `0.2.0-rc.2`. This confirms the framework UI only; other versions, operating systems and standalone Web profiles have not been verified.

## Build and install locally

Requirements: Node.js 22 or later, pnpm, and a DSH installation that supports local bundles.

Run in the plugin directory:

```powershell
pnpm install --frozen-lockfile
pnpm build
```

In the DSH plugin manager, install this local directory as the `dsh-translation-plugin` bundle, enable it, and restart DSH. Build before installing, because runtime artifacts are generated into `dist/` and are not committed. For a linked installation, rebuild the same directory and restart DSH after changes.

If previously installed as `dsh-deepseek-translation-plugin`, uninstall the old bundle and install this directory again under the new name. Existing Sidebar tabs may need to be reopened after the implementation ID changes.

## Open the workspace

Enter a conversation and expand the right Sidebar. Open the **Translation Workspace** entry from the Sidebar guide; when it is the sole guide entry, an empty Sidebar may open the page directly. The home screen without an active conversation has no Sidebar workspace. The panel currently displays a framework placeholder, without translation controls.

Disable the bundle in the DSH plugin manager to stop using it, or uninstall it there to remove its registration. Do not manually delete the DSH profile. If startup fails, use Desktop's recovery option to disable third-party plugins, then inspect the diagnostic log.

## Contributing and releases

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Both README files must stay synchronized. Commit messages follow Conventional Commits with Chinese descriptions and bodies. Internal design and investigation documents are maintained outside this repository.

See [CHANGELOG.md](CHANGELOG.md) for user-facing changes. The local `v0.1.0` framework baseline is recorded; no public package release has been made. `private: true` prevents accidental npm publishing.

## License

[MIT](LICENSE).
