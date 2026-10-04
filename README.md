# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A translation session panel for DeepSeek Harness (DSH). This early development build provides session management, model selection and a dedicated settings page. Translation execution is not connected yet.

## Current features

- A right Sidebar panel with a title dropdown for existing sessions and a collapsible session list, collapsed by default. Each independent session retains its own input and configuration.
- **+** creates a new topic and its first session, initially named “新翻译会话”. Creating from an existing session uses the next sequence in that same topic, such as “故事A-01” and “故事A-02”. Creating from a child does not nest suffixes or fill deleted sequence numbers.
- Rename changes the topic name for all its sessions while keeping IDs and sequence numbers. Each session also has an independent remark, which may be duplicated or cleared.
- A left-aligned current title dropdown with context actions and right-aligned mode/language controls, a scrollable conversation area and a simple composer with a circular Send button and no blue focus outline on its text area.
- Model selection sits at the composer's lower right, immediately left of Send. It uses DSH's native menus and icons and the same `session.modelCatalog()` directory API as the main composer. Its model/effort menu supports provider groups and search; selection applies only to the current translation session.
- **DSH Settings → 翻译** provides new-session defaults, history retention and history cleanup. Valid changes save immediately.

Sending is disabled. Catalog requests read model metadata, without sending translation text or changing the main chat's model. The Host now provides runtime foundations for units, attempts, revisions and final selections, but the panel's business RPC and a real execution adapter are not connected. Memory archives and formal export are also not connected. The previous manual translation editor and export controls have been removed; previously saved manual text remains viewable.

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

History uses the current device and Web origin's `localStorage`. Records are plaintext, are not synchronized between devices, do not modify the Host profile patch, and contain no API keys. They store topic/session identities, fixed sequences, names, remarks, archive status, input, default snapshots and model selection. Model message history is not connected.

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

The locally inspected Windows DSH Desktop runtime is `0.2.0-rc.2`. The user previously confirmed framework installation, removal and loading, and provided screenshots of the preceding session bar and main composer. This revision's topic numbering, migration, remarks, asynchronous storage and Host foundations still need Desktop verification. Other versions, operating systems and standalone Web profiles are unverified.

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

`pnpm test` builds first and checks sessions, history, legacy compatibility, the model directory and Client interactions. React hooks, native menus and RPCs are simulated; these checks do not replace Desktop verification.

See [CHANGELOG.md](CHANGELOG.md). The current local plugin version is `v0.2.0`, adding topic sessions and Host execution foundations; `v0.1.1` provided the interactive panel and `v0.1.0` was the framework baseline. This version has not been published to npm or a remote release page. `private: true` prevents accidental npm publishing.

License: [MIT](LICENSE).
