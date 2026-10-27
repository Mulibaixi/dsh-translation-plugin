import { h, react } from './react.js'
import { sliceRecordText, type RecordSearchBody, type RecordSearchMatch } from './record-search.js'
import { sourceCodePointLength } from '../shared/translation-source-read.js'

/** Offsets refer only to original body text, so labels and object controls never become search hits. */
export function RecordSearchText({ text, offset = 0, matches, selected }: {
  readonly text: string; readonly offset?: number; readonly matches: readonly RecordSearchMatch[]; readonly selected?: RecordSearchMatch | undefined
}): unknown {
  const active = react.useRef<HTMLElement | null>(null)
  react.useEffect(() => { active.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [selected?.bodyKey, selected?.start, offset])
  const end = offset + sourceCodePointLength(text), pieces: unknown[] = []
  let position = offset
  for (const match of matches) {
    if (match.end <= offset || match.start >= end) continue
    const start = Math.max(offset, match.start), stop = Math.min(end, match.end)
    if (start > position) pieces.push(sliceRecordText(text, { start: position - offset, end: start - offset }))
    const current = selected?.bodyKey === match.bodyKey && selected.start === match.start
    pieces.push(h('mark', { key: `${match.bodyKey}:${match.start}`, className: current ? 'dsh-tp-record-search-hit dsh-tp-record-search-current' : 'dsh-tp-record-search-hit',
      'data-record-search-active': current || undefined, ref: current && match.start >= offset ? active : undefined }, sliceRecordText(text, { start: start - offset, end: stop - offset })))
    position = stop
  }
  if (position < end) pieces.push(sliceRecordText(text, { start: position - offset, end: end - offset }))
  return h('span', null, ...pieces)
}

/** Compact file rows acquire only a bounded body interval at their existing reading position. */
export function RecordSearchExcerpt({ body, matches, selected }: {
  readonly body: RecordSearchBody; readonly matches: readonly RecordSearchMatch[]; readonly selected?: RecordSearchMatch | undefined
}): unknown {
  const focus = selected?.bodyKey === body.key ? selected : matches[0]
  const [page, setPage] = react.useState<{ readonly key: string; readonly start: number; readonly text: string } | undefined>(undefined)
  const [failed, setFailed] = react.useState(false), [retry, setRetry] = react.useState(0)
  const start = focus ? Math.max(0, focus.start - 200) : 0, end = focus ? Math.min(body.length, Math.max(focus.end + 200, start + 1200)) : 0
  const key = JSON.stringify([body.key, start, end, retry])
  react.useEffect(() => {
    let active = true
    setPage(undefined); setFailed(false)
    if (!focus || !body.current()) return
    void (async () => {
      let position = start, size = Math.min(2000, end - start), text = ''
      try {
        while (position < end) {
          const stop = Math.min(end, position + size), result = await body.read({ start: position, end: stop })
          if (!active || !body.current()) return
          if (result.text === undefined) {
            if (result.reason === 'range_required' && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue }
            setFailed(true); return
          }
          if (sourceCodePointLength(result.text) !== stop - position) { setFailed(true); return }
          text += result.text; position = stop
        }
        if (active && body.current()) setPage({ key, start, text })
      } catch { if (active) setFailed(true) }
    })()
    return () => { active = false }
  }, [key])
  if (!focus || !body.current()) return null
  const ready = page?.key === key ? page : undefined
  return h('section', { className: 'dsh-tp-record-search-excerpt', 'aria-label': `${body.side === 'source' ? '原文' : '最终译文'}查找位置` },
    h('small', { className: 'dsh-tp-muted' }, `${body.side === 'source' ? '原文' : '最终译文'} · 位置 ${start + 1}–${end} / ${body.length}`),
    ready ? h('div', { className: 'dsh-tp-translation-text' }, start > 0 ? '…' : null,
      h(RecordSearchText, { text: ready.text, offset: ready.start, matches, selected }), end < body.length ? '…' : null)
      : h('p', { className: 'dsh-tp-muted', role: 'status' }, failed ? '查找位置暂不可读取。' : '正在读取查找位置…'),
    failed ? h('button', { type: 'button', onClick: () => setRetry(value => value + 1) }, '重试读取查找位置') : null)
}
