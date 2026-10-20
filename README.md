# DeepSeek Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

A dedicated translation workspace for DeepSeek Harness (DSH), with separate places for translation, discussion, and reusable project knowledge.

Translating stories, game scripts, or academic material often involves copying passages between chats, repeating background information, comparing drafts, and maintaining terminology. This plugin keeps that work together under a topic: use the main chat for discussion and instructions, the translation workspace for source material and results, and memory assets for reusable terminology and background.

## Why use it

- **Separate translation from discussion**: source material and translations stay in the workspace; explanations and revision requests stay in the main chat.
- **Build knowledge across sessions**: translation sessions in one topic share terms, characters, facts, and relations, reducing repeated background explanations.
- **Compare and revise translations**: retain versions, retranslate, make manual revisions, and choose a final translation.
- **Keep memory visible and editable**: inspect evidence, edit entries, resolve conflicts, and decide whether to adopt suggestions from file translation.
- **Use models already configured in DSH**: choose a translation model and reasoning effort without configuring another model service in the plugin.

## What it can do today

| Capability | Current scope |
| --- | --- |
| Quick translation | Translate plain text directly, for standalone passages and occasional lookups. |
| Normal translation | Let the main model organize requirements and background for the translation model, with discussion, retranslation, and source correction. |
| File translation | Read text or recognize file content, translate with the current requirements, review and save the result, and suggest reusable memory assets. |
| Topics and sessions | Create topics and child sessions, add remarks, reorder or archive sessions, and reuse topics across main chats in the same local library. |
| Memory assets | Read and edit terms, entities, facts, and relations; inspect evidence, organize reference material, and review file proposals. |
| Versions and export | Read source and translation together, retain old versions, choose final results, and export translated TXT or bilingual JSON by session or topic. |
| Local history and cleanup | Optionally save history and topic assets, inspect storage usage, and delete or clear selected data. |

The project is still in development. Normal file translation performance and interaction are being improved; there is no guaranteed completion time.

Translation files can use any format, up to 2 MiB each. UTF-8 text can be translated directly while retaining its format; other sources must first be read or OCR'd by the main model. TXT, Markdown, JSON, and HTML results can be saved directly. Generating PDF, Word, or image results depends on the main model's capabilities.

Reading reference material depends on DSH and the main model. The memory asset window floats or docks inside DSH; it is not a separate native Windows window.

## Requirements

- DSH with local plugin support and a configured model. The currently targeted environment is based on DSH `0.2.0-rc.2`; other versions are not guaranteed to work unchanged.
- **Quick mode** does not require the Composer extension.
- **Normal mode** requires companion builds of `dsh-composer-extension` and DSH. Installing the extension alone does not add linked material submission to the official, unmodified `0.2.0-rc.2` application.
- **File translation** also requires DSH support for one-shot subagents, used for candidate asset extraction. Missing capabilities are reported, and the main model can still read a text source and translate it directly.
- Building from source requires Node.js 22 or later, pnpm, and the `dsh-composer-extension` source directory alongside this repository.

The current companion builds use content protocol 3 and task-phase protocol 2. Update and build the translation plugin and Composer extension together; incompatible protocols make the affected features unavailable.

The plugin uses model services configured in DSH, which may charge for requests. Saving data locally does not make translation offline.

## Installation and updates

### Install

1. Prepare the plugin source and the dependencies above. Build the Composer extension following its own instructions first, then run these commands in the translation plugin directory:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. In DSH's plugin manager, install this directory as a local plugin named `dsh-translation-plugin` and enable it. For Normal mode, also install and enable the companion Composer extension.
3. Restart DSH and open Translation from the main chat's right sidebar. If Normal mode reports missing dependencies, check the companion extension and DSH build.

### Update

1. Save history you want to retain and back up local data. You can also export important translations and memory assets separately.
2. Update both source directories and reinstall dependencies. Build the Composer extension first, then the translation plugin.
3. Refresh or reload the local plugin in the plugin manager and restart DSH. If there is no refresh action, uninstall and reinstall the same directory.

Keep the translation plugin, Composer extension, and companion DSH build compatible. Older builds may not read newly saved data; do not run old and new versions against the same data. Exports are for reading and delivery, cannot currently be imported for recovery, and do not replace a full data backup.

Disabling or uninstalling the plugin does not automatically erase saved local data. If DSH cannot start, use its recovery option to disable third-party plugins, then check the installed versions.

See [CHANGELOG](CHANGELOG.md) for version changes.

## User guide

### 1. Create a topic and translation session

On first opening the workspace, choose **新建主题及首会话 (New topic and first session)** or **选择已有主题 (Choose an existing topic)**. A topic groups knowledge for one story, project, or research area; translation sessions separate individual pieces of work.

