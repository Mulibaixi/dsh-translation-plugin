import {
  DEFAULT_SESSION_SETTINGS, HISTORY_PREFIX, LEGACY_DRAFT_PREFIX, LEGACY_SETTINGS_KEY, SETTINGS_KEY,
  decodeSession, historyKey, legacySession, newSession, parseSettings, validateSessionSettings,
  type LocalSession, type SessionSettings,
} from './sessions.js'
export interface LocalStoragePort {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Disposer = () => void
export type HistoryStatus = 'memory' | 'saved' | 'conflict' | 'error'
interface Seat { session: LocalSession; savedSession: LocalSession | undefined; stored: string | null; legacyRaw: string | null; status: HistoryStatus }
interface Workspace { active: string | undefined }
export interface HistoryVersion { readonly id: string; readonly stored: string | null; readonly legacyRaw: string | null; readonly current: string }

function readHistory(raw: string): LocalSession | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    return value?.schemaVersion === 2 && typeof value.token === 'string' ? decodeSession(value.session) : undefined
  } catch { return undefined }
}

export class SessionStore {
  private settings: SessionSettings = DEFAULT_SESSION_SETTINGS
  private readonly seats = new Map<string, Seat>()
  private readonly workspaces = new Map<string, Workspace>()
  private readonly listeners = new Set<Disposer>()
  private notice: string | undefined
  private readonly stop: Disposer | undefined
  private disposed = false

  constructor(private readonly storage?: LocalStoragePort, listen?: (onChange: (key: string | null) => void) => Disposer) {
    this.readSettings(); this.loadHistory()
    this.stop = listen?.(key => this.externalChange(key))
  }

