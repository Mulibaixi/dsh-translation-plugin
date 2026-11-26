import { IMAGE_BACKGROUND_LIMIT } from '../shared/image-translation.js'
import type { NormalTranslationClient } from './normal-translation.js'
import { h, react } from './react.js'
import type { LocalSession } from './sessions.js'
import type { SessionStore } from './session-store.js'
import { isImageUnit, type TextUnit } from './translation-history.js'

type TextEvent = { currentTarget: { value: string } }

export function useHoldHistoryEdits(store: SessionStore, sessionIds: readonly string[]): void {
  const key = JSON.stringify([...new Set(sessionIds)].sort())
  react.useLayoutEffect(() => {
    const release = (JSON.parse(key) as string[]).map(id => store.holdHistoryEdit(id))
    return () => { for (const stop of release) stop() }
  }, [store, key])
}

export function SourceTextEditor({ unit, session, store, normal, maxInputChars, executionOwner, field = 'source', close }: {
  readonly unit: TextUnit
  readonly session: LocalSession
  readonly store: SessionStore
  readonly normal: NormalTranslationClient
  readonly maxInputChars: number
  readonly executionOwner?: string | undefined
  readonly field?: 'source' | 'background'
  readonly close: (textarea?: HTMLTextAreaElement, text?: string) => void
}): unknown {
  useHoldHistoryEdits(store, [session.id])
  const image = isImageUnit(unit), background = image && field === 'background'
  const current = background ? unit.backgroundDescription : unit.source
  const atOpen = react.useRef({ text: current, version: unit.sourceVersion })
  const [draft, setDraft] = react.useState(current)
  const [notice, setNotice] = react.useState('')
  const textarea = react.useRef<HTMLTextAreaElement | null>(null)
  const changed = current !== atOpen.current.text || unit.sourceVersion !== atOpen.current.version
  const blocked = changed ? '内容已更新，请重新打开编辑。' : normal.sourceEditBlockedReason(session.id, unit.id)
  const retranslateBlocked = !background && (normal.retranslateBlockedReason(session.id, unit.id) ??
    (Array.from(draft).length > maxInputChars ? '原文超过单次翻译上限。' : undefined))
  const canSave = !blocked && (image || !!draft.trim())

  function save(retranslate: boolean): void {
    if (!canSave) return
    if (draft !== current) {
      const saved = image
        ? normal.editImage(session.id, unit.id, background ? { backgroundDescription: draft } : { sourceText: draft })
        : normal.editTextSource(session.id, unit.id, atOpen.current.version!, draft)
      if (!saved) {
        setNotice('保存失败，编辑内容仍保留。')
        return
      }
    }
    if (retranslate) close()
    else close(textarea.current ?? undefined, draft)
    if (retranslate) void normal.retranslate(session.id, unit.id, executionOwner)
  }

  return h('div', { className: 'dsh-tp-version-editor' },
    h('label', null, background ? '画面背景（可选）' : '原文', h('textarea', {
      ref: textarea, 'aria-label': background ? '编辑画面背景' : '编辑原文正文',
      rows: background ? 2 : 5, maxLength: background ? IMAGE_BACKGROUND_LIMIT : undefined,
      value: draft, onChange: (event: TextEvent) => setDraft(event.currentTarget.value),
    })),
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled: !canSave, onClick: () => save(false) }, '保存'),
      !background ? h('button', { type: 'button', disabled: !canSave || !!retranslateBlocked || !executionOwner || !draft.trim(),
        title: retranslateBlocked || undefined, onClick: () => save(true) }, '保存并重译') : null,
      h('button', { type: 'button', onClick: () => close(textarea.current ?? undefined, current) }, '取消')),
    notice || blocked ? h('p', { role: 'alert' }, notice || blocked) : null)
}
