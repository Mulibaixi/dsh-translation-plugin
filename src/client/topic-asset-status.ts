import { assetPriority } from '../memory/asset-priority.js'
import type { TopicTerm } from '../memory/topic-terms.js'

export const assetStatusLabels = {
  adopted: '已采纳', proposal: '待确认', review_required: '待复核', disabled: '已停用', conflict: '有冲突',
} as const
type AssetEntry = Pick<TopicTerm, 'status' | 'origin' | 'confirmation' | 'acceptance'>

/** An entry can be effective before a user adopts it. */
export function assetStatus(entry: AssetEntry): keyof typeof assetStatusLabels {
  return entry.status === 'active' ? (assetPriority(entry) > 0 ? 'adopted' : 'proposal') : entry.status
}

export function assetStatusText(entry: AssetEntry, status = assetStatus(entry)): string {
  return entry.status === 'active' && status === 'proposal' ? '待人工确认 · 当前生效' : assetStatusLabels[status]
}
