# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A lightweight translation session panel for DeepSeek Harness (DSH). Quick mode translates plain text with a model already configured in DSH, retaining each admitted text unit, its revisions and one final-version selection. Local history is off by default; enabling it saves those records with session details and the current source draft.

Topic terminology and main-model management were added in `v0.6.0`.

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
- Manual editing saves a new revision with its original base version, without calling a model. Session context actions export final translations as TXT or complete browser session records as JSON.
- **记忆资产 (Memory assets)** opens an independent tab, initially as a DSH application floating panel. Category navigation provides translation records and structured terminology, including manual term creation/editing, source evidence, search, status filters, adoption, disable, deletion and export actions. Scoped main-model tools use the same authoritative browser store; Quick translation does not use these assets.
- Main-model session tools create sessions in the background, rename a topic, change an individual remark and archive or restore an explicit session. The title dropdown's **记忆资产 (Memory assets)** group includes retained topics without sessions; term panels export their existing snapshots as JSON or readable Markdown.
- **DSH Settings → 翻译** provides new-session defaults, history retention and history cleanup. Valid changes save immediately.

Quick execution is limited to plain text in Quick mode; Normal execution remains unavailable. A provider and model must already be configured in DSH. The plugin does not add provider or credential settings. Each translation uses only the built-in prompt, the unit's source text, target language, explicit requirements and selected catalog route; it excludes tools, main-chat messages or history, previous translations, files, and memory. If an operation's outcome is unknown during the current runtime, the client keeps its identity and queries that same operation; if Host confirms cancellation, it settles as cancelled. It will not automatically submit the request again.

The panel keeps a simple composer and transcript. Main-model terminology management is available; automatic integration with the main Send action and Normal translation execution remain unavailable. They require an official DSH extension before sending. Main-chat backup, a complete knowledge system, file translation and changes to an admitted unit's source or requirements are not connected. Previously saved manual text remains viewable.

**重新检查翻译服务 (Check translation service again)** only queries whether the DSH Host translation service and runtime components are ready. It sends no source text or model translation request and does not test model credentials or remote responses. The Client waits for DSH's asynchronous service mount before querying capabilities, avoiding a false unavailable status while the service is still mounting.

## Retranslation and final versions

1. Select a configured model and reasoning effort, enter source text and click Send. Host admission creates one text unit. Its source, target language and requirements stay fixed for later retranslations.
2. Click **重译 (Retranslate)** on that unit to produce another revision with the current model and effort. The new revision records this operation's model selection and time; any text in the composer remains a separate draft.
3. Click **展开旧版本 (Expand previous versions)** to read earlier results and status; **收起旧版本 (Collapse previous versions)** hides them again. **详情 (Details)** shows model, effort and times, plus prompt version and token usage when reported. Older records without call evidence show only the selected model; missing counts display “未提供” (Not provided), while reported zero stays zero. Reading or copying a version does not select it as final.
4. On a complete version, click **设为最终 (Set as final)** to fix that choice. Later trial translations keep it until you explicitly select another complete version.

When the next text unit is admitted, the immediately preceding unit's latest complete revision becomes its automatic final version, including a saved manual revision. Typing a draft, switching sessions, archiving or closing the panel does not finalize it. If the latest attempt failed, is incomplete or has an unknown outcome, the plugin does not silently choose an older success; an existing final selection is preserved. A historical unit's retranslations remain candidates until explicitly selected. Exporting final TXT applies the same automatic rule to the last unit only, preserving user-fixed choices. Final selection does not call a model.

## Manual revisions and export

1. Click **编辑 (Edit)** on a nonempty ended version: completed, failed, cancelled or interrupted. Edit its translation, then choose **保存为新版本 (Save as new version)** or **取消 (Cancel)**. A partial ended result can be corrected into a complete manual version. The new version records the displayed base version and does not change the unit's source, language or requirements. A later model result never silently changes that editing base.
2. Manual saving creates a candidate; **设为最终 (Set as final)** explicitly fixes it. A candidate can also qualify for automatic selection when the next unit is admitted or final TXT closes the last unit. Manual versions have no model call, route or usage. Unsaved editing drafts remain only in the current runtime, including while switching sessions, and are lost on reload.
3. Right-click the session title or name and choose **导出最终译文 TXT (Export final translations TXT)**. It closes only the last unit, then exports final selections in unit order. Missing finals are listed by text number; choose **仅导出已定稿 (Export only finalized units)** for a partial file or cancel. Failed or partial output is never substituted for a final, and an export with no final translations is unavailable.
4. Choose **导出完整记录 JSON (Export complete records JSON)** to capture session details and draft, all admitted units, revisions, events, final pointers and safe call fields with the export time. This action does not finalize units. It excludes temporary execution cards for drafts not admitted, Host handles, credentials, full provider configuration and main-chat history. A fixed prompt definition is included only for an explicitly recorded call; old `callRecord: null` stays unknown. JSON import or restore is not provided.

