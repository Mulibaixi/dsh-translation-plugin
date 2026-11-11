import { IMAGE_BACKGROUND_LIMIT } from '../shared/image-translation.js'
import type { NormalTranslationClient } from './normal-translation.js'
import { h, react } from './react.js'
import type { LocalSession } from './sessions.js'
import { isImageUnit, type TextUnit } from './translation-history.js'

type TextEvent = { currentTarget: { value: string } }

export function SourceTextEditor({ unit, session, normal, executionOwner, field = 'source', close }: {
  readonly unit: TextUnit
  readonly session: LocalSession
  readonly normal: NormalTranslationClient
  readonly executionOwner?: string | undefined
  readonly field?: 'source' | 'background'
  readonly close: () => void
}): unknown {
  const image = isImageUnit(unit), background = image && field === 'background'
  const current = background ? unit.backgroundDescription : unit.source
  const atOpen = react.useRef({ text: current, version: unit.sourceVersion })
  const [draft, setDraft] = react.useState(current)
  const [notice, setNotice] = react.useState('')
  const changed = current !== atOpen.current.text || unit.sourceVersion !== atOpen.current.version
  const blocked = changed ? '内容已更新，请重新打开编辑。' : normal.sourceEditBlockedReason(session.id, unit.id)
  const retranslateBlocked = !background && (normal.retranslateBlockedReason(session.id, unit.id) ??
    (Array.from(draft).length > session.maxInputChars ? '原文超过本会话的单次翻译上限。' : undefined))
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
    close()
    if (retranslate) void normal.retranslate(session.id, unit.id, executionOwner)
  }

  return h('div', { className: 'dsh-tp-version-editor' },
    h('label', null, background ? '画面背景（可选）' : '原文', h('textarea', {
      'aria-label': background ? '编辑画面背景' : '编辑原文正文',
      rows: background ? 2 : 5, maxLength: background ? IMAGE_BACKGROUND_LIMIT : undefined,
      value: draft, onChange: (event: TextEvent) => setDraft(event.currentTarget.value),
    })),
    h('div', { className: 'dsh-tp-actions' },
      h('button', { type: 'button', disabled: !canSave, onClick: () => save(false) }, '保存'),
      !background ? h('button', { type: 'button', disabled: !canSave || !!retranslateBlocked || !executionOwner || !draft.trim(),
        title: retranslateBlocked || undefined, onClick: () => save(true) }, '保存并重译') : null,
      h('button', { type: 'button', onClick: close }, '取消')),
    notice || blocked ? h('p', { role: 'alert' }, notice || blocked) : null)
}
