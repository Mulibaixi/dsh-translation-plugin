# DeepSeek Harness Translation Plugin

[简体中文](README.md) | [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Mulibaixi/dsh-translation-plugin?label=release)](https://github.com/Mulibaixi/dsh-translation-plugin/releases/latest)
[![Listed on Awesome DSH Plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea44f)](https://awesome-dsh-plugin.com/?q=Mulibaixi%2Fdsh-translation-plugin)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mulibaixi/dsh-translation-plugin)

**Discuss wording and style with the main model, then apply your feedback to the translation.**

State your requirements and feedback directly in the main chat. Discuss wording, tone, and style with the main model, then have it turn that discussion into instructions for the translation model to translate or refine the text.

For example, say “this sentence is too literal” or “make this character's voice more restrained.” Discuss the source and existing translation, request a new version in the agreed direction, then compare, revise, and finalize. Keep the whole process in one workspace for novels, game scripts, and academic material that benefit from careful revision, and learn through the discussion.

[Why choose it](#why-choose-it) · [Installation and updates](#installation-and-updates) · [User guide (简体中文)](docs/user-guide.zh-CN.md) · [Projects and documentation](#projects-and-documentation)

## Why choose it

- **Discuss wording and style directly.** Talk through accuracy, tone, rhythm, and character voice with the main model around a specific source or translation. Compare alternatives and ask about the reasons for a rendering.
- **Put the discussion into the next version.** The main model organizes your background, requirements, and feedback for the translation model to apply. Give feedback on a specific unit and request further revisions toward the expression you want, without manually copying source text or relaying instructions between models.
- **Try different expressions and keep control of the final choice.** Sources and translation versions stay in the same unit, ready to revisit, compare, and revise before you choose the version you prefer.
- **Reuse confirmed wording and requirements.** Organize terminology, character details, style requirements, and references within a topic for later chapters and sessions, reducing repeated explanation.
- **Continue refining saved work across main chats.** History and topic material save locally for reuse after switching chats or restarting DSH. Keep your DSH model configuration and choose a translation model and reasoning effort for the task.

## Main capabilities

| Capability | Purpose |
| --- | --- |
| Discussion and refinement | In Normal mode, state requirements and discuss wording and style with the main model, then use that feedback for a first translation or further revision. |
| Source editing and final selection | Edit the current source in a Normal translation unit, retranslate it, or select a final. Existing translation revisions remain available after source edits. |
| Quick translation | Translate independent plain text directly for short passages and occasional lookups. |
| File delivery | Translate TXT, Markdown, text-layer PDFs, scanned PDFs, and mixed PDFs. Click a filename to preview it in the DSH sidebar, use **操作 → 打开 (Actions → Open)** to open it in the system default app, or use **操作 → 另存为…… (Actions → Save as…)** to save a specific translation version. |
| Single-image translation | The main model reads one PNG, JPEG, or static WebP. Edit the extracted source, copy the lettering prompt, or export a text PNG, the prompt, or a ZIP with the original and the prompt. When available, the prompt includes the original pixel dimensions. The generated image may differ in size. |
| Batch processing | In a Normal session, click the icon to the right of the file button to select multiple images. Confirm their order and translate them one at a time. Each image keeps its own unit. The batch bar above the input shows progress and lets you pause, resume, or retry a failed item. |
| Topic memory | Share terms, entities, facts, relations, settings, and references across topic sessions, with optional semantic retrieval. |

## A translation and refinement workflow

1. **State your requirements.** Create a topic and session, add the source, and describe the audience, style, background, and translation goal in the main chat.
2. **Produce a first translation.** In Normal mode, the main model organizes requirements and starts translation. Quick mode is also available for independent short text.
3. **Discuss alternatives.** Identify a sentence, unit, or version and compare wording, tone, and style with the main model to decide what to change.
4. **Apply the feedback.** Ask for refinement based on the discussion. The main model passes the consolidated requirements to the translation model to produce a new version of the same unit. Continue discussing and revising as needed.
5. **Compare and finalize.** Compare the source and translation versions, choose the one you prefer, then open it or save it as a file.

Confirmed terminology, settings, and style requirements can also become topic memory for later translation and discussion.

## Requirements

- DSH `>=0.2.0-rc.2 <0.2.3-0`, with local plugin support, the required interfaces, and a configured model. Compatibility within this range follows interface capabilities.
- **Quick mode** needs no Composer extension. **Normal mode** requires a companion `dsh-composer-extension` and submissions protocol 1. When the host lacks this interface, the extension matches patches by target-module fingerprints; unrelated DSH updates do not require adaptation.
- Source builds require Node.js 22 or newer, pnpm, and the Composer extension source directory alongside this repository. The DSH Host must load built-in `node:sqlite`.
- TXT and Markdown files must use UTF-8 and can be up to 2 MiB each. Text-layer PDFs can be read by page and have a 20 MiB plugin limit, subject to the DSH upload limit. The PDF card shows progress and the pages and reasons for any known gaps. Resume work, fill whole previously unregistered pages, and export combined Markdown in original page order.
- Scanned PDFs use an image-capable main model route and native subagents for page-by-page transcription. Each original page gets one Session unit. For mixed PDFs, you can turn on **翻译扫描页 (Translate scanned pages)** to include their translations in the Markdown in original page order.

DSH `0.2.2-rc.1` is supported. Normal mode on this host requires Composer `0.4.7` with its matching host patches. Normal mode on DSH `0.2.2-rc.3` requires a Composer build containing the patch for that host. Building these DSH versions and their host patches requires Node.js 24.9 or later.

## Installation and updates

### Install

1. For Normal mode, first install a Composer build containing the patch for your DSH host. For Quick mode, install the translation plugin directly. [Composer Releases](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest)
2. Download `dsh-translation-plugin-<version>.tgz` from this plugin's [Releases](https://github.com/Mulibaixi/dsh-translation-plugin/releases/latest). Enter its full local path or the asset's download URL in DSH's plugin manager, then install and enable it. Choose the `.tgz` asset; distribution packages include the build output and need no local build.
3. Open **翻译 (Translation)** in the main chat's right sidebar and create a topic and session. Restart when requested by the plugin manager. If Composer reports a prepared patch, exit DSH completely and reopen it before using Normal mode.

### Build from source

Place the two repositories side by side. Build the Composer extension according to its instructions, then run in this plugin directory:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

After building, install this directory in DSH's plugin manager or run `pnpm pack` to create a distribution package.

### Update

Open **Settings → 翻译 (Translation) → 插件更新 (Plugin updates)** to check for new releases. If you installed from a `.tgz`, you can install a newer release in one click. Source or linked installs can view and download the newer package. If a translation or batch job is running, click Update again after it finishes.

To update a distribution package manually, enter the new `.tgz` path or versioned download URL in the plugin manager to replace the installed package. Follow the manager's refresh, reload, or restart instructions. If the release notes require companion updates, install Composer first, then the translation plugin.

Composer requires a normal full exit and reopen when a host patch actually needs replacement. Updating its extension package does not necessarily reinstall that patch. For source installations, update the original directories, rebuild in the order above, and refresh or reload.

Image units and Normal translation units with editable sources use a new session history format. Older plugin versions cannot read sessions saved in this format. To downgrade, restore a full library backup from before the upgrade.

Saving the first Review Edit upgrades that session's history format. Restore a full library backup from before the upgrade to downgrade to a version without Review Edits.

See the user guide for [backup and restoration](docs/user-guide.zh-CN.md#资料库备份与恢复), [data migration](docs/user-guide.zh-CN.md#已有资料的升级与迁移), and [detailed update steps](docs/user-guide.zh-CN.md#发行包与源码更新) (简体中文). See [CHANGELOG](CHANGELOG.md) for version changes.

## Usage

For detailed instructions on topics and sessions, material submission, refinement and finalization, file delivery, memory management, storage cleanup, and issue reporting, see the [user guide (Simplified Chinese)](docs/user-guide.zh-CN.md).

### Submitting sources and instructions

In Normal mode, **put the source in the translation input and use the main chat for instructions, background, reference material, or questions**. When you send a plain-text source with a chat message, the main model reads them together and follows your intent for that turn. View the translation in the translation session. The main chat briefly reports the outcome and any issues.

Use **翻译设置 (Translation Preferences)** to set the default mode and target language for new sessions. **翻译要求 (Translation Requirements)** and **单次上限 (Per-translation limit)** are global and apply to future translations and retranslations in all sessions. The requirements field is optional. Use **翻译设定 (Translation Settings)** to manage rules at the topic or user level.

### Discussing and quoting translations

You can ask “What are some other ways to translate this word? Let's discuss it before translating,” then follow up with “Use the second option and refine this unit in the tone we agreed on.” The main model sends your explicit feedback to the translation model, which revises the existing translation.

Before discussing an existing translation, open its translation session in the current main chat so the main model can find the relevant unit and version. Select source text or a completed translation and choose **引用文本 (Quote text)** to add it to the main chat draft. On DSH 0.2.2-rc.3 or later, only the selected text is displayed; its source details are sent to the main model with the message.

For a Normal plain-text translation, you can ask the main model to revise a sentence or line in the chat. It can apply line-numbered changes to the latest complete translation and save a review revision. Exact fragment replacements are also available for small wording changes.

### Managing memory assets

Save terminology, style requirements, and references for later discussion and translation. For entry adoption, reference-file segmentation, source indexing, and saving rules, see [Memory assets (Simplified Chinese)](docs/user-guide.zh-CN.md#记忆资产).

When organizing candidates, file the names of people, places, and organizations under entities along with their translations. File established translations of specialized concepts under terminology. Keep each referent in one category. You can edit the entities linked to terms, facts, and relations to provide context.

When reviewing a new or existing translation, the main model can look up classification rules for reusable, source-supported material and submit a batch of candidates for adoption. Submission checks for names and aliases shared by terms and entities and reports entries that need review.

In **结构化档案 (Structured Archives)**, you can clear unadopted entries in the current category or use **导出 (Export)** to save all archives for the current topic as JSON or Markdown. You can also ask the main model to delete a specific pending or disabled term, entity, fact, or relation.

Markdown exports organize archive content, entry status, and brief source references by category. JSON exports include the complete structured fields.

## Current limitations and data

- **Context questions**: Translation models with tool support can ask focused questions during Normal translation. The main model answers from available context or asks you, then starts a new translation call. Each call has its own usage; question references remain valid only during the current host run. The selected provider and model must support tool calls; a rejected tool declaration is reported without silently retrying as a translation.
- **PDF**. Text-layer PDFs default to full-document translation, with an optional page range. When the text exceeds the translation budget, the main model asks before splitting it. Your choice carries over when you resume the same PDF. **译稿整合输出 (Combine translations)** is on by default and saves one Markdown file in original page order, preferably beside the original PDF. **译稿保留图表 (Keep figures and tables)** is off by default and embeds originals when their boundaries can be identified. Other figures and tables retain original page references. Verifiable equations use Markdown LaTeX. Translating a specified figure or table requires an image-capable model and native DSH subagent support. Mixed PDFs also offer **翻译扫描页 (Translate scanned pages)**, off by default. Image-only PDFs deliver page-level translations in the Session. Combined delivery for these files is planned.
- **Other source formats**. The main model extracts the text with available tools and delivers the result in the Normal translation Session. Markdown is the default when you request a standalone export without specifying a format. If the main model cannot read the requested scope in full, it explains what is missing and asks how to proceed. It needs your approval to install or enable a dedicated parser.
- **Semantic indexing**: enabling it sends relevant text to the configured embedding service.
- Restart does not automatically resume model tasks; check the original task when its outcome is unknown. Exports do not replace a complete backup and cannot currently be imported for restoration.
- Disabling or uninstalling the plugin does not automatically delete local material. Clean up versions, units, sessions, topics, or plugin data as needed.

## Projects and documentation

| Entry | Link |
| --- | --- |
| Translation plugin | [Mulibaixi/dsh-translation-plugin](https://github.com/Mulibaixi/dsh-translation-plugin) |
| Composer extension | [Mulibaixi/dsh-composer-extension](https://github.com/Mulibaixi/dsh-composer-extension) |
| Distribution packages | [Translation releases](https://github.com/Mulibaixi/dsh-translation-plugin/releases) · [Composer releases](https://github.com/Mulibaixi/dsh-composer-extension/releases) |
| Plugin directories | [Awesome DSH Plugin](https://awesome-dsh-plugin.com/?q=Mulibaixi%2Fdsh-translation-plugin) · [dsh-plugin.org](https://dsh-plugin.org/plugins/mulibaixi/dsh-translation-plugin) |
| Bug reports | [Translation plugin issues](https://github.com/Mulibaixi/dsh-translation-plugin/issues) |
| User guide (简体中文) | [Detailed operations and issue reports](docs/user-guide.zh-CN.md) |
| Changes | [CHANGELOG](CHANGELOG.md) |
| Contributions | [CONTRIBUTING](CONTRIBUTING.md) |

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules. Licensed under [MIT](LICENSE).