  getSettings(): SessionSettings { return this.settings }
  getNotice(): string | undefined { return this.notice }
  getSession(id: string): LocalSession | undefined { return this.seats.get(id)?.session }
  getStatus(id: string): HistoryStatus { return this.seats.get(id)?.status ?? 'memory' }
  subscribe(listener: Disposer): Disposer { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const fn of this.listeners) fn() }
  dispose(): void { this.disposed = true; this.stop?.(); this.listeners.clear(); this.workspaces.clear(); this.seats.clear() }

  private readSettings(): boolean {
    try {
      const settings = parseSettings(this.storage?.getItem(SETTINGS_KEY) ?? null, this.storage?.getItem(LEGACY_SETTINGS_KEY) ?? null)
      if (!settings) throw new Error('invalid settings')
      this.settings = settings
      return true
    } catch { this.notice = '本地设置读取失败，当前设置仍保留。'; return false }
  }

  patchSettings(patch: Partial<Omit<SessionSettings, 'schemaVersion'>>, restore = false): boolean {
    if (!this.readSettings() && !restore) { this.emit(); return false }
    const next = { ...(restore ? DEFAULT_SESSION_SETTINGS : this.settings), ...patch, schemaVersion: 2 as const }
    const errors = validateSessionSettings(next)
    if (errors.length) { this.notice = errors.join(' '); this.emit(); return false }
    if (!this.storage) { this.notice = '本地存储不可用，设置尚未保存。'; this.emit(); return false }
    try {
      const wasEnabled = this.settings.rememberHistory
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(next))
      this.settings = next; this.notice = undefined
      if (!wasEnabled && next.rememberHistory) {
        for (const [id, seat] of this.seats) if (seat.status !== 'saved') this.persist(id)
      }
      this.emit(); return true
    } catch { this.notice = '设置保存失败，编辑值仍保留，请检查本地存储后重试修改。'; this.emit(); return false }
  }

  private loadHistory(): void {
    if (!this.storage) return
    try {
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key) keys.push(key) }
      for (const key of keys.filter(key => key.startsWith(HISTORY_PREFIX))) {
        const raw = this.storage.getItem(key)
        const session = raw === null ? undefined : readHistory(raw)
        if (!session || historyKey(session.id) !== key) { this.notice = '部分会话历史无法读取，原存储副本已保留。'; continue }
        const old = this.seats.get(session.id)
        if (!old) this.seats.set(session.id, { session, savedSession: session, stored: raw, legacyRaw: session.legacyKey ? this.storage.getItem(session.legacyKey) : null, status: 'saved' })
      }
      for (const key of keys.filter(key => key.startsWith(LEGACY_DRAFT_PREFIX))) {
        const raw = this.storage.getItem(key)
        const session = raw === null ? undefined : legacySession(key, raw)
        if (session && !this.seats.has(session.id)) this.seats.set(session.id, { session, savedSession: session, stored: null, legacyRaw: raw, status: 'saved' })
        else if (!session) this.notice = '部分旧版草稿无法读取，原存储副本已保留。'
      }
    } catch { this.notice = '会话历史读取失败，当前窗口仍可编辑。' }
  }

  getHistory(ownerId?: string): readonly LocalSession[] {
    return [...this.seats.values()].flatMap(seat => seat.savedSession && (ownerId === undefined || seat.savedSession.ownerId === ownerId) ? [seat.savedSession] : [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  getAvailableSessions(ownerId: string): readonly LocalSession[] {
    return [...this.seats.values()].map(seat => seat.session).filter(session => session.ownerId === ownerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  getActiveSessions(ownerId: string): readonly LocalSession[] { return this.getAvailableSessions(ownerId).filter(session => session.archivedAt === null) }
  getArchivedSessions(ownerId: string): readonly LocalSession[] { return this.getAvailableSessions(ownerId).filter(session => session.archivedAt !== null) }
  getActiveSession(ownerId: string): LocalSession | undefined { const id = this.workspaces.get(ownerId)?.active; return id ? this.getSession(id) : undefined }
  private reconcileWorkspace(ownerId: string): void {
    const workspace = this.workspaces.get(ownerId)
    if (!workspace || (workspace.active && this.getSession(workspace.active)?.archivedAt === null)) return
    workspace.active = this.getActiveSessions(ownerId).at(-1)?.id
  }
  ensureWorkspace(ownerId: string): void {
    if (!ownerId.trim() || this.workspaces.has(ownerId)) return
    this.workspaces.set(ownerId, { active: undefined })
    const recent = this.getHistory(ownerId).find(session => session.archivedAt === null)
    if (recent) this.openSession(ownerId, recent.id)
    else if (!this.getAvailableSessions(ownerId).length) this.createSession(ownerId)
  }
  createSession(ownerId: string, parentId?: string): LocalSession | undefined {
    if (!ownerId.trim()) return undefined
    this.loadHistory()
    const parent = parentId ? this.getSession(parentId) : undefined
    if (parentId && (!parent || parent.ownerId !== ownerId)) { this.notice = '当前会话无法作为新会话的起点。'; this.emit(); return undefined }
    let name = '新翻译会话'
    if (parent) {
      let sequence = parent.childSequence + 1
      const names = new Set([...this.seats.values()].map(seat => seat.session.name))
      do { name = `${Array.from(parent.name).slice(0, 110).join('')}-${String(sequence++).padStart(2, '0')}` } while (names.has(name))
      this.updateSession(parent.id, { childSequence: sequence - 1 })
    }
    let id: string
    do { id = `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` } while (this.seats.has(id))
    const session = newSession(this.settings, ownerId, id, name, parent?.id ?? null)
    this.seats.set(id, { session, savedSession: undefined, stored: null, legacyRaw: null, status: 'memory' })
    this.openSession(ownerId, id)
    if (this.settings.rememberHistory) this.persist(id)
    this.emit(); return session
  }
  openSession(ownerId: string, id: string): void {
    const session = this.getSession(id)
    if (!session || session.ownerId !== ownerId || session.archivedAt !== null) return
    let workspace = this.workspaces.get(ownerId)
    if (!workspace) { workspace = { active: undefined }; this.workspaces.set(ownerId, workspace) }
    workspace.active = id; this.emit()
  }
  archiveSession(ownerId: string, id: string, archived = true): boolean {
    const seat = this.seats.get(id)
    if (!seat || seat.session.ownerId !== ownerId) return false
    const time = new Date().toISOString()
    seat.session = { ...seat.session, archivedAt: archived ? time : null, updatedAt: time }
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    if (this.settings.rememberHistory) this.persist(id)
    this.reconcileWorkspace(ownerId)
    if (!archived) this.openSession(ownerId, id)
    this.emit(); return true
  }
  updateSession(id: string, patch: Partial<Pick<LocalSession, 'mode' | 'targetLanguage' | 'input' | 'instruction' | 'model' | 'childSequence'>>): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    const next = decodeSession({ ...seat.session, ...patch, updatedAt: new Date().toISOString() })
    if (!next) { this.notice = '输入无效或过长，之前的会话内容仍保留。'; this.emit(); return false }
    seat.session = next
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    if (this.settings.rememberHistory) this.persist(id)
    this.emit(); return true
  }
  renameSession(id: string, name: string): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    const next = decodeSession({ ...seat.session, name: name.trim(), updatedAt: new Date().toISOString() })
    if (!next) { this.notice = '名称不能为空，且最多 120 个字符。'; this.emit(); return false }
    seat.session = next; if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined; if (this.settings.rememberHistory) this.persist(id)
    this.emit(); return true
  }

  private persist(id: string, overwrite = false): boolean {
    const seat = this.seats.get(id)
    if (!seat || !this.storage) { this.notice = '会话历史保存不可用，内容仍保留在当前窗口。'; return false }
    try {
      if (!this.readSettings()) throw new Error('invalid settings')
      if (!this.settings.rememberHistory) return false
      const raw = this.storage.getItem(historyKey(id))
      if (!overwrite && (raw !== seat.stored || seat.status === 'conflict')) {
        seat.status = 'conflict'; this.notice = '会话历史已在其他窗口修改或删除，当前输入保留。请选择读取本地副本或明确覆盖。'; return false
      }
      const serialized = JSON.stringify({ schemaVersion: 2, token: `${Date.now()}-${Math.random()}`, session: seat.session })
      this.storage.setItem(historyKey(id), serialized)
      seat.stored = serialized; seat.savedSession = seat.session; seat.status = 'saved'
      return true
    } catch { seat.status = 'error'; this.notice = '会话历史保存失败，当前输入仍保留在窗口内存中。'; return false }
  }
  overwriteSession(id: string): boolean { this.notice = undefined; const result = this.persist(id, true); this.emit(); return result }
  reloadSession(id: string): boolean {
    const seat = this.seats.get(id)
    if (!seat || !this.storage) return false
    try {
      const raw = this.storage.getItem(historyKey(id))
      const session = raw === null ? undefined : readHistory(raw)
      if (!session || session.id !== id || session.ownerId !== seat.session.ownerId) throw new Error('invalid history')
      seat.session = session; seat.savedSession = session; seat.stored = raw; seat.status = 'saved'; this.notice = undefined
      this.reconcileWorkspace(session.ownerId); this.emit(); return true
    } catch { this.notice = '本地副本不存在或无法读取，当前输入保持不变。'; this.emit(); return false }
  }

  getUnreadableHistory(): readonly { readonly key: string; readonly raw: string }[] {
    const result: { key: string; raw: string }[] = []
    if (!this.storage) return result
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key || !(key.startsWith(HISTORY_PREFIX) || key.startsWith(LEGACY_DRAFT_PREFIX))) continue
        const raw = this.storage.getItem(key)
        if (raw === null) continue
        const session = key.startsWith(HISTORY_PREFIX) ? readHistory(raw) : legacySession(key, raw)
        if (!session || (key.startsWith(HISTORY_PREFIX) && historyKey(session.id) !== key)) result.push({ key, raw })
      }
    } catch { this.notice = '部分历史存储无法检查，清理范围可能不完整。' }
    return result
  }

  captureHistoryVersions(ids: readonly string[]): readonly HistoryVersion[] {
    return ids.flatMap(id => { const seat = this.seats.get(id); return seat ? [{ id, stored: seat.stored, legacyRaw: seat.legacyRaw, current: JSON.stringify(seat.session) }] : [] })
  }

  deleteHistory(ids: readonly string[], deleteMemory = false, unreadable: readonly { readonly key: string; readonly raw: string }[] = [], expected?: readonly HistoryVersion[]): boolean {
    if (deleteMemory) { this.notice = '关联记忆档案尚未接入，此操作未执行。'; this.emit(); return false }
    try {
      const seats = [...new Set(ids)].map(id => this.seats.get(id)).filter((seat): seat is Seat => !!seat)
      if (!this.storage && (unreadable.length || seats.some(seat => seat.stored !== null || seat.legacyRaw !== null))) {
        this.notice = '本地存储不可用，已保存历史未删除。'; this.emit(); return false
      }
      for (const item of unreadable) {
        if (!(item.key.startsWith(HISTORY_PREFIX) || item.key.startsWith(LEGACY_DRAFT_PREFIX)) || this.storage?.getItem(item.key) !== item.raw) {
          this.notice = '清理范围或历史副本已变化，请重新选择后确认。'; this.emit(); return false
        }
      }
      // 删除前检查已保存版本，避免清理另一个窗口刚刚更新的会话。
      for (const seat of seats) {
        const version = expected ? expected.find(item => item.id === seat.session.id) : seat
        if (!version || (expected && JSON.stringify(seat.session) !== expected.find(item => item.id === seat.session.id)?.current) ||
          (this.storage?.getItem(historyKey(seat.session.id)) ?? null) !== version.stored ||
          (seat.session.legacyKey && (this.storage?.getItem(seat.session.legacyKey) ?? null) !== version.legacyRaw)) {
          this.notice = '待删除会话或历史已变化，请核对最新内容后重新确认。'; this.emit(); return false
        }
      }
      for (const item of unreadable) this.storage?.removeItem(item.key)
      for (const seat of seats) {
        this.storage?.removeItem(historyKey(seat.session.id))
        seat.stored = null
        if (seat.session.legacyKey) { this.storage?.removeItem(seat.session.legacyKey); seat.legacyRaw = null }
        this.seats.delete(seat.session.id)
        this.reconcileWorkspace(seat.session.ownerId)
      }
      this.notice = undefined; this.emit(); return true
    } catch { this.notice = '历史清理未完全完成。请检查本地存储，取消确认框后重新选择并重试。'; this.emit(); return false }
  }

  private externalChange(key: string | null): void {
    if (key === null || key === SETTINGS_KEY || key === LEGACY_SETTINGS_KEY) this.readSettings()
    if (key === null || key?.startsWith(HISTORY_PREFIX) || key?.startsWith(LEGACY_DRAFT_PREFIX)) {
      for (const seat of this.seats.values()) {
        if (key !== null && key !== historyKey(seat.session.id) && key !== seat.session.legacyKey) continue
        try {
          const raw = this.storage?.getItem(historyKey(seat.session.id)) ?? null
          if (raw !== seat.stored) {
            const latest = raw === null ? undefined : readHistory(raw)
            if (seat.status === 'saved' && latest && latest.id === seat.session.id && latest.ownerId === seat.session.ownerId) {
              seat.session = latest; seat.savedSession = latest; seat.stored = raw
            } else {
              if (raw === null) seat.savedSession = undefined
              seat.status = 'conflict'
              this.notice = '会话历史在其他窗口变化，当前窗口内容保留。'
            }
          }
        } catch { seat.status = 'error'; this.notice = '本地历史读取失败，当前输入仍保留。' }
      }
      this.loadHistory()
      for (const ownerId of this.workspaces.keys()) this.reconcileWorkspace(ownerId)
    }
    this.emit()
  }
}

export function createSessionStore(): SessionStore {
  let storage: LocalStoragePort | undefined
  try { storage = window.localStorage } catch { /* 存储被禁用时保留内存编辑。 */ }
  return new SessionStore(storage, onChange => {
    const listener = (event: StorageEvent): void => { if (event.storageArea === storage) onChange(event.key) }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  })
}
