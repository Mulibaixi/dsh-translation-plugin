export const TOPIC_SUBMENU_WIDTH = 220

export const styles = `
.dsh-tp { box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 14px; line-height: 1.6; }
.dsh-tp * { box-sizing: border-box; }
.dsh-tp button, .dsh-tp input, .dsh-tp select, .dsh-tp textarea { font: inherit; color: inherit; }
.dsh-tp button { border: 0; background: transparent; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
.dsh-tp button.dsh-tp-danger { color: var(--dsw-alias-state-error-primary, #d54941); }
.dsh-tp button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp button:disabled { opacity: .45; cursor: default; }
.dsh-tp :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #568bf0); outline-offset: 2px; }
.dsh-tp input:not([type=checkbox]), .dsh-tp textarea, .dsh-tp select { min-width: 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 6px; background: var(--dsw-specific-input-major, #8881); }
.dsh-tp-panel { height: 100%; max-height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; container-type: inline-size; }
.dsh-tp-workspace { min-height: 0; height: 100%; display: flex; overflow: hidden; }
.dsh-tp-session-sidebar { flex: 0 0 160px; min-height: 0; padding: 10px 6px; border-right: 1px solid var(--dsw-alias-border-l2, #8883); overflow-y: auto; }
.dsh-tp-session-sidebar[hidden] { display: none; }
.dsh-tp-session-list { display: flex; flex-direction: column; gap: 3px; }
.dsh-tp-session-item { display: block; width: 100%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-tp-session-item[aria-current=true] { background: transparent; }
.dsh-tp-session-add { display: flex; align-items: center; justify-content: center; width: 100%; align-self: stretch; text-align: center; margin-top: 2px; }
.dsh-tp-session-divider { border-top: 1px solid var(--dsw-alias-border-l2, #8883); margin: 4px 0; }
.dsh-tp-archive-toggle { width: 100%; margin-top: 14px; text-align: left; font-size: 12px !important; color: var(--dsw-alias-label-caption, #888) !important; }
.dsh-tp-main { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; }
.dsh-tp-workspace-header { display: flex; align-items: center; gap: 5px; flex: none; padding: 8px 10px; }
.dsh-tp-title-select { min-width: 0; flex: 1; }
.dsh-tp-title-anchor { display: block; min-width: 0; width: 100%; }
.dsh-tp-current-title { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; text-align: left; }
.dsh-tp-current-title-text { min-width: 0; flex: 1; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.dsh-tp-session-choice { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; }
.dsh-tp button.dsh-tp-memory-assets-entry { min-height: 36px; padding: 6px 10px; font-size: 14px; line-height: 22px; font-weight: 500; }
.dsh-tp-session-choice-name { display: block; min-width: 0; flex: 1; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.dsh-tp-session-choice[aria-current=true] { background: transparent; }
.dsh-tp [data-session-dragging=true] { cursor: grabbing; opacity: .6; user-select: none; }
.dsh-tp [data-session-drop=before] { box-shadow: inset 0 2px var(--dsw-focus-ring-color, #568bf0); }
.dsh-tp [data-session-drop=after] { box-shadow: inset 0 -2px var(--dsw-focus-ring-color, #568bf0); }
.dsh-tp-header-options { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: none; margin-left: auto; }
.dsh-tp-compact-trigger { display: flex; align-items: center; gap: 4px; font-weight: 400; white-space: nowrap; max-width: 110px; }
.dsh-tp-compact-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsh-tp-chevron { color: var(--dsw-alias-label-caption, #888); flex: none; transition: transform .12s; }
.dsh-tp-chevron-open { transform: rotate(180deg); }
.dsh-tp-popup { z-index: 1100; min-width: 180px; max-width: min(320px, calc(100vw - 32px)); max-height: min(420px, calc(100vh - 96px)); overflow-y: auto; }
.dsh-tp-popup.dsh-tp-topic-popup { overflow: visible; }
/* 4px 菜单内边距，加上 2px 接缝偏移。 */
.dsh-tp-topic-popup [role=menu] { top: -4px; bottom: auto; left: calc(100% + 6px); width: ${TOPIC_SUBMENU_WIDTH}px; }
.dsh-tp-popup .dsh-tp-menu-content { padding: 4px; }
@container (max-width: 520px) { .dsh-tp-session-sidebar { flex-basis: 120px; } .dsh-tp-workspace-header { padding: 8px 6px; gap: 2px; } .dsh-tp-header-options { gap: 2px; } }
.dsh-tp-transcript { flex: 1 1 0; min-height: 0; overflow-y: scroll; overflow-x: hidden; scrollbar-gutter: stable; padding: 12px 16px; overscroll-behavior: contain; }
.dsh-tp-empty { color: var(--dsw-alias-label-caption, #888); text-align: center; padding: 28px 8px; font-size: 13px; }
.dsh-tp-empty-guide { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.dsh-tp-empty-guide p { margin: 0; }
.dsh-tp-empty-guide .dsh-tp-empty-action { display: flex; justify-content: center; }
.dsh-tp-composer-area { flex: none; margin: 8px 12px 12px; }
.dsh-tp-service-status { display: flex; align-items: center; gap: 6px; margin: 0 3px 4px; color: var(--dsw-alias-label-caption, #888); font-size: 11px; line-height: 1.5; }
.dsh-tp-service-status-text { min-width: 0; flex: 1; }
.dsh-tp button.dsh-tp-service-recheck { display: flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; padding: 4px; }
.dsh-tp-service-recheck[aria-busy=true] svg { animation: dsh-tp-checking 1s linear infinite; }
@keyframes dsh-tp-checking { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-tp-service-recheck[aria-busy=true] svg { animation: none; } }
.dsh-tp-runtime-note { display: block; margin: 4px 3px 0; color: var(--dsw-alias-label-caption, #888); font-size: 11px; line-height: 1.5; }
.dsh-tp-composer { padding: 10px; border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-specific-input-major, #8881); border: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-composer textarea { display: block; resize: none; width: 100%; min-height: 70px; max-height: 180px; overflow-y: auto; padding: 4px; background: transparent; border: 0; }
.dsh-tp-composer:focus-within, .dsh-tp-composer textarea:focus, .dsh-tp-composer textarea:focus-visible { outline: none !important; box-shadow: none !important; }
.dsh-tp-composer-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0; }
.dsh-tp button.dsh-tp-attach { display: flex; align-items: center; justify-content: center; padding: 5px; margin-right: auto; }
.dsh-tp-attachment { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; }
.dsh-tp-attachment-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-attachment-note { margin: 2px 0 5px; color: var(--dsw-alias-label-caption, #888); font-size: 11px; }
/* DSH 主题全局使用 superellipse；普通圆形必须同时指定 corner-shape。 */
.dsh-tp .dsh-tp-send { display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; flex: 0 0 38px; border-radius: 50% !important; corner-shape: round !important; background: var(--dsw-alias-interactive-bg-accent, #4d7df3); color: #fff; padding: 0; }
.dsh-tp button.dsh-tp-send:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-accent, #4d7df3); opacity: .5; }
.dsh-tp-muted { color: var(--dsw-alias-label-caption, #888); font-size: 12px; font-weight: 400; }
.dsh-tp-message { border-left: 3px solid #c68b32; padding: 6px 10px; margin: 6px 12px; font-size: 12px; overflow-wrap: anywhere; }
.dsh-tp-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsh-tp-session-row { display: flex; align-items: stretch; gap: 0; min-width: 0; border-radius: 6px; }
.dsh-tp-session-row:hover, .dsh-tp-session-row[data-current=true] { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-session-row .dsh-tp-session-choice, .dsh-tp-session-row .dsh-tp-session-item { flex: 1 1 auto; min-width: 0; background: transparent; }
/* 行是唯一高亮面：内层按钮（含通用 :hover 规则）不得再画自己的背景块。 */
.dsh-tp-session-row .dsh-tp-session-choice:hover:not(:disabled), .dsh-tp-session-row .dsh-tp-session-item:hover:not(:disabled) { background: transparent; }
.dsh-tp button.dsh-tp-session-close { flex: 0 0 auto; align-self: stretch; width: 30px; min-width: 30px; height: auto; padding: 0; border: 0; background: transparent; border-radius: 0 6px 6px 0; color: var(--dsw-alias-label-caption, #888); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.dsh-tp button.dsh-tp-session-close:hover:not(:disabled), .dsh-tp button.dsh-tp-session-close:focus-visible { color: var(--dsw-alias-label-primary, #222); background: transparent; }
.dsh-tp-dialog { flex: none; padding: 12px; margin: 6px 12px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 8px; max-height: 45%; overflow-y: auto; }
.dsh-tp-dialog p { margin: 6px 0; }
.dsh-tp-dialog input[type=text] { width: 100%; }
.dsh-tp-legacy { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, #8881); }
/* 单元：整体节奏为「功能行 ↕5px 文本 ↕18px 下一功能行」，单元之间用细横线分隔，线两侧各 18px。 */
.dsh-tp-translation { margin: 0; }
.dsh-tp-translation + .dsh-tp-translation { border-top: 1px solid var(--dsw-alias-border-l2, #8883); padding-top: 18px; }
.dsh-tp-translation > button:last-child { margin-bottom: 18px; }
.dsh-tp-translation-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 5px 0 12px; }
.dsh-tp-source-collapsed { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.dsh-tp-unit-header, .dsh-tp-version-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.dsh-tp-version { padding: 6px 0; }
/* 单元内各行功能（原文行、译文行、编辑器与执行行）使用同一按钮规格：12px、间距 4px。 */
.dsh-tp-unit-header .dsh-tp-actions, .dsh-tp-version-actions { gap: 4px; font-size: 12px; }
.dsh-tp-version-details { font-size: 11px; overflow-wrap: anywhere; margin: 4px 0 8px; }
.dsh-tp-version-editor { margin: 6px 0; }
.dsh-tp-version-editor textarea { display: block; width: 100%; min-height: 90px; max-height: 240px; resize: vertical; overflow-y: auto; margin: 4px 0; }
.dsh-tp-old-versions { margin-top: 18px; padding-left: 10px; border-left: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-old-versions .dsh-tp-version { padding-top: 0; }
.dsh-tp-source-versions { margin: 18px 0 12px; }
.dsh-tp-settings { padding: 16px 20px; height: 100%; max-height: 100%; min-height: 0; overflow-y: auto; }
.dsh-tp-settings-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-tp-settings-section-header > .dsh-tp-actions { margin-left: auto; justify-content: flex-end; }
.dsh-tp h2 { font-size: 18px; margin: 0; }
.dsh-tp h3 { font-size: 14px; margin: 0 0 12px; }
.dsh-tp .dsh-tp-settings-header > h3 { margin: 0; }
.dsh-tp-settings-section { padding: 18px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-field { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.dsh-tp-field textarea { resize: vertical; min-height: 80px; }
.dsh-tp-history-list { max-height: 280px; overflow-y: auto; margin: 12px 0; }
.dsh-tp-history-row { display: flex; gap: 8px; padding: 7px 0; align-items: flex-start; }
.dsh-tp-history-row input { margin-top: 6px; }
.dsh-tp-history-row span { overflow-wrap: anywhere; }
.dsh-tp-assets { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; container-type: inline-size; }
/* Topic navigation for a docked resource; floating captions own the same Menu. */
.dsh-tp-assets-topic-toolbar { flex: none; padding: 5px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-assets-topic-toolbar .dsh-tp-assets-topic-trigger { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-caption, #888); }
[data-dockkit-float] .dsh-tp-assets-topic-toolbar { display: none; }
.dsh-tp-assets-topic { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-tp-assets-topic[hidden] { display: none; }
.dsh-tp-assets-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 120px minmax(0, 1fr); overflow: hidden; }
.dsh-tp-assets-nav { min-height: 0; padding: 8px 5px; border-right: 1px solid var(--dsw-alias-border-l2, #8883); overflow-y: auto; }
.dsh-tp-assets-nav button { display: block; width: 100%; text-align: left; margin-bottom: 4px; }
.dsh-tp-assets-nav button[aria-current=true], .dsh-tp-asset-choice[aria-current=true], .dsh-tp-term[aria-current=true] { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-assets-content, .dsh-tp-assets-module { min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-tp-assets-module { flex: 1; }
.dsh-tp-assets-module[hidden] { display: none; }
.dsh-tp-structured { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-tp-archive-toolbar { flex: none; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
/* Toolbar buttons keep one size whether they sit in a wrapper or directly in the header. */
.dsh-tp-archive-toolbar .dsh-tp-unit-header .dsh-tp-actions,
.dsh-tp-asset-toolbar .dsh-tp-unit-header .dsh-tp-actions { font-size: 14px; }
/* Peer choices sit side by side with one selected segment, replacing the former dropdown. */
.dsh-tp-segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2, #8883); border-radius: 8px; }
.dsh-tp-segmented button { border-radius: 6px; padding: 4px 10px; }
.dsh-tp-segmented button[aria-checked=true] { background: var(--dsw-alias-interactive-bg-hover, #8882); }
.dsh-tp-archive-toolbar small { display: block; margin-top: 4px; font-size: 11px; }
.dsh-tp-archive-entities { margin: 10px 0; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 6px; }
.dsh-tp-archive-entities label { display: flex; align-items: flex-start; gap: 6px; margin: 4px 0; }
.dsh-tp-terms { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dsh-tp-asset-toolbar { flex: none; max-height: 42%; overflow-y: auto; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-asset-toolbar h3 { margin: 0; }
.dsh-tp-asset-toolbar small { display: block; font-size: 11px; }
.dsh-tp-asset-heading { display: flex; align-items: baseline; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dsh-tp-asset-heading h3 { flex: none; white-space: nowrap; }
.dsh-tp-asset-heading .dsh-tp-asset-note { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.dsh-tp-asset-filters { display: flex; gap: 6px; margin: 6px 0; }
.dsh-tp-asset-filters input { flex: 1; width: 0; }
.dsh-tp-asset-filters select { max-width: 120px; }
.dsh-tp-asset-columns { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, .85fr) minmax(220px, 1.15fr); overflow: hidden; }
.dsh-tp-asset-list, .dsh-tp-asset-details { min-height: 0; min-width: 0; overflow-y: auto; padding: 8px 10px; overflow-wrap: anywhere; }
.dsh-tp-asset-list { border-right: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-asset-choice { display: block; width: 100%; text-align: left; }
.dsh-tp-asset-details h3 { margin: 10px 0 4px; }
.dsh-tp-term-form textarea { min-height: 48px; resize: vertical; }
/* Continuous translation records: one scroll surface, paired rows in reading order. */
.dsh-tp-records-scope { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dsh-tp-records-scope select { max-width: 100%; padding: 4px 6px; }
.dsh-tp-record-search { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.dsh-tp-record-search input { flex: 1; min-width: 140px !important; padding: 5px 8px !important; }
.dsh-tp-record-search-hit { color: inherit; background: #e6bf4266; border-radius: 2px; }
.dsh-tp-record-search-current { background: #ef9f437a; outline: 1px solid currentColor; }
.dsh-tp-record-search-excerpt { padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-records-reader { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overflow-wrap: anywhere; }
.dsh-tp-records-session > h3, .dsh-tp-records-session > p { margin: 8px 10px; }
.dsh-tp-record-unit { border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-file-unit { padding: 6px 0 10px; }
.dsh-tp-file-unit .dsh-tp-unit-header, .dsh-tp-file-unit .dsh-tp-version-header { align-items: baseline; flex-wrap: wrap; }
.dsh-tp-file-name { padding: 2px 0 8px; overflow-wrap: anywhere; }
.dsh-tp-file-name .dsh-tp-object-link { text-align: left; overflow-wrap: anywhere; }
.dsh-tp-file-unit > p { margin: 4px 0; }
.dsh-tp-file-versions { margin: 5px 0; }
.dsh-tp-file-details { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-file-details > p, .dsh-tp-file-details > ul { margin: 4px 0 8px; }
.dsh-tp-file-details .dsh-tp-record-pair { margin-top: 4px; }
.dsh-tp-record-unit-heading { display: flex; align-items: baseline; gap: 8px; padding: 4px 6px; }
.dsh-tp-record-unit-heading { flex-wrap: wrap; }
.dsh-tp-record-unit-heading h3 { margin: 0; }
.dsh-tp-record-block + .dsh-tp-record-block { border-top: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-record-block-heading { display: block; padding: 4px 10px; }
.dsh-tp-record-page-actions { font-size: 12px; }
.dsh-tp-record-open { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.dsh-tp-record-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.dsh-tp-record-source, .dsh-tp-record-target { min-width: 0; padding: 8px 10px; }
.dsh-tp-record-source { border-right: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-record-pair h4 { margin: 0 0 4px; font-size: 12px; }
.dsh-tp-record-column-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 4px; }
.dsh-tp-record-column-heading h4 { margin: 0; }
/* Revision status, actions and the open control share the column heading row, so both columns
   start their body text on the same line. The status yields space first instead of wrapping. */
.dsh-tp-record-heading-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex: 0 0 auto; margin-left: auto; font-size: 12px; }
.dsh-tp-record-heading-actions .dsh-tp-actions { flex: none; flex-wrap: nowrap; }
.dsh-tp-record-heading-actions .dsh-tp-record-open { flex: none; }
.dsh-tp-record-revision-status { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-record-heading-actions .dsh-tp-record-open .dsh-tp-object-link { padding: 5px 8px; font-size: 12px; color: inherit; text-decoration: none; }
.dsh-tp-record-revision-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.dsh-tp-record-revision + .dsh-tp-record-revision { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-record-version-actions { margin: 0; }
.dsh-tp-record-actions { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, #8883); }
.dsh-tp-record-actions[hidden] { display: none; }
/* Managed originals: plain body segments with explicit, immutable links. */
.dsh-tp-object-link { display: inline; padding: 0 2px; color: var(--dsw-alias-text-link, #598de5); text-decoration: underline; background: transparent; border: 0; font: inherit; cursor: pointer; }
.dsh-tp-object-failure { display: block; white-space: normal; }
.dsh-tp-object-editor { padding: 8px 10px; }
.dsh-tp-object-editor h4 { margin: 0 0 6px; }
.dsh-tp-object-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 6px; padding: 0; border: 0; }
.dsh-tp-object-formula { display: block; white-space: normal; margin: 6px 0; }
.dsh-tp-object-formula-preview { display: block; overflow-x: auto; }
.dsh-tp-object-formula pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-tp-object-controls input[type=number] { width: 70px; }
.dsh-tp-object-controls input[type=file] { min-width: 0; max-width: 100%; width: 200px; }
@container (max-width: 600px) {
  .dsh-tp-assets-body { display: flex; flex-direction: column; }
  .dsh-tp-assets-nav { flex: none; display: flex; gap: 3px; padding: 4px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
  .dsh-tp-assets-nav button { width: auto; flex: none; margin: 0; }
  .dsh-tp-assets-content { flex: 1; }
  .dsh-tp-asset-columns { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(100px, .7fr) minmax(0, 1fr); }
  .dsh-tp-asset-list { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
  .dsh-tp-record-pair { grid-template-columns: minmax(0, 1fr); }
  .dsh-tp-record-source { border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); }
}
.dsh-tp-term { padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8882); overflow-wrap: anywhere; }
.dsh-tp-term:last-of-type { border-bottom: 0; }
.dsh-tp-term-details { padding-top: 4px; font-size: 12px; }
.dsh-tp-term-evidence { padding-top: 4px; }
.dsh-tp-term-evidence .dsh-tp-translation-text { max-height: 180px; overflow-y: auto; padding: 5px 0; }
.dsh-tp-model { min-width: 0; flex: 0 1 auto; }
.dsh-tp-model-anchor { display: block; min-width: 0; max-width: 100%; }
.dsh-tp-model-trigger { display: flex; align-items: center; gap: 4px; max-width: 100%; font-size: 13px !important; font-weight: 400; }
.dsh-tp-model-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-tp-model-effort { min-width: 0; flex-shrink: 1000; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dsh-tp-model-menu { min-width: min(260px, calc(100vw - 32px)); }
/* 与 DSH 原生紧凑菜单（目标语言）的文字规格一致。 */
.dsh-tp-model-menu .dsh-tp-menu-content { font-size: 11px; line-height: 17px; }
.dsh-tp-model-menu .dsh-tp-muted { font-size: inherit; line-height: inherit; }
.dsh-tp-popup .dsh-tp-language-custom { font-size: 11px; line-height: 17px; }
.dsh-tp-popup .dsh-tp-language-custom > .dsh-tp-field { margin-top: 0; }
.dsh-tp-model-menu input { width: 100%; margin-bottom: 6px; }
.dsh-tp-model-search:focus, .dsh-tp-model-search:focus-visible { outline: none !important; box-shadow: none !important; border-color: var(--dsw-alias-border-l2, #8884) !important; }
.dsh-tp-model-list { max-height: 260px; overflow-y: auto; }
.dsh-tp-model-row { display: block; text-align: left; width: 100%; font-weight: 400; }
.dsh-tp-model-cell { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; }
.dsh-tp-model-cell-value { margin-left: auto; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tp-file-job .dsh-tp-actions { flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dsh-tp-file-job-text { max-height: 440px; overflow: auto; margin-top: 12px; }
.dsh-tp-file-proposals { flex: 1; min-height: 0; min-width: 0; overflow-y: scroll; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain; padding: 0 12px 12px; }
.dsh-tp-file-proposal-batch { margin: 12px 0 24px; }
.dsh-tp-file-card { padding: 12px; margin: 10px 0; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 8px; }
.dsh-tp-file-card .dsh-tp-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.dsh-tp-file-card-content, .dsh-tp-file-card-evidence { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
.dsh-tp-file-card-field { display: grid; gap: 4px; margin: 8px 0; }
.dsh-tp-file-card-field input, .dsh-tp-file-card-field textarea, .dsh-tp-file-card-field select { width: 100%; box-sizing: border-box; }
.dsh-tp-other-memory-module { display: block; overflow-y: auto; }
.dsh-tp-other-memory { padding: 12px; min-width: 0; }
.dsh-tp-other-memory > section { margin-top: 20px; }
.dsh-tp-other-memory .dsh-tp-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dsh-tp-other-memory-heading h3 { margin: 0; }
.dsh-tp-other-memory-heading .dsh-tp-actions { margin: 0 0 0 auto; justify-content: flex-end; }
.dsh-tp-other-memory-setting, .dsh-tp-other-memory-file { padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, #8883); overflow-wrap: anywhere; }
.dsh-tp-other-memory-setting .dsh-tp-translation-text { max-height: 240px; overflow-y: auto; margin: 6px 0; }
.dsh-tp-other-memory-form { margin-top: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, #8884); border-radius: 6px; }
.dsh-tp-other-memory-form > label { display: grid; gap: 4px; margin: 8px 0; }
.dsh-tp-other-memory-form input:not([type=checkbox]), .dsh-tp-other-memory-form textarea, .dsh-tp-other-memory-form select { width: 100%; box-sizing: border-box; }
.dsh-tp-other-memory-form > .dsh-tp-checkbox { display: flex; align-items: center; }
.dsh-tp-other-memory-upload { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.dsh-tp-other-memory-upload input[type=file] { max-width: 100%; }
`
