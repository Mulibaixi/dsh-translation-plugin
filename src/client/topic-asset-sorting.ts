import type { TopicAssetMove } from '../shared/topic-asset-move.js'
import { react } from './react.js'
import { createSessionReorder, type SessionDrop, type SessionPointerEvent } from './session-reorder.js'

export function useTopicAssetSorting(key: string, enabled: boolean, move: (command: TopicAssetMove) => void) {
  const [preview, setPreview] = react.useState<{ key: string; drop: SessionDrop } | undefined>(undefined)
  const current = react.useRef({ key, enabled, move })
  current.current = { key, enabled, move }
  const gesture = react.useMemo(() => createSessionReorder(
    drop => setPreview(drop ? { key, drop } : undefined),
    drop => {
      const latest = current.current
      if (latest.key === key && latest.enabled) latest.move({ kind: 'move', ...drop })
    }, 'asset',
  ), [key])
  react.useEffect(() => () => gesture.dispose(), [gesture])
  const drop = preview?.key === key ? preview.drop : undefined
  return (id: string) => ({
    'data-asset-sort-id': id,
    'data-asset-dragging': drop?.id === id || undefined,
    'data-asset-drop': drop?.targetId === id && drop.id !== id ? (drop.after ? 'after' : 'before') : undefined,
    onPointerDown: (event: SessionPointerEvent & { readonly target: EventTarget | null }) => {
      if (enabled && !(event.target as Element | null)?.closest?.('button')) gesture.down(id, event)
    },
    onClickCapture: (event: MouseEvent) => {
      if (!gesture.consumeClick(id)) return
      event.preventDefault()
      event.stopPropagation()
    },
  })
}

export function assetMoveMessage(status: string): true | string {
  if (status === 'updated' || status === 'unchanged') return true
  if (status === 'requires_user_action') return '请先保存待保存的条目，再调整顺序。'
  return '顺序未保存，请核对最新档案后重试。'
}
