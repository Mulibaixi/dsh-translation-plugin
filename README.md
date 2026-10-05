# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A lightweight translation session panel for DeepSeek Harness (DSH). Quick mode supports plain-text translation with a model already configured in DSH. Each submitted round of source and translated text appears only in the current runtime session. History retention saves session details and the current source draft.

## Current features

- A right Sidebar panel with a title dropdown for existing sessions and a collapsible session list, collapsed by default. Each independent session retains its own input and configuration.
- **+** creates a new topic and its first session, initially named “新翻译会话”. Creating from an existing session uses the next sequence in that same topic, such as “故事A-01” and “故事A-02”. Creating from a child does not nest suffixes or fill deleted sequence numbers.
- Rename changes the topic name for all its sessions while keeping IDs and sequence numbers. Each session also has an independent remark, which may be duplicated or cleared.
- A left-aligned current title dropdown with context actions and right-aligned mode/language controls, a scrollable conversation area and a simple composer with a circular Send button and no blue focus outline on its text area.
- Service checking, unavailable status and the Normal mode limitation appear immediately above and outside the composer. Quick mode provides a compact check icon at the right of the status line, disabled while checking; the line disappears when the service is ready. The runtime retention note appears below the composer only after translation records exist.
- Model selection sits at the composer's lower right, immediately left of Send. It uses DSH's native menus and icons and the same `session.modelCatalog()` directory API as the main composer. Its model/effort menu supports provider groups and search; selection applies only to the current translation session.
- Quick mode sends the current plain-text draft, target language and explicit translation requirements through a selected DSH Host model, then displays the source and translated result in the conversation area. Only models and reasoning efforts exposed by the Host catalog are selectable.
- **DSH Settings → 翻译** provides new-session defaults, history retention and history cleanup. Valid changes save immediately.

Quick execution is limited to plain text in Quick mode; Normal mode remains unavailable. A provider and model must already be configured in DSH. The plugin does not add provider or credential settings. The translation context contains the built-in prompt, current source text, target language, explicit requirements and selected catalog route; it excludes tools, main-chat messages or history, files, and memory. History retention saves session details and the current source draft; submitted rounds of source and translated text remain only in runtime memory and are lost on restart. If an operation's outcome is unknown, the client keeps its identity and queries that same operation; if Host confirms cancellation, it settles as cancelled. It will not automatically submit the request again.

The panel keeps a simple composer and transcript. Memory archives and formal export are not connected. The previous manual translation editor and export controls have been removed; previously saved manual text remains viewable.

**重新检查翻译服务 (Check translation service again)** only queries whether the DSH Host translation service and runtime components are ready. It sends no source text or model translation request and does not test model credentials or remote responses. The Client waits for DSH's asynchronous service mount before querying capabilities, avoiding a false unavailable status while the service is still mounting.

## Sessions and defaults

Enter a main-window conversation, expand the right Sidebar and open “翻译” from its guide. Translation sessions are currently grouped by their owning main-window conversation, with independent translation session IDs. This UI grouping does not imply that quick translation execution uses the main model.

- Click the current title to list existing sessions and switch while retaining each session's input. The dropdown provides a centered **+** for a new topic and its first session, as well as archived-session restore actions.
- Active sidebar sessions appear in creation order; a centered **+** follows the last item and also creates a new topic and its first session. Both **+** actions cover their full row; the sidebar hit area matches the session-name rows.
- Right-click a session name or the current title to create a session in the same topic, rename the topic, edit the session remark, delete or archive. The rename dialog explains its effect on all sessions in the topic. An open title dropdown remains visible while its context menu is used. Escape dismisses the context menu first; clicking outside dismisses both menus. Actions target the clicked session without requiring it to be selected first.
- Archiving preserves content and removes the session from the active list. Expand **已归档 (Archived)** and click a session to restore it, or choose **恢复归档 (Restore)** from its context menu. There is no Close action.
- The session sidebar starts collapsed; the header's sidebar icon expands or collapses it. Long names are ellipsized; hover to read the full name.
- With history retention off, unsaved content and archive/restore changes remain only in the current window and are lost on refresh, restart or plugin reload. Enabling retention saves current-window sessions, including their archive status.

In the model menu, select **模型 (Model)**, then **推理等级 (Effort)** to choose adapter-advertised levels. Its text size matches the target-language menu, including the custom-language field. The model search has no blue focus outline. Model and effort lists have no Back item; close and reopen the menu to return to its entry choices. **Default** is available when the adapter permits an unspecified effort. Models without reasoning metadata explicitly report that no levels are available.

A new topic's first session snapshots mode, target language, translation requirements and the per-request limit from settings. A child session copies its parent's configuration, including model and effort, with an empty input. Changing defaults does not rewrite existing sessions. A session can upgrade from quick to normal while retaining its input; it cannot downgrade, and other sessions in the topic do not upgrade automatically.

| Setting | Default and behavior |
| --- | --- |
| Translation mode | Quick. |
| Target language | Chinese. |
| Translation requirements | Empty; up to 4000 Unicode characters. |
| Per-request limit | 20000 source characters, configurable from 1 to 200000 Unicode characters; not a token limit. |
| Allow local session history | Off; enabling it automatically saves current-window sessions and subsequent edits, including archive status. |

