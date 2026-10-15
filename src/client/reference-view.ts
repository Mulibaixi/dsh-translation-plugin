import { h, react } from './react.js'
import type { ReferenceStore } from './reference-store.js'
import type { ReferenceEvidenceRef, ReferenceText } from '../shared/reference-memory.js'

export function ReferenceFilesView({ references, ownerId, topicId }: { readonly references: ReferenceStore; readonly ownerId: string; readonly topicId: string }): unknown {
  const [, refresh] = react.useState(0)
  react.useEffect(() => references.subscribe(() => refresh(value => value + 1)), [references])
  const facts = references.facts(ownerId, topicId)
  const documents = facts.index.documents.filter(document => document.state !== 'revoked')
  if (!documents.length && !references.getNotice()) return null
  return h('details', { className: 'dsh-tp-reference-files' }, h('summary', null, `参考资料（${documents.length}）`),
    references.getNotice() ? h('p', { role: 'alert' }, references.getNotice()) : null,
    h('p', { className: 'dsh-tp-muted' }, references.isSaved(ownerId, topicId) ? '已保存；供本主题普通翻译按任务选择使用。' : '当前资料仅在本次运行；供本主题普通翻译按任务选择使用。'),
    ...documents.map(document => h('div', { key: document.id, className: 'dsh-tp-reference-file' },
      h('strong', null, document.input.name), h('span', { className: 'dsh-tp-muted' }, ` · ${document.state === 'extracting' ? '尚未完成整理' : document.state === 'partial' ? '已整理部分资料' : '已整理'} · ${document.segmentCount} 个片段`),
      h('p', null, document.purpose), document.coverage ? h('p', { className: 'dsh-tp-muted' }, `已处理范围：${document.coverage}`) : null,
      document.unresolved ? h('p', { role: 'status' }, `待核对：${document.unresolved}`) : null,
      h('p', { className: 'dsh-tp-muted' }, '提取内容是主模型解读；登记和复核不代表原件已被程序验证。原件保留在主聊天附件中。'))))
}

export function ReferenceEvidenceView({ reference, read, active = true }: { readonly reference: ReferenceEvidenceRef; readonly read: (() => Promise<ReferenceText | undefined>) | undefined; readonly active?: boolean }): unknown {
  const [page, setPage] = react.useState<ReferenceText | undefined>(undefined)
  const [pending, setPending] = react.useState(false)
  const [error, setError] = react.useState<string | undefined>(undefined)
  const stamp = JSON.stringify(reference), latest = react.useRef(stamp), generation = react.useRef(0)
  latest.current = stamp
  react.useEffect(() => { generation.current++; setPage(undefined); setPending(false); setError(undefined); return () => { generation.current++ } }, [stamp, active])
  const load = async (): Promise<void> => {
    const version = ++generation.current
    setPending(true); setError(undefined)
    try {
      const value = await read?.()
      if (generation.current !== version || latest.current !== stamp) return
      if (!value) throw new Error('参考片段暂不可读或已被撤销。')
      setPage(value)
    } catch (cause) { if (generation.current === version) setError((cause as Error).message) }
    finally { if (generation.current === version) setPending(false) }
  }
  return h('div', { className: 'dsh-tp-reference-evidence' }, h('span', null, '参考资料（主模型解读）'),
    h('button', { type: 'button', disabled: pending || !active || !read, onClick: () => void load() }, pending ? '正在读取…' : '查看参考片段'),
    page ? h('div', null, h('p', { className: 'dsh-tp-muted' }, `${page.locator}${page.interpretation === 'uncertain' ? ' · 待核对' : ''}`), h('pre', null, page.text)) : null,
    error ? h('p', { role: 'alert' }, error) : null)
}
