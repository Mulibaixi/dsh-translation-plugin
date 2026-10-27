export interface VersionDeletion { readonly eventId: string; readonly at: string }
export function parseVersionDeletion(value: unknown): VersionDeletion {
  const item = value as VersionDeletion
  if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['eventId', 'at'].includes(key)) || typeof item.eventId !== 'string' || !item.eventId.trim() || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) throw new TypeError('Invalid version deletion')
  return { eventId: item.eventId, at: item.at }
}