**恢复默认设置** is at the top of the settings page. Restoring defaults disables future history writes while preserving existing sessions and history. There is no page-wide Save button. Invalid input or storage failures retain edited values and show an error; settings changes from other windows synchronize automatically.

## History and deletion

History uses the current device and Web origin's `localStorage`. Records are plaintext, are not synchronized between devices, do not modify the Host profile patch, and contain no API keys. They store topic/session identities, fixed sequences, names, remarks, archive status, the current source draft, default snapshots and model selection. Each submitted round of source and translated text stays only in runtime state and is not written to local history. DSH model message history is not connected.

Disabling retention preserves existing history while new session content and edits remain in the current runtime. Previously saved topics retain identity and sequence metadata without source or result content, so issued numbers are not reused after restart. Entirely temporary new topics do not become persistent for this purpose. Re-enabling retention saves the current content still in memory. Settings provides:

- **清除历史快译**: delete saved quick-translation sessions.
- **清除所有会话历史**: delete all saved plugin sessions; the confirmation scope includes unreadable history copies.
- **删除所选历史**: select one or multiple sessions for deletion.

Deletion requires confirmation and removes the affected sessions from the list. Context deletion handles both current in-memory content and saved history. Deleting a session does not cascade to its parent or children. History cleanup includes archived records. Changes during confirmation reject stale deletion. The confirmation asks whether related memory archives should also be deleted; that option is disabled until the memory system is connected. Shared-memory deletion scopes remain part of the future memory design.

Persistent topic creation, numbering, renaming and related writes use browser Web Locks for coordination. Environments without safe coordination report the limitation and restrict affected persistent operations; entirely temporary content can remain in the current window. Locks coordinate windows participating in this version's protocol; they do not turn multiple `localStorage` writes into a database transaction.

Read and write failures preserve current input. Stale writes produce a conflict; loading a local copy requires confirmation and overwriting is explicit. Partial cleanup reports an incomplete result, and deletion records prevent automatic re-import of old copies. Deleting all sessions does not reset a retained topic's sequence.

Saved v1 drafts and v2 sessions remain readable. Confirmed parent relationships group old sessions into topics with a unified sequence; old display names remain available. Uncertain relationships stay separate. Migration does not reconstruct deleted numbers that the old version never recorded. Compatibility reads do not bulk-rewrite original content; explicitly enabling retention or subsequent edits while enabled write new records. New sessions use the v3 structure, which older plugin versions cannot read. Avoid using old and new versions to modify the same history.

The old manual-save preference does not automatically enable new automatic history retention; the new option starts off. Disabling or uninstalling the plugin does not delete local history or preferences. Clean up explicitly in settings before removal when needed.

## Compatibility and installation

The previously inspected Windows DSH Desktop runtime was `0.2.0-rc.2`; the user had confirmed framework installation, removal and loading, and provided screenshots of the preceding session bar and main composer. Independent v0.3.1 acceptance by the coordinating agent on 2026-10-05 passed all 136 `npm test` cases and all 24 cases across three native integration entry points, with zero failures or skips; the build succeeded. `npm run test:native` includes those three entry points. Native integration uses actual DSH `0.2.0-rc.2` component packages in a disposable synthetic profile with a synthetic provider. This checks Host/Client component and RPC integration. The new mount entry point uses actual `ClientRemoteService`, Cordis and the current Client bundle to check automatic capability queries, synthetic translation and disposal. Quick translation has not been verified in the user's Desktop or against a real remote model. Other versions, operating systems and standalone Web profiles are unverified.

Requirements: Node.js 22 or later, pnpm and DSH with local bundle support.

```powershell
pnpm install --frozen-lockfile
pnpm build
```

Install this directory as the `dsh-translation-plugin` local bundle in DSH's plugin manager, enable it and restart. Runtime artifacts are generated into `dist/` and are not committed. Rebuild the same directory after changes to a linked installation.

When upgrading from an early framework build, refresh the bundle metadata containing the model catalog RPC dependencies in the plugin manager; if refresh is unavailable, uninstall and reinstall, then restart DSH. Do not edit the profile manually.

If previously installed as `dsh-deepseek-translation-plugin`, remove that old bundle and reinstall. For startup failures, use Desktop's recovery option to disable third-party plugins and inspect the diagnostic log.

## Development and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Commit messages use Conventional Commits with Chinese descriptions and bodies. Internal design materials are maintained outside this repository.

`pnpm test` builds first and checks sessions, history, legacy compatibility, the model directory and Client interactions. The separate native integration command and its DSH component requirement are described in [CONTRIBUTING.md](CONTRIBUTING.md). Synthetic providers do not verify a real remote model or the user's Desktop runtime.

See [CHANGELOG.md](CHANGELOG.md). The current local plugin version is `v0.3.1`, supporting plain-text Quick translation through DSH catalog models and reasoning efforts, with sending, result display and cancellation, and fixing service mounting and status presentation. Normal mode, file translation and memory are not connected. This version has not been published remotely. `private: true` prevents accidental npm publishing.

License: [MIT](LICENSE).