Editing, final selection and export do not call a model. Upgrading a Quick session to Normal keeps its existing text records editable and exportable; Normal execution is still unavailable. Explicit export also works with history retention off. Export does not enable history retention or create an additional automatic history store; persistence of the final selection follows the existing retention setting. Save the exported file through the browser. The UI reports that the browser download was initiated, not that a file was saved.

## Topic terms and main-model access

In the current title dropdown, choose a topic from **记忆资产 (Memory assets)**, or use the same action in a session's context menu. The entry is an open action and does not show a session-selection checkmark or selected background. The independent asset tab opens outside the translation transcript. Sessions in the same stable topic share one terminology record; renaming does not change that identity, and a new topic starts empty. Details show languages, sense, aliases, avoided translations, entry version and source references. Entries may be proposals, active, conflicting, awaiting review or disabled.

The asset view keeps the main-conversation and topic IDs captured when opened, and opening that same topic again reuses its tab. A newly opened view floats within DSH when its owning conversation is visible; an existing or restored tab keeps its docked/floating state. The floating caption shows the topic name with a normal arrow cursor and remains draggable. Use the host's controls to close, dock, move or resize it; the asset body has no separate close button. This is an application floating panel, not a Windows native child window. Closing the view leaves its assets intact but releases its unsaved editing drafts. Switching away from the visited translation tab keeps it mounted, preserving its current manual-edit drafts.

Choose **结构化档案 (Structured archive)** for terminology or **译文记录 (Translation records)** for the topic's existing text units. The record list shows each unit's read-only source and current final translation, plus a candidate only when its latest revision is complete; it does not skip a newer failure to show an older success. **编辑译文 (Edit translation)** followed by **保存新版本 (Save new version)** creates an immutable manual candidate without a model call; **设为最终 (Set as final)** is a separate action. Source text and machine execution records are not rewritten. Archived records remain readable; restore their session in the translation workspace before editing. **其他记忆 (Other memory)** and **临时文件 (Temporary files)** are labelled unavailable. Category and entry switching retain unsaved drafts within the mounted asset view; drafts are not persisted and are released when that view closes.

In the structured archive, click **新增术语 (Add term)** or **编辑术语 (Edit term)**, edit source forms/aliases, languages, sense and preferred/avoided translations, then **保存并采用 (Save and adopt)**. This single action creates or updates an explicitly confirmed active user rule, without another adoption confirmation. Editing preserves the entry ID, creation time and source references as examples. Stale versions or conflicting rules are reported without replacing another entry; unsaved form content remains available for review. Model tools cannot use this user-edit permission or overwrite confirmed user rules.

**搜索术语 (Search terms)** matches source forms, aliases, preferred/avoided translations and sense, excluding evidence bodies. **术语状态 (Term status)** selects all entries or one status. Filters affect only the list; exports still include the full snapshot. The list and selected details scroll separately in a wide view and use a single-column arrangement in a narrow view. Filters last while that view remains mounted; persisted filters after closing are not provided.

Ten tools belong only to that main conversation's Agent and communicate with the browser through a bidirectional bridge: list topics/sessions, create a session, rename a topic, set a session remark, archive/restore a session, read explicitly supplied historical units, list/query terms and propose or source-check an entry. Listing terms accepts a session ID or a topic ID, including a retained topic with no sessions. No tool directly deletes sessions, edits their drafts or model selections, changes defaults or upgrades their mode.

Session creation takes an explicit starting point: a new topic, a parent session or an existing topic. A new topic is used when expressly requested by the user; the model may organize same-topic sub-sessions within the work already assigned, without an extra confirmation each time. A parent-based session inherits its configuration with an empty draft and remark; an existing topic uses an available session's configuration, or current defaults when none remains. Creation and restoration keep the user's current focus. The creation reason appears in the tool receipt and is not copied into the remark. Rename affects all sessions in the identified topic; remark and archive changes target only the identified session. Expected names, remarks and archive states are checked under the existing topic lock. Receipts distinguish saved changes from runtime-only changes; a save failure reports that memory may already have changed and should be queried, without claiming a rollback.

