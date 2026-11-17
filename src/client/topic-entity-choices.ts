import { h } from './react.js'
import type { TopicArchiveEntry, TopicArchiveSnapshot } from '../memory/topic-archive.js'
import { assetStatusLabels } from './topic-asset-status.js'

export function entityLabel(snapshot: TopicArchiveSnapshot, id: string): string {
  const entity = snapshot.entries.find(entry => entry.id === id && entry.kind === 'entity')
  if (entity?.kind !== 'entity') return `实体不可用（ID：${id}）`
  return entity.status === 'active' ? entity.name : `${entity.name}（${assetStatusLabels[entity.status]}）`
}

export function TopicEntityChoices({ snapshot, selected, disabled, activeOnly, onChange }: {
  readonly snapshot: TopicArchiveSnapshot
  readonly selected: readonly string[]
  readonly disabled: boolean
  readonly activeOnly?: boolean
  readonly onChange: (ids: readonly string[]) => void
}): unknown {
  const entities = snapshot.entries.filter((entry): entry is Extract<TopicArchiveEntry, { kind: 'entity' }> => entry.kind === 'entity')
  const unavailable = selected.filter(id => !entities.some(entry => entry.id === id))
  const choices = [...entities.map(entry => ({ id: entry.id, available: !activeOnly || entry.status === 'active' })),
    ...unavailable.map(id => ({ id, available: false }))]
  return h('fieldset', { className: 'dsh-tp-archive-entities', disabled }, h('legend', null, '关联实体'),
    entities.length ? null : h('small', { className: 'dsh-tp-muted' }, '暂无可关联的实体。'),
    ...choices.map(({ id, available }) => {
      const label = entityLabel(snapshot, id), checked = selected.includes(id)
      return h('label', { key: id }, h('input', { type: 'checkbox', checked, disabled: !checked && !available,
        'aria-label': `关联实体：${label}`,
        onChange: (event: { currentTarget: { checked: boolean } }) => {
          onChange(event.currentTarget.checked ? [...selected, id] : selected.filter(value => value !== id))
        },
      }), label)
    }))
}
