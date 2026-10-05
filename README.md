# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A lightweight translation session panel for DeepSeek Harness (DSH). Quick mode translates plain text with a model already configured in DSH, retaining each admitted text unit, its revisions and one final-version selection. Local history is off by default; enabling it saves those records with session details and the current source draft.

## Current features

- A right Sidebar panel with a title dropdown for existing sessions and a collapsible session list, collapsed by default. Each independent session retains its own input and configuration.
- **+** creates a new topic and its first session, initially named “新翻译会话”. Creating from an existing session uses the next sequence in that same topic, such as “故事A-01” and “故事A-02”. Creating from a child does not nest suffixes or fill deleted sequence numbers.
- Rename changes the topic name for all its sessions while keeping IDs and sequence numbers. Each session also has an independent remark, which may be duplicated or cleared.
- A left-aligned current title dropdown with context actions and right-aligned mode/language controls, a scrollable conversation area and a simple composer with a circular Send button and no blue focus outline on its text area.
- Creating or switching sessions keeps one mode control and one target-language control in the header, without accumulating inactive copies.
- Service checking, unavailable status and the Normal mode limitation appear immediately above and outside the composer. Quick mode provides a compact check icon at the right of the status line, disabled while checking; the line disappears when the service is ready. A single history-retention note appears in the records area after translation records exist.
- Model selection sits at the composer's lower right, immediately left of Send. It uses DSH's native menus and icons and the same `session.modelCatalog()` directory API as the main composer. Its model/effort menu supports provider groups and search; selection applies only to the current translation session.
- The composer toolbar has a file selection control. Quick mode disables it. Normal mode can select one file, replace it or remove it, with its name shown in the composer; the selection belongs to that translation session and lasts only while the panel remains open. File reading, parsing, upload and translation are not connected, and selections do not recover on restart.
- Quick mode sends the current plain-text draft, target language and explicit translation requirements through a selected DSH Host model, then displays the source and translated result in the conversation area. Only models and reasoning efforts exposed by the Host catalog are selectable.
- Each admitted text unit keeps all translation revisions. Retranslation reuses that unit's source, language and requirements with the currently selected model; it leaves any new draft untouched. Previous versions can be expanded, and one complete version can be selected as final.
- **DSH Settings → 翻译** provides new-session defaults, history retention and history cleanup. Valid changes save immediately.

Quick execution is limited to plain text in Quick mode; Normal mode remains unavailable. A provider and model must already be configured in DSH. The plugin does not add provider or credential settings. Each translation uses only the built-in prompt, the unit's source text, target language, explicit requirements and selected catalog route; it excludes tools, main-chat messages or history, previous translations, files, and memory. If an operation's outcome is unknown during the current runtime, the client keeps its identity and queries that same operation; if Host confirms cancellation, it settles as cancelled. It will not automatically submit the request again.

The panel keeps a simple composer and transcript. Main-model collaboration, main-chat backup, memory, file translation, manual revision editing, changes to an admitted unit's source or requirements, and export are not connected. Previously saved manual text remains viewable.

**重新检查翻译服务 (Check translation service again)** only queries whether the DSH Host translation service and runtime components are ready. It sends no source text or model translation request and does not test model credentials or remote responses. The Client waits for DSH's asynchronous service mount before querying capabilities, avoiding a false unavailable status while the service is still mounting.

## Retranslation and final versions

1. Select a configured model and reasoning effort, enter source text and click Send. Host admission creates one text unit. Its source, target language and requirements stay fixed for later retranslations.
2. Click **重译 (Retranslate)** on that unit to produce another revision with the current model and effort. The new revision records its actual model and time; any text in the composer remains a separate draft.
3. Click **展开旧版本 (Expand previous versions)** to read earlier results and status; **收起旧版本 (Collapse previous versions)** hides them again. **详情 (Details)** shows the actual model, effort and times. Reading or copying a version does not select it as final.
4. On a complete version, click **设为最终 (Set as final)** to fix that choice. Later trial translations keep it until you explicitly select another complete version.

When the next text unit is admitted, the immediately preceding unit's latest complete successful revision becomes its automatic final version. Typing a draft, switching sessions, archiving or closing the panel does not finalize it. If the latest attempt failed, is incomplete or has an unknown outcome, the plugin does not silently choose an older success; an existing final selection is preserved. A historical unit's retranslations remain candidates until explicitly selected. To finalize the last unit without sending another, select its version yourself. Final selection does not call a model.