Inferences remain proposals. A source-checked entry with readable source evidence and no conflict can become active directly; a proposal requires the explicit **采用 (Adopt)** action. Adopted user rules cannot be overwritten by a model. Resolve conflicting rules explicitly; the newest suggestion does not win automatically. **停用 (Disable)** keeps an entry for reference; **重新采用 (Adopt again)** explicitly reactivates it subject to conflict checks. **删除 (Delete)** removes the selected shared entry after confirmation.

Evidence references the existing source or final translation without copying its body into the terminology record. A changed/deleted basis becomes unavailable and the derived entry awaits review; queries exclude it immediately. Final evidence includes the final-selection event, so selecting the same old revision again does not revive an old basis. Losing a source example does not revoke an independently adopted user rule. Lookup matches explicitly requested source forms or aliases within the same owner, topic and languages; it does not guess terms from arbitrary English or code substrings. Quick lookup is empty, and Quick finals do not automatically extract terms.

For optional discussion of existing history, a session upgraded to Normal can expose an ended text unit through **供主模型参考 (Provide as main-model reference)** and withdraw it through **取消参考 (Cancel reference)**. This shares only the selected unit's frozen source, requirements, revisions and final metadata, not the current draft or unselected history. The reference selection lasts for the current runtime; **更新主模型参考 (Update reference)** refreshes that selected snapshot. This is an optional history-sharing action, not an extra step required for each translation. It does not send a translation request or implement Normal execution. Automatic main-Send integration remains blocked until DSH provides its official extension; a manual two-step sending workflow is not provided.

History retention controls term persistence too: enabling it saves one independent record per topic, while disabling it preserves old copies and keeps subsequent changes only in the current runtime. Re-enabling saves current contents still in memory. Read/write failures retain current facts; conflicting updates do not overwrite another window, and **读取最新术语 (Read latest terms)** explicitly loads its latest copy. Term records contain no duplicate source/final bodies, main-chat backup, Host capability or credentials. Existing TXT/JSON session exports do not include the separate term archive.

### Export a topic-term snapshot

Open a topic through **记忆资产 (Memory assets)** in the title dropdown, including one whose last session was deleted. In its independent asset tab, choose **导出 JSON (Export JSON)** or **导出 Markdown (Export Markdown)**. Both freeze the full current browser snapshot regardless of list filters, including all entry statuses, term content, versions, adoption records, update/export times, evidence references and their availability labels. Pending, conflicting, unavailable and disabled entries remain labelled; they are not presented as active rules.

The file contains the existing terminology record, not evidence bodies, main chat or a complete topic backup. Export does not call a model, extract or organize terms, change entries or final selections, enable history retention or create an extra automatic history store. It also works when retention is off. JSON import is not provided. Save the file through the browser; a download notice does not confirm that it was saved.

## Sessions and defaults

Enter a main-window conversation, expand the right Sidebar and open “翻译” from its guide. Translation sessions are currently grouped by their owning main-window conversation, with independent translation session IDs. This UI grouping does not imply that quick translation execution uses the main model.

- Click the current title to list existing sessions and switch while retaining each session's input. The dropdown provides a centered **+** for a new topic and its first session, as well as archived-session restore actions.
- The title dropdown's single **记忆资产 (Memory assets)** group lists retained topics for the owning main conversation, including topics with no sessions; open one to view its assets.
- Active sidebar sessions appear in creation order; a centered **+** follows the last item and also creates a new topic and its first session. Both **+** actions cover their full row; the sidebar hit area matches the session-name rows.
- Right-click a session name or the current title to create a session in the same topic, rename the topic, edit the session remark, export TXT/JSON, delete or archive. The rename dialog explains its effect on all sessions in the topic. An open title dropdown remains visible while its context menu is used; selecting an action closes both menus before opening a dialog or applying the action. Escape dismisses the context menu first; clicking outside dismisses both menus. Actions target the clicked session without requiring it to be selected first.
- Archiving preserves content and removes the session from the active list. Expand **已归档 (Archived)** and click a session to restore it, or choose **恢复归档 (Restore)** from its context menu. There is no Close action.
- The session sidebar starts collapsed; the header's sidebar icon expands or collapses it. Long names are ellipsized; hover to read the full name.
- With history retention off, unsaved content and archive/restore changes remain only in the current window and are lost on refresh, restart or plugin reload. Enabling retention saves current-window sessions, including their archive status.

