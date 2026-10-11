import { h } from './react.js'
import type { DocumentUnit } from './translation-history.js'

/** Document content readers and controls are connected in the following implementation stage. */
export function DocumentUnitSummary({ unit }: { readonly unit: DocumentUnit }): unknown {
  const source = unit.sourceVersions.find(version => version.version === unit.sourceVersion)
  const name = source?.body.kind === 'asset' ? source.body.reference.name : '长原稿'
  return h('article', { className: 'dsh-tp-record-unit', 'data-unit-id': unit.id, 'aria-label': `文档 ${unit.order}` },
    h('h3', null, `文档 ${unit.order} · ${name}`),
    h('small', { className: 'dsh-tp-muted' }, `原文版本 ${unit.sourceVersion} · 目标语言：${unit.targetLanguage}`),
    h('p', { role: 'status', className: 'dsh-tp-muted' }, '文档记录已保留，原稿读取、完整译文查看和整篇导出尚未接通。'))
}
