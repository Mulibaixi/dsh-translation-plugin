# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A dedicated translation workspace for DeepSeek Harness (DSH), with room for translation, discussion, and reusable knowledge.

Use the main chat for background and instructions, the translation workspace for source material, revisions, and delivery, and memory assets for terminology and topic knowledge. It suits stories, game scripts, and academic material that need consistent wording and context across sessions.

## Why use it

- **Separate translation from discussion**: keep sources and translations in the workspace, with instructions and explanations in the main chat.
- **Build knowledge within a topic**: share terms, entities, facts, relations, and reference originals across translation sessions.
- **Compare and revise translations**: retain versions, request retranslation, edit text, and choose a final version.
- **Keep memory visible and editable**: inspect evidence, edit or adopt entries, disable rules, and clean up material.
- **Use DSH's model configuration**: choose an existing model and reasoning effort; configure an embedding API separately if needed.

## What it can do today

| Capability | Current scope |
| --- | --- |
| Quick translation | Translate plain text directly for independent sentences and occasional lookups. |
| Normal translation | Let the main model organize requirements and context before calling the translation model; discuss, retranslate, and correct sources. |
| File translation | Read text or recognize file content, translate ranges when needed, and deliver reviewed versions through the session. |
| Topics and sessions | Create topics and child sessions, add remarks, reorder and archive them, and reuse them across main chats in one local library. |
| Memory assets | Maintain four structured archives, topic/user settings, and topic original/bilingual files. |
| Memory retrieval | Find current bilingual text with ordinary search; use an embedding API for active archives, reference text, and current translation examples. |
| Versions and export | Retain older versions, select finals, and export translation TXT or bilingual JSON by session or topic. |
| Storage and cleanup | Save history and memory on the Host, load content on demand, and clean up versions, units, sessions, topics, or the plugin. |

The project is still in development. Text/TXT translation can support a workflow with human review; translation quality and memory adoption still need checking, and completion time is not guaranteed. Builds, synthetic model checks, and browser tests do not replace real-model quality or native desktop verification.

## Requirements

- DSH `0.2.0-rc.2` or `0.2.1-rc.2`, with local plugin support and a configured model.
- **Quick mode** does not require the Composer extension. **Normal mode** requires the matching `dsh-composer-extension` and a Composer submission patch for your DSH version. Installing the extension alone does not add material submission to an unpatched official build.
- The paired sources use content protocol 3 and task-phase protocol 2. Keep the translation plugin, Composer extension, and Host patch compatible; reapply the matching patch after a DSH upgrade.
- File asset extraction uses native DSH subagents through the supported run/Activation interfaces. Missing capabilities are reported; the main model can still read and translate text originals directly.
- The Host must load built-in `node:sqlite`. Building from source requires Node.js 22 or newer, pnpm, and the Composer extension source directory alongside this repository.

Source files can use any format, up to 2 MiB each. UTF-8 text is directly readable; other files require recognition or OCR by the main model. TXT, Markdown, JSON, and HTML results can be saved directly; other output formats depend on model capabilities. Readable reference formats are listed below.

Model calls may incur charges; local storage does not make translation offline. The memory window floats or docks inside DSH.

## Installation and updates

### Install

1. Build the Composer extension according to its instructions, then run in this plugin directory:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. Install and enable this directory as the local `dsh-translation-plugin` in DSH's plugin manager. Normal mode also needs the paired Composer extension and Host patch.
3. Restart DSH and open **翻译 (Translation)** in the main chat's right sidebar. Follow dependency messages to check the paired builds.

### Update

Save and back up material you need, update both source directories, build the Composer extension followed by the translation plugin, then fully restart DSH. A build or page refresh alone does not replace running Host code.

When upgrading to this version:

- Legacy browser test history is not imported automatically; export important content first. To translate legacy file/document tasks again, resend the original through the current file input.
- Reference registration now accepts original/bilingual files. Legacy “other reference” entries retain original opening and deletion only; existing full-text files need a complete main-model segmentation plan before new semantic indexing.
- Older versions may not read newly saved data. Do not run old and new versions against the same library. Exports currently cannot be imported for restoration and do not replace a complete backup.

Disabling or uninstalling the plugin does not automatically delete local material. See [CHANGELOG](CHANGELOG.md) for version changes.

## User guide

### 1. Create a topic and translation session

Choose **新建主题及首会话 (New topic and first session)** or **选择已有主题 (Choose existing topic)**. A topic groups memory for a story or project; translation sessions separate individual tasks. Reuse one local library across main chats, and browse saved material without an active main chat.

- Use **+** in the title menu for a new topic, or **新建子会话 (New child session)** in a session's context menu to continue in its topic.
- **重命名 (Rename)** changes the topic name; **备注 (Remark)** changes only that session's display name. Long-press and drag a session row to reorder it.
- **关闭 (Close)** removes a session from the current chat's open list; **归档 (Archive)** retains it; **删除 (Delete)** removes content after confirmation.

