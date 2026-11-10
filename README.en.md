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
| Version comparison and final selection | Retain the source and translation versions, compare and revise them, select a final, and save history automatically for continued discussion. |
| Quick translation | Translate independent plain text directly for short passages and occasional lookups. |
| File delivery | Work primarily with TXT/Markdown sources, process ranges when needed, and open results through the session or save a translation version to a chosen location with **操作 → 另存为…… (Actions → Save as…)**. |
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
- Current TXT/Markdown text files must use UTF-8 and can be up to 2 MiB each. Support boundaries for other formats are described below.

DSH `0.2.2-rc.1` is supported. Normal mode on this host requires Composer `0.4.7` with its matching host patches. Building this DSH version and its host patches requires Node.js 24.9 or later.

## Installation and updates

### Install

1. For Normal mode, install Composer **0.4.7** first from its [Releases](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest). Quick mode does not require Composer.
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

Wait for current tasks to finish and confirm that material is saved. Enter the new version's full `.tgz` path or versioned download URL in the plugin manager; **no prior uninstall is required**. Use a new versioned filename or URL. Usually only the changed plugin needs updating. If the release notes require companion updates, install Composer first, then the translation plugin. Hot loading is available when supported by the host; otherwise follow the manager's refresh, reload, or restart instructions.

Composer requires a normal full exit and reopen when a host patch actually needs replacement. Updating its extension package does not necessarily reinstall that patch. For source installations, update the original directories, rebuild in the order above, and refresh or reload.

The local database upgrades to format v8 to retain filename segmentation baselines. Older plugins cannot read this format; downgrading requires restoring a complete backup from the matching version.

See the user guide for [backup and restoration](docs/user-guide.zh-CN.md#资料库备份与恢复), [data migration](docs/user-guide.zh-CN.md#已有资料的升级与迁移), and [detailed update steps](docs/user-guide.zh-CN.md#发行包与源码更新) (简体中文). See [CHANGELOG](CHANGELOG.md) for version changes.

## Usage

The [detailed user guide (简体中文)](docs/user-guide.zh-CN.md) covers topics and sessions, material submission, refinement and finals, file delivery, memory management, storage cleanup, and issue reports.

**Put sources in the translation input, and requirements or revision feedback in the main chat.** Use Normal mode to hand the source and current requirements to the main model for coordination.

**Discuss first, then decide what to change.** For example, ask “what other renderings would fit this word? Let's discuss first, without translating yet.” Once you choose a direction, say “use the second option and refine this unit in the tone we agreed on.” The main model passes the explicit feedback to the translation model, with the existing translation as the revision basis.

Before discussing an older translation, open its translation session in the current main chat so the main model can read the source and existing translation by exact unit and version.

Session history saves automatically in the background. If saving fails, the workspace keeps the current content and offers **重试保存 (Retry saving)** without calling the translation model again.

For withdrawn text, choose **清除 (Clear)** at the top right of its entry to remove the placeholder.

When reading long text, the current source or translation heading and its controls stay at the top of the translation pane and follow the block being read. Collapsing the source positions the current translation heading at the top only when the source heading is already pinned there.

Organize terminology, style requirements, and references as [memory assets (简体中文)](docs/user-guide.zh-CN.md#记忆资产) to support later discussion and translation. See the guide for entry adoption, reference-file segmentation, source indexing, and saving rules.

You can explicitly ask the main model to delete a specific pending or disabled term, entity, fact, or relation.

Names of people, places, and organizations go into entities with their renderings. Established renderings of specialized concepts go into terminology. Each referent belongs in one category.

## Current limitations and data

- **Context questions**: Translation models with tool support can ask focused questions during Normal translation. The main model answers from available context or asks you, then starts a new translation call. Each call has its own usage; question references remain valid only during the current host run. The selected provider and model must support tool calls; a rejected tool declaration is reported without silently retrying as a translation.
- **Limited file support**: the current focus is UTF-8 TXT and Markdown. Complete parsing, recognition, and delivery in the original format are not yet supported for PDF, images, DOCX, and similar formats.
- **Translation efficiency**: some optimizations have been made, but final completion time is affected by the models and material.
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