## Sessions and defaults

Enter a main-window conversation, expand the right Sidebar and open “翻译” from its guide. Translation sessions are currently grouped by their owning main-window conversation, with independent translation session IDs. This UI grouping does not imply that quick translation execution uses the main model.

- Click the current title to list existing sessions and switch while retaining each session's input. The dropdown provides a centered **+** for a new topic and its first session, as well as archived-session restore actions.
- Active sidebar sessions appear in creation order; a centered **+** follows the last item and also creates a new topic and its first session. Both **+** actions cover their full row; the sidebar hit area matches the session-name rows.
- Right-click a session name or the current title to create a session in the same topic, rename the topic, edit the session remark, delete or archive. The rename dialog explains its effect on all sessions in the topic. An open title dropdown remains visible while its context menu is used; selecting an action closes both menus before opening a dialog or applying the action. Escape dismisses the context menu first; clicking outside dismisses both menus. Actions target the clicked session without requiring it to be selected first.
- Archiving preserves content and removes the session from the active list. Expand **已归档 (Archived)** and click a session to restore it, or choose **恢复归档 (Restore)** from its context menu. There is no Close action.
- The session sidebar starts collapsed; the header's sidebar icon expands or collapses it. Long names are ellipsized; hover to read the full name.
- With history retention off, unsaved content and archive/restore changes remain only in the current window and are lost on refresh, restart or plugin reload. Enabling retention saves current-window sessions, including their archive status.

In the model menu, select **模型 (Model)**, then **推理等级 (Effort)** to choose adapter-advertised levels. Its text size matches the target-language menu, including the custom-language field. The model search has no blue focus outline. Model and effort lists have no Back item; close and reopen the menu to return to its entry choices. **Default** is available when the adapter permits an unspecified effort. Models without reasoning metadata explicitly report that no levels are available.

A new topic's first session snapshots mode, target language, translation requirements and the per-request limit from settings. A child session copies its parent's configuration, including model and effort, with an empty input. Changing defaults does not rewrite existing sessions. A session can upgrade from quick to normal while retaining its input; it cannot downgrade, and other sessions in the topic do not upgrade automatically.

Model and reasoning effort preferences are saved independently of history retention. Each recoverable translation session keeps its own choice; a new topic's first session starts with the last choice for its owning main-window conversation. Temporary sessions do not recover after restart, but that conversation's last model preference does. A child session uses its parent's selection, including an explicitly empty selection. Other existing sessions keep their own choices. Storage failures preserve the current selection and display a notice. A choice missing from the current Host catalog remains visible but cannot be used to send.

| Setting | Default and behavior |
| --- | --- |
| Translation mode | Quick. |
| Target language | Chinese. |
| Translation requirements | Empty; up to 4000 Unicode characters. |
| Per-request limit | 20000 source characters, configurable from 1 to 200000 Unicode characters; not a token limit. |
| Allow local session history | Off; enabling it saves topic names, session details, archive status, the current source draft, admitted text units, all revisions and their final selections for restart recovery. Model and reasoning effort preferences save independently. Selected files are excluded. |

**恢复默认设置** is at the top of the settings page. Restoring defaults disables future history writes while preserving existing sessions and history. There is no page-wide Save button. Invalid input or storage failures retain edited values and show an error; settings changes from other windows synchronize automatically.

## History and deletion

History and model preferences use the current device and Web origin's `localStorage`. Records are plaintext, are not synchronized between devices, do not modify the Host profile patch, and contain no API keys or Host capability handles. When **允许保存会话历史到本地 (Allow local session history)** is enabled, history stores topic/session identities, fixed sequences, names, remarks, archive status, the current source draft and default snapshots, plus admitted units' source text, requirements, language, revisions, execution status, actual models and final selections. These recover on restart. Each revision body is stored once; events and final selections reference it.