Open, edit, archive, and export topics, translation sessions, and saved material from different main chats. You can also browse and manage the local library without a current main chat.

- **+** in the title dropdown creates a new topic and its first session.
- Right-click a session and choose **新建子会话 (New child session)** to continue in the same topic. Session numbers increase without filling deleted gaps.
- **重命名 (Rename)** changes the topic name for its sessions; **备注 (Remark)** changes only that session's displayed name.
- Long-press and drag a session row to reorder the list.
- **Close** removes a session only from the current main chat's open list. **归档 (Archive)** retains its contents in the sidebar's archived group. **删除 (Delete)** removes session content after confirmation.

Choose the model at the bottom right of the input area, and the language and mode at the top. A session can switch from Quick to Normal, but cannot switch back; create another session when you need Quick mode.

### 2. Quick: get a translation directly

1. Choose Quick mode, the target language, and a translation model.
2. Enter plain text in the translation input and send it.
3. Read the translation below the source, then retranslate or edit if needed.

Quick mode does not use main-chat context, topic memory, or reference material, and does not accept files. Use it for standalone translation; use Normal mode when terminology or story context needs to carry across passages.

### 3. Normal: translate with requirements and background

**Put the source in the translation input; put instructions and discussion in the main chat.**

Open the translation session in the main chat you want to use. Its main model can then read units on demand. Normal translation and retranslation use the current main chat. After switching chats, tasks already under way stay with their original main model.

- **Send with instructions**: place text or a file in the translation workspace, then write the current requirements in the main chat and send. The material accompanies that message, and the main model arranges processing according to the request.
- **Send material directly**: press Send in the translation workspace. Both text and files go to the current main model for processing.

Sending material directly does not include unsent instructions in the main chat input. For task-specific requirements, send the material with the main-chat message. If you add instructions after submission, identify which translation should change.

If reading, asset extraction, or translation lacks a required capability, the workspace explains why and retains the available material.

Click a submitted file's source filename to open the original. Once processing finishes, you can inspect the result, previous versions, and memory proposals. TXT and Markdown results keep the source format; for JSON, HTML, and similar formats, the main model asks when the output form is unspecified. Longer Normal-mode text is also handled as a file and may be translated in contiguous ranges covering the whole source.

To correct a completed file, identify it and the requested changes in the main chat. The main model appends a new version and saves the result again. Missing or overlapping segments are reported, and existing content is retained.

Text and files share explicit **unit numbers**. Ask in the main chat, for example, “Use the wording from units 2 and 4 to retranslate unit 5.” The main model reads the requested content without per-unit grants. Numbers default to the selected sidebar session; identify the session by name or number for requests across sessions. You can request the source, current final, or “unit 3, version 2.” Retranslation adds a version, and deletion preserves the unit number. The **重译 (Retranslate)** button also starts processing. Legacy documents retain their existing versions and final selections.

An explicitly user-fixed final is delivered first; otherwise the newest reviewed result is used. Real limit errors or incomplete results retain what was produced and report the failure without automatically repeating calls.

Submitted material is separate from the next input draft. Editing the input does not rewrite the submitted source. To correct submitted content, identify the material and the required change in the main chat.

Use **重新发送 (Resend)**, **移除 (Remove)**, or status checking when offered on a failed record. An unknown outcome establishes neither failure nor a safe retry; check it first. Restarting does not automatically resume model requests.

If a task's main chat becomes unavailable, results already obtained remain available. The task is not automatically transferred to another main model.

### 4. Memory assets: maintain shared topic knowledge

Open **记忆资产 (Memory assets)** at the top of the title dropdown, or choose **记忆 (Memory)** from a session's context menu. Search and switch topics inside the window; browsing another topic does not switch the active translation session.

**结构化档案 (Structured archive)** includes:

- **Terms**: source form, translation, and an optional description. Ordinary terms need no explanation; original concepts or special usage may benefit from a short note.
- **Entities**: characters, places, organizations, aliases, and descriptions.
- **Facts**: information that should remain consistent, optionally linked to entities.
- **Relations**: connections between entities.

Add, edit, adopt, disable, or delete entries and inspect their evidence. Model suggestions cannot automatically overwrite translations explicitly fixed by the user. Conflicts and changed evidence require review. Sessions in one topic share these assets; different topics keep separate assets.

File translation follows this priority: **user instructions = user-edited and confirmed entries > user-reviewed entries > pending entries = LLM interpretation**. Conflicts between user instructions and user-edited entries require your decision; the main model can resolve conflicts between pending entries and its own interpretation. Model-authored requirements do not count as user instructions.