In the model menu, select **模型 (Model)**, then **推理等级 (Effort)** to choose adapter-advertised levels. Its text size matches the target-language menu, including the custom-language field. The model search has no blue focus outline. Model and effort lists have no Back item; close and reopen the menu to return to its entry choices. **Default** is available when the adapter permits an unspecified effort. Models without reasoning metadata explicitly report that no levels are available.

Native menu positioning updates when entering a model or effort list or when search results change.

A new topic's first session snapshots mode, target language, translation requirements and the per-request limit from settings. A child session copies its parent's configuration, including model and effort, with an empty input. Changing defaults does not rewrite existing sessions. A session can upgrade from quick to normal while retaining its input; it cannot downgrade, and other sessions in the topic do not upgrade automatically.

Model and reasoning effort preferences are saved independently of history retention. Each recoverable translation session keeps its own choice; a new topic's first session starts with the last choice for its owning main-window conversation. Temporary sessions do not recover after restart, but that conversation's last model preference does. A child session uses its parent's selection, including an explicitly empty selection. Other existing sessions keep their own choices. Storage failures preserve the current selection and display a notice. A choice missing from the current Host catalog remains visible but cannot be used to send.

| Setting | Default and behavior |
| --- | --- |
| Translation mode | Quick. |
| Target language | Chinese. |
| Translation requirements | Empty; up to 4000 Unicode characters. |
| Per-request limit | 20000 source characters, configurable from 1 to 200000 Unicode characters; not a token limit. |
| Allow local session history | Off; enabling it saves topic names, session details, archive status, the current source draft, admitted text units, all revisions and their final selections for restart recovery, plus separate shared-topic terms. Model and reasoning effort preferences save independently. Selected files are excluded. |

**恢复默认设置** is at the top of the settings page. Restoring defaults disables future history writes while preserving existing sessions and history. There is no page-wide Save button. Invalid input or storage failures retain edited values and show an error; settings changes from other windows synchronize automatically.

## History and deletion

History and model preferences use the current device and Web origin's `localStorage`. Records are plaintext, are not synchronized between devices, do not modify the Host profile patch, and contain no API keys or Host capability handles. When **允许保存会话历史到本地 (Allow local session history)** is enabled, history stores topic/session identities, fixed sequences, names, remarks, archive status, the current source draft and default snapshots, plus admitted units' source text, requirements, language, machine/manual revisions, execution status, safe actual call metadata and final selections. These recover on restart. Each revision body is stored once; events and final selections reference it. Unsaved editing drafts are excluded.

Restoration does not resume or resend model requests. Previously running or unsettled revisions show **重启前未确认／已中断 (Unconfirmed before restart / Interrupted)**, with a message distinguishing unknown outcomes. Review it before explicitly retranslating, which starts a new request in the same user text unit. Restored records cannot query the previous Host operation. A new draft that failed before admission has no saved text unit; its temporary execution card is not restored. Selected files are excluded from history and are released when the panel closes, the owning main-window conversation changes or their translation session is deleted; selecting a file does not upload it or make file translation available. DSH model message history is not connected.

Disabling retention preserves existing history while subsequent renames, new units, revisions and final selections remain in the current runtime and do not replace saved copies. Independent model preferences continue saving and contain only the provider ID, model ID and optional reasoning effort. They give recoverable sessions their latest choices without rewriting old history content. Deleting a session removes its own preference; history cleanup preserves the last model preference for its owning main-window conversation as a default for new sessions. Previously saved topics retain identity and sequence metadata without source or result content, so issued numbers are not reused after restart. Entirely temporary new topics do not become persistent for this purpose. Re-enabling retention saves current content still in memory, including changes made while it was off; it cannot recover content already lost. Settings provides:

- **清除历史快译**: delete saved quick-translation sessions.
- **清除所有会话历史**: delete all saved plugin sessions; the confirmation scope includes unreadable history copies.
- **删除所选历史**: select one or multiple sessions for deletion.

Deletion requires confirmation and removes the affected sessions from the list. Context deletion handles both current in-memory content and saved history. Deleting a session does not cascade to its parent or children. History cleanup includes archived records. Topic terms remain by default, including after the last session is deleted. To remove them too, explicitly check the confirmation's shared-topic terminology option; unselected sessions in those topics also lose those terms. Both session and term versions are frozen and checked before removal. Partial failures report the remaining scope; multiple storage removals are not claimed as atomic.

Persistent topic creation, numbering, renaming and related writes use browser Web Locks for coordination. Environments without safe coordination report the limitation and restrict affected persistent operations; entirely temporary content can remain in the current window. Locks coordinate windows participating in this version's protocol; they do not turn multiple `localStorage` writes into a database transaction.