Model selection is at the input's lower right; target language and mode are at the top. A session can move from Quick to Normal; create another session to use Quick again. Unit numbers remain stable and deleted numbers are not reused.

### 2. Quick: get a translation directly

Select Quick mode, a target language, and a model, then enter and send plain text. Quick mode does not read main-chat context, topic memory, or references, and does not accept files. Use Normal mode when terminology or background matters.

### 3. Normal: translate with requirements and background

**Put the source in the translation input, and instructions or discussion in the main chat.** Open the translation session in the current chat, then choose how to send:

- **Send with instructions**: prepare text or a file in the workspace, write this submission's instructions in the main chat, and send. Material requests translation unless this submission explicitly asks for learning, discussion, or no translation yet.
- **Send material directly**: use the workspace's send button to ask the current main model to translate. Unsent text in the main-chat input is not included.

Editing the input afterward does not alter the submitted source. To correct a source or revise a translation, identify the unit and requirement in the main chat, for example, “Use units 2 and 4 as wording references, and revise unit 5.” Include the session name for another session. The main model can read source, final text, or a specified version in opened sessions as needed.

Normal text and files use the same current translation flow. Long originals can be translated by source ranges, with continuous coverage required. The main model waits for the actual result, reads the translation independently, compares it with the source, and appends justified corrections to the same unit. Automated review still needs human checking.

Originals and translation versions appear as file links. Delivery stays in the session by default; opening generates a readable filename and repeated opens reuse the same version file. Separate exports are created only when explicitly requested. Text results preserve the source BOM and uniform CRLF line endings. JSON, HTML, and similar inputs prompt for an output form if unspecified.

Normal translation reads applicable settings and selected memory. Short text can automatically match identical expressions in reference originals; similar examples, long files, and background facts use the main model's search, accurate read, and context selection. Corrections receive the exact previous translation, and nearby dialogue uses effective finals. A search hit does not guarantee correct adoption.

Withdrawing material notifies the main model's following steps; use cancellation for executing tasks. After reload, check interrupted or unknown tasks through query, cancel, or retranslate controls before retrying. Restart does not automatically replay model calls, and tasks do not transfer automatically to another main chat.

### 4. Memory assets: maintain shared topic knowledge

Open **记忆资产 (Memory assets)** from the title menu or a session's context menu. Browsing another topic does not change the workspace's active session. You can also provide material in the main chat and ask to learn it or establish topic memory: the main model reads actual material, retains evidence, checks existing entries, and creates assets without requiring a translation first.

| Category | Content |
| --- | --- |
| Terms | Source forms, preferred translations, and necessary meaning or usage conditions. |
| Entities | People, places, organizations, aliases, and descriptions. |
| Facts | Important facts about the topic, optionally linked to entities. |
| Relations | Connections between entities, including forms of address and their conditions. |
| Other memory | Topic/user translation settings beyond the source, plus topic original/bilingual files. |

Inspect evidence, add, edit, adopt, disable, or delete archive entries. The main model can edit existing entries; changed content returns to pending review, while unchanged content retains its state. Conflicts or changed evidence need review. Sessions share memory within a topic; topics remain separate.

Candidates live in their corresponding categories. **一键采用 (Adopt this category)** processes all pending and review-required entries in the current topic/category, regardless of page filters. Adopt linked entities before facts or relations. Entries that cannot be adopted remain pending with an unfinished count; candidates do not block translation delivery.

Translation priority is **user instructions = user-edited entries > user-reviewed entries > pending entries = model interpretation**. Conflicting user instructions and user-edited entries require clarification. Candidates do not automatically overwrite active assets, and model-authored explanations do not become user instructions.

**Translation settings** can be created, edited, enabled, disabled, or deleted, including by the main model. Normal translation and retranslation read all applicable enabled entries in full. User scope applies across this local library; other requirements default to the topic. Keep rules concise and accurate, preserving conditions; single edits, incidental renderings, and model self-checks do not automatically become lasting rules. Budget errors ask you to shorten or disable entries.

**Topic reference files** accept original/bilingual files only, up to 2 MiB each. The list shows names, segmentation progress, and original-file links without text previews. Upload notifies the current main model to mark segment boundaries, with incremental submission and continuation after interruption. The program extracts original text at those boundaries without rewriting files, automatically aligning bilingual text, or inventing translations.

Once the full segmentation plan is complete, the configured embedding service queues indexing. Before completion, originals can still be opened, read, and searched literally. Readable formats are UTF-8 TXT, Markdown, CSV, TSV, JSON, JSONL, LOG, and RST. Other formats provide original-file links; their useful content can be distilled into assets or settings in the main chat.

**Translation records** show source and translation side by side for a session or topic. The ordinary search box matches only current source and effective final translation bodies, ignoring English letter case, with counts, highlighting, and previous/next navigation. Fixed page labels, older versions, and unselected candidates are excluded. Incomplete searches are reported; search does not call models or select finals. Images, tables, and similar objects can link to originals without implying automatic parsing or translation.

### 5. Revise, finalize, and export