**文件提案 (File proposals)** contains candidate assets gathered during file translation. Scroll through the cards, edit them, inspect evidence, adopt individually or in batches, reject, or submit grouped feedback. “全选待审” selects all pending cards matching the current type filter in that file batch across pages; click “取消全选” to clear the selection. Adoption writes them into topic assets; pending proposals do not block translation delivery. Editing and adopting an entry gives it the same priority as user instructions; adopting it without edits gives it priority over model suggestions. The asset retains its original factual attribution.

Repeated proposals in the same topic appear as updates to existing entries, with the previous content available for comparison. Adoption keeps the entry ID and increases its version. Terms match source forms and aliases; entities match names and aliases. Facts also require matching related entities, and relations require matching endpoints and relation names. Ambiguous matches and disabled entries remain pending without automatic merging. Explicitly adopting an update to a fixed user entry preserves its fixed status. If the existing entry changes during review, inspect the current version before adopting again.

Proposal descriptions use the current DSH language. Source forms, necessary aliases, and quotations retain their original text. People and other named referents belong to entities; their renderings can guide the current translation baseline without creating duplicate terminology records. Previously adopted content is not automatically migrated or translated.

File proposals open the newest reviewed batch by default, with a selector for older files and filters for all assets, terms, entities, relations, or facts. Pending cards appear first and adopted cards move to the bottom. Select-all and batch actions cover pending items of the current type across its pages.

**译文记录 (Translation records)** shows source and translation side by side, by session or whole topic; narrow windows stack each pair vertically. Images, tables, code, and other originals can be linked through clickable placeholders and opened. Linking does not automatically parse or translate their contents. Formulas can be previewed when suitable formula source is available.

To use external references, attach them in the main chat and identify the target topic and purpose. Ask the main model to organize them into topic assets. Its ability to read PDF, spreadsheet, or image references depends on the model. Separate Other memory and Temporary files management pages are not currently available.

### 5. Revise, finalize, and export

- **重译 (Retranslate)** adds a translation version and retains earlier ones. Changing the model does not rewrite existing results.
- Use **编辑 (Edit)** on short text to add a manual version without overwriting the source. To discuss an existing record, specify its unit number and your request in the main chat.
- File rows do not provide direct editing. Request changes in the main chat and process the file again. External changes to an opened file are not imported automatically.
- **设为最终 (Set as final)** fixes the translation to retain. Short text may also be finalized automatically when subsequent material is accepted or when exporting, subject to completeness checks. An explicitly fixed choice is not automatically replaced. File results must pass acceptance before final selection.
- Right-click a session, choose **导出译文 TXT (Export translated TXT)** or **导出对照 JSON (Export bilingual JSON)**, then select the session or whole topic. Translation records in the asset window also provide export actions.
- Exports use final translations. Missing content is reported, with an explicit option to export partial results. Topic archives have separate JSON and Markdown exports and are not included in translation exports.

Exports are not complete project backups. Bilingual JSON and archive snapshots cannot currently be imported. A download notice confirms initiation only; check where the file was saved.

### 6. Save history, inspect storage, and clean up

In **DSH Settings → 翻译 (Translation)**, set the default mode, target language, requirements, and single-input limit for new sessions. Valid settings save immediately. **恢复默认设置 (Restore defaults)** does not erase history or change existing sessions' settings.

**允许保存会话历史到本地 (Allow local session history)** is off by default:

- When enabled, it saves sessions, source and translation versions, final selections, and topic assets. For files, check the displayed save status.
- Turning it off retains saved copies and stops subsequent saving. Unsaved work may be lost on restart.
- Model and reasoning-effort preferences save independently of this switch.
- Saved content is unencrypted on this device. The switch does not control DSH's own main-chat history, model-request records, or attachments.

Deleting the main chat that first created the material does not delete saved translation data. Saved source and original-file copies remain accessible from the library; the plugin cannot recover missing saved copies.

Use **存储与空间 (Storage and space)** to inspect usage or manually **回收未引用原稿 (Reclaim unreferenced sources)**. Cleanup actions have different scopes:

| Action | Scope |
| --- | --- |
| Delete a session or unit | Removes selected content. Session deletion retains topic memory by default; check the confirmation for linked cleanup options. |
| Clear this topic's memory | Clears selected terms or structured assets in the asset window, retaining sessions and translations. |
| Delete a topic | Removes the topic, its sessions, topic assets, and associated material as listed in the confirmation. |
| Clear local data | Clears this plugin's local content and settings, without deleting user originals or DSH main-chat history. |

Finish or check running and unknown-outcome tasks before related deletion. Deleting local content does not retract exported files or information already sent to the main model.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules.

Licensed under [MIT](LICENSE).