Restoration does not resume or resend model requests. Previously running or unsettled revisions show **重启前未确认／已中断 (Unconfirmed before restart / Interrupted)**, with a message distinguishing unknown outcomes. Review it before explicitly retranslating, which starts a new request in the same user text unit. Restored records cannot query the previous Host operation. A new draft that failed before admission has no saved text unit; its temporary execution card is not restored. Selected files are excluded from history and are released when the panel closes, the owning main-window conversation changes or their translation session is deleted; selecting a file does not upload it or make file translation available. DSH model message history is not connected.

Disabling retention preserves existing history while subsequent renames, new units, revisions and final selections remain in the current runtime and do not replace saved copies. Independent model preferences continue saving and contain only the provider ID, model ID and optional reasoning effort. They give recoverable sessions their latest choices without rewriting old history content. Deleting a session removes its own preference; history cleanup preserves the last model preference for its owning main-window conversation as a default for new sessions. Previously saved topics retain identity and sequence metadata without source or result content, so issued numbers are not reused after restart. Entirely temporary new topics do not become persistent for this purpose. Re-enabling retention saves current content still in memory, including changes made while it was off; it cannot recover content already lost. Settings provides:

- **清除历史快译**: delete saved quick-translation sessions.
- **清除所有会话历史**: delete all saved plugin sessions; the confirmation scope includes unreadable history copies.
- **删除所选历史**: select one or multiple sessions for deletion.

Deletion requires confirmation and removes the affected sessions from the list. Context deletion handles both current in-memory content and saved history. Deleting a session does not cascade to its parent or children. History cleanup includes archived records. Changes during confirmation reject stale deletion. The confirmation asks whether related memory archives should also be deleted; that option is disabled until the memory system is connected. Shared-memory deletion scopes remain part of the future memory design.

Persistent topic creation, numbering, renaming and related writes use browser Web Locks for coordination. Environments without safe coordination report the limitation and restrict affected persistent operations; entirely temporary content can remain in the current window. Locks coordinate windows participating in this version's protocol; they do not turn multiple `localStorage` writes into a database transaction.

Read and write failures preserve current input. Stale writes produce a conflict; loading a local copy requires confirmation and overwriting is explicit. Partial cleanup reports an incomplete result, and deletion records prevent automatic re-import of old copies. Deleting all sessions does not reset a retained topic's sequence.

Saved v1 drafts and schema2/3 sessions remain readable. Confirmed parent relationships group old sessions into topics with a unified sequence; old display names remain available. Uncertain relationships stay separate. Migration does not reconstruct deleted numbers that the old version never recorded. Compatibility reads do not bulk-rewrite original content; explicitly enabling retention or subsequent edits while enabled write new records. Snapshots containing text records use schema4. Versions 0.3.3 and earlier cannot read them; 0.3.4 has storage support but no translation-history interface. Back up the application's local data before downgrading, and avoid modifying the same history with older versions. The plugin has no export feature.

The old manual-save preference does not automatically enable new automatic history retention; the new option starts off. Disabling or uninstalling the plugin does not delete local history or preferences. Clean up explicitly in settings before removal when needed.

## Compatibility and installation

The previously inspected Windows DSH Desktop runtime was `0.2.0-rc.2`; the user's current DSH version has not been reconfirmed. Independent v0.4.0 acceptance by the coordinating agent on 2026-10-06 passed all 187 `npm test` cases, all 26 cases across three native integration entry points and seven separate checks, with zero failures or skips; the build succeeded. UI checks use a lightweight hook renderer, synthetic events and storage fixtures; these are not actual DOM or Desktop validation. `npm run test:native` includes those three entry points. Native integration uses actual DSH `0.2.0-rc.2` component packages in a disposable synthetic profile with a synthetic provider. This checks Host/Client component and RPC integration. The mount entry point uses actual `ClientRemoteService`, Cordis and the current Client bundle to check automatic capability queries, synthetic translation and disposal. Quick translation has not been verified in the user's Desktop or against a real remote model. Other versions, operating systems and standalone Web profiles are unverified.

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

See [CHANGELOG.md](CHANGELOG.md). The current local version is `v0.4.0`, adding plain-text Quick retranslation, all revisions, one final selection per unit and optional restart recovery to sending, result display and cancellation. Model preferences save independently of history retention. Normal execution, file translation, memory, manual editing and export are not connected. This version has not been published remotely. `private: true` prevents accidental npm publishing.

License: [MIT](LICENSE).