- **重译 (Retranslate)** appends a version while retaining the source and previous output. **编辑 (Edit)** adds a manual version for short text. Request file changes through the main chat; external file edits do not write back automatically.
- A complete translation establishes an automatic final that follows later corrections. **设为最终 (Set final)** fixes a human choice, which new versions do not replace automatically. Incomplete or cancelled output does not become final.
- Search, export, and semantic retrieval use the same effective final for a file; translations from different source versions are not mixed, and old versions are excluded from default retrieval.
- Choose **导出译文 TXT (Export translation TXT)** or **导出对照 JSON (Export bilingual JSON)** from a session's context menu, then select the session or topic. Records also offer export. Missing finals are reported, with explicit partial export available. Topic archives have separate JSON/Markdown exports.

Exports are not complete project backups and cannot currently be imported for restoration. Confirm the file was saved after starting a download.

### 6. Save history, inspect storage, and clean up

Set new-session defaults for mode, target language, instructions, and per-call limit under **DSH Settings → Translation**. Valid settings save immediately; restoring defaults does not clear history or change existing sessions.

**Embedding API** accepts a complete OpenAI Embeddings-compatible HTTP(S) endpoint, including its `/embeddings` path, a model name, and an optional key. The Host credential service stores configuration and keys without displaying the key; changing service hosts requires a new key. Connection testing sends only fixed short text and reports dimensions and elapsed time.

Choose **Save and build index**, or open **语义索引 (Semantic index)** from memory assets, to build, fill gaps, or rebuild. Indexes cover active entities, facts, relations, completely segmented reference text, and current-source/effective-final translation examples. Terms and enabled settings are read directly. The main model searches accessible material in the current topic, with translation examples limited to opened sessions, then reads exact hits and selects context. Literal search remains available without an index or when the API fails; incomplete coverage is reported.

Indexing sends the corresponding text to your configured embedding service. Once enabled, it follows active content changes; changing the endpoint or model requires rebuilding. Runtime vectors stay in memory, saved-content vectors stay on the Host, and content deletion also releases indexes.

**允许保存会话历史到本地 (Allow local history saving)** controls automatic history and memory persistence. When enabled, save status requires Host confirmation. Turning it off retains saved copies while later changes remain runtime-only and may be lost on restart. Model preferences and embedding configuration save independently. Local bodies are unencrypted; this switch does not control DSH main chats, model-call records, or attachments.

Startup reads a session directory, loading bodies when opening, browsing, or exporting. Saves transfer changes; failures retain current edits for retry or explicit reload. Deleting the main chat that first created material does not delete saved translation data.

| Cleanup level | Effect |
| --- | --- |
| Old version | Remove eligible old source/translation bodies and exclusive resources, retaining version numbers and call facts. Final/latest results, bases of retained revisions, and unsettled work are protected. |
| Unit | Remove all version bodies, dependent records, and resource references, retaining the number and call statistics. |
| Session | Remove session content and dependent resources, retaining topic memory by default. |
| Topic | Remove the topic, sessions, topic assets, and reference registrations, retaining user settings and shared files used elsewhere. |
| Plugin | **清除本地数据 (Clear local data)** removes plugin material, settings, indexes, and owned embedding credentials, retaining user originals and DSH main chats. |

Cleanup requires confirmation. Content becomes unavailable before exclusive files are released; shared originals remain while in use. **存储与空间 (Storage and space)** shows usage, unreadable history copies, orphan records, and **回收未引用原稿 (Reclaim unreferenced sources)**. Failed file cleanup does not restore deleted bodies, and residual cleanup can continue after restart. Documents also offer unused translation-block cleanup.

Check running or unknown-outcome tasks first. Local deletion does not retract exports, user originals, or content already sent to the main model.

## Runtime diagnostics and issue reports

Machine-generated normal text versions offer **导出调用日志 (Export call log)** with that version's prompts, input, output, and execution events. Logs contain translation text, check the exact session/version, and are available only during the original Host lifetime. Export them before restart if needed, and review sensitive content before sharing.

Search DSH Host logs for `[dsh-translation]` and correlate operations by `traceId`. Client-side save and evidence-check failures also emit browser-console summaries.

| Stage | Description |
| --- | --- |
| `model.prepare` / `model.stream` | Model preparation, output length, completion/cancellation, and failure stages. |
| `embedding.request` | Input counts, HTTP status, returned dimensions, and API errors. |
| `memory.index` / `memory.search` | Coverage, lexical/vector matches, and fallback. |
| `history.write` / `history.cleanup` | Save status, removal, shared retention, and residual cleanup. |

Summaries include status, timing, error codes, and stack locations, excluding bodies, prompts, queries, endpoints, and keys. DSH model-session records are separate and may contain request text. A successful connection, index, or status alone does not prove translation or retrieval quality.

For issue reports, include DSH/plugin versions, reproduction time, actions, expected and observed behavior, and related summaries. Quality issues also need the affected passages and reasons.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules.

Licensed under [MIT](LICENSE).