Read and write failures preserve current input. Stale writes produce a conflict; loading a local copy requires confirmation and overwriting is explicit. Partial cleanup reports an incomplete result, and deletion records prevent automatic re-import of old copies. Deleting all sessions does not reset a retained topic's sequence.

Saved v1 drafts and schema2/3/4 sessions remain readable. Confirmed parent relationships group old sessions into topics with a unified sequence; old display names remain available. Uncertain relationships stay separate. Migration does not reconstruct deleted numbers that the old version never recorded. Compatibility reads do not rewrite saved content; explicitly enabling retention or subsequent edits while enabled write the current format. Snapshots containing text records now use schema5 with history2; empty records still use schema3. Versions 0.4.x and earlier cannot read schema5. Back up the application's local data before downgrading, and avoid modifying the same history with older versions. Exported JSON is a session record, with no import/restore feature, and does not replace that backup.

The old manual-save preference does not automatically enable new automatic history retention; the new option starts off. Disabling or uninstalling the plugin does not delete local history, terminology or preferences. Clean up explicitly before removal when needed.

## Compatibility and installation

The plugin targets DSH `0.2.0-rc.2` components. Automated checks cover Quick Host/Client, mounting, scoped topic tools and storage, using a disposable synthetic profile and provider. UI and browser-download checks are simulated; Menu/Sidebar contract checks use installed component logic with synthetic dimensions and actions. These checks do not cover real remote providers, actual Desktop DOM, file-save dialogs or floating-panel movement, resizing and docking. Other DSH versions, operating systems and standalone Web profiles are unverified. Windows native child windows are unavailable.

Requirements: Node.js 22 or later, pnpm and DSH with local bundle support.

```powershell
pnpm install --frozen-lockfile
pnpm build
```

Install this directory as the `dsh-translation-plugin` local bundle in DSH's plugin manager, enable it and restart. Runtime artifacts are generated into `dist/` and are not committed. Rebuild the same directory after changes to a linked installation. When upgrading to v0.8.0, refresh the Client bundle registration (or reinstall if refresh is unavailable), then restart so the independent resource tabs are registered; Host and data formats remain unchanged.

When upgrading from an early framework build, refresh the bundle metadata containing the model catalog RPC dependencies in the plugin manager; if refresh is unavailable, uninstall and reinstall, then restart DSH. Do not edit the profile manually.

If previously installed as `dsh-deepseek-translation-plugin`, remove that old bundle and reinstall. For startup failures, use Desktop's recovery option to disable third-party plugins and inspect the diagnostic log.

## Development and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Commit messages use Conventional Commits with Chinese descriptions and bodies. Internal design materials are maintained outside this repository.

`pnpm test` builds first and checks sessions, history, legacy compatibility, the model directory and Client interactions. The separate native integration command and its DSH component requirement are described in [CONTRIBUTING.md](CONTRIBUTING.md). Synthetic providers do not verify real remote models or actual Desktop integration.

The shared call-record module provides optional RPC metadata for the actual model, effort, output limit, prompt version and reported token usage. Client details show the recorded model, effort, prompt version and usage; retained browser records and JSON exports also include the output limit. Unavailable configuration versions and counts remain `null`; legacy calls are not inferred from the current prompt. Manual revisions have no call metadata.

The topic-term core defines scoped references, versions, adoption, conflicts and exact-form lookup. `TopicMemoryStore` saves one topic record under the existing Web Locks and history-retention policy. `SessionStore` remains the only source/final authority. Host tools hold transient execution scope and never save a second terminology/history database. One combined remote contribution registers both Quick and topic-management namespaces, preserving their coexistence.

Session management uses narrow asynchronous Store methods with expected metadata checked inside the same structure lock. The existing UI still activates sessions it creates or restores; model tools use background activation. Topic-term JSON/Markdown builders are pure projections of a frozen browser snapshot, with reference labels but no duplicated evidence text.

See [CHANGELOG.md](CHANGELOG.md). The current local version is `v0.8.4`, with independent memory-asset tabs and application floating panels, terminology editing and translation-record details. Other memory and temporary-file categories remain unavailable. Background main-model session management, topic-term snapshot export, plain-text Quick retranslation, manual revisions, final selection, TXT/JSON export and optional restart recovery remain available. Model preferences save independently. Normal execution and automatic main-Send integration remain unavailable until DSH provides the official extension; file translation and a complete knowledge system also remain unavailable. Local versions have not been published remotely. `private: true` prevents accidental npm publishing.

License: [MIT](LICENSE).
