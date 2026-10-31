# DeepSeek Harness Translation Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Mulibaixi/dsh-translation-plugin?label=release)](https://github.com/Mulibaixi/dsh-translation-plugin/releases/latest)

**Keep long translations moving, and give every revision something to build on.**

Bring first drafts, discussion, refinement, and final selection into one workspace for novels, game scripts, and academic material that need consistent context and expression over time.

When you reach the next chapter, keep established names and terminology within reach. When a sentence needs more work, discuss it with the source and earlier translations available. When you switch main chats or restart DSH, return to the work you have saved.

[Why choose it](#why-choose-it) · [Installation and updates](#installation-and-updates) · [User guide (简体中文)](docs/user-guide.zh-CN.md) · [Projects and documentation](#projects-and-documentation)

## Why choose it

- **Keep translating long projects with less repeated explanation.** Collect confirmed terminology, character details, style requirements, and references within a topic for later chapters and sessions, giving consistent wording and context a foundation.
- **Keep refining until the translation fits your intent.** Discuss accuracy, tone, rhythm, and character voice around a specific translation. Turn “this sounds unnatural” into actionable feedback and work toward the result you want.
- **Let the models do more organizing and checking, with less copying and relaying for you.** Describe your goal in the main chat; let the main model organize context, coordinate translation, and review revisions. The companion integration submits source material with instructions, reducing repeated copying between inputs.
- **Try different expressions and keep control of the final choice.** Sources and translation versions stay in the same session, ready to revisit, compare, and refine before you choose the version you prefer.
- **Turn the DSH you already know into a lasting translation workspace.** Reuse your model configuration and choose a translation model and reasoning effort for the task. History and memory save locally, so material organized today remains available for your next session.

## Main capabilities

| Capability | Purpose |
| --- | --- |
| Quick translation | Translate independent plain text directly for short passages and occasional lookups. |
| Translation and refinement | Use Normal mode for main-model coordination and repeated discussion, revision, and review with requirements and context. |
| File delivery | Work primarily with TXT/Markdown sources, process ranges when needed, and open results through the session or export them. |
| Topic memory | Share terms, entities, facts, relations, settings, and references across topic sessions, with optional semantic retrieval. |
| Versions and local saving | Retain sources and translation versions, select finals, and save history and memory automatically for reuse across chats and app restarts. |

## A translation and refinement workflow

1. **Prepare material and context.** Create a topic and session, add sources, and describe the audience, style, and background.
2. **Produce a first translation.** Use Quick mode for independent short text, or Normal mode when context and memory matter.
3. **Discuss and refine.** Identify a unit or version in the main chat and adjust meaning, phrasing, voice, or terminology.
4. **Review and finalize.** Compare the source and translation versions, revise further, choose a final, and open or export it.
5. **Reuse knowledge.** Review and adopt useful memory for later passages and sessions.

## Requirements

- DSH `>=0.2.0-rc.2`, with local plugin support, the required interfaces, and a configured model. Compatibility does not enumerate individual DSH versions.
- **Quick mode** needs no Composer extension. **Normal mode** requires a companion `dsh-composer-extension` and submissions protocol 1. When the host lacks this interface, the extension matches patches by target-module fingerprints; unrelated DSH updates do not require adaptation.
- Source builds require Node.js 22 or newer, pnpm, and the Composer extension source directory alongside this repository. The DSH Host must load built-in `node:sqlite`.
- Current TXT/Markdown text files must use UTF-8 and can be up to 2 MiB each. Support boundaries for other formats are described below.

## Installation and updates

### Install

1. For Normal mode, install Composer **0.4.5** first from its [Releases](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest). Quick mode does not require Composer.
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

See the user guide for [backup and restoration](docs/user-guide.zh-CN.md#资料库备份与恢复), [data migration](docs/user-guide.zh-CN.md#已有资料的升级与迁移), and [detailed update steps](docs/user-guide.zh-CN.md#发行包与源码更新) (简体中文). See [CHANGELOG](CHANGELOG.md) for version changes.

## Usage

The [detailed user guide (简体中文)](docs/user-guide.zh-CN.md) covers topics and sessions, material submission, Markdown delivery, memory management, refinement and finals, storage cleanup, and issue reports.

**Put sources in the translation input, and requirements or revision feedback in the main chat.** Use Quick mode for a direct translation, or Normal mode for main-chat coordination, discussion, and repeated refinement.

Session history saves automatically in the background while the main model reviews and delivers the translation. If history saving fails, the workspace keeps the current content and offers **重试保存 (Retry saving)** without calling the translation model again.

Terminology and structured archives support adopting pending proposals and review items by category. Batch adoption keeps the list and edit drafts visible, restores entry actions when finished, and reports failures.

After writing terminology or structured archive entries, the main model receives only the write result, exact versions and entry state, reducing repeated full-collection context. Complete content remains available in the interface, exports and on-demand queries.

After a topic reference file is uploaded, the main model delegates two independent full-file annotations and parallel cross-reviews to native subagents, resolves substantive issues, and saves one complete plan. Bilingual pairs and fine semantic boundaries are preserved. This requires a model that can hold the entire file and result, and two available subagent slots. Use **重试主模型分段 (Retry segmentation)** when unfinished; completed plans are preserved unless resegmentation is requested.

Translation actions identify the current task and exact material. Interrupted history does not authorize automatic continuation. When the intended task or target remains genuinely conflicting or unclear, the main model is instructed to ask you before proceeding; it can still load tools and check relevant context. Material accompanying a chat message follows that message's stated purpose, including learning or discussion.

For TXT and Markdown file history, choose **嵌入原文 (Embed source)** next to **重译 (Retranslate)** or on the source row in translation records. The main model marks semantic chunks and exclusions; only that original's retained prose is embedded. Code, Markdown structure and metadata remain available through exact record search. File translations are read on demand rather than embedded, and changing the final translation reuses the original's vectors. Existing file history must be selected explicitly; unselected files are not automatically indexed.

## Current limitations and data

- **Proactive information requests**: Normal translation currently uses direct calls and does not yet let the translation model proactively request information from the main model. Specified information can be delivered to the translation model through the main model.
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
| Bug reports | [Translation plugin issues](https://github.com/Mulibaixi/dsh-translation-plugin/issues) |
| User guide (简体中文) | [Detailed operations and issue reports](docs/user-guide.zh-CN.md) |
| Changes | [CHANGELOG](CHANGELOG.md) |
| Contributions | [CONTRIBUTING](CONTRIBUTING.md) |

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules. Licensed under [MIT](LICENSE).
