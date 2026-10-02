import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionStore } from '../dist/client/session-store.js'
import { DEFAULT_SESSION_SETTINGS, SETTINGS_KEY, LEGACY_SETTINGS_KEY, LEGACY_DRAFT_PREFIX, HISTORY_PREFIX, decodeSession, historyKey, parseSettings, validateSessionSettings } from '../dist/client/sessions.js'
import { DEFAULT_SETTINGS, createDraft } from '../dist/client/legacy-state.js'

class Storage {
  values = new Map()
  failSet = false
  failRemoveKey
  get length() { return this.values.size }
  key(i) { return [...this.values.keys()][i] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failSet) throw new Error('quota'); this.values.set(key, value) }
  removeItem(key) { if (key === this.failRemoveKey) throw new Error('blocked'); this.values.delete(key) }
}
function enabled() { const storage = new Storage(); storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, rememberHistory: true })); return storage }
function events() { let fn; let stopped = false; return { listen(listener) { fn = listener; return () => { fn = undefined; stopped = true } }, send(key) { fn?.(key) }, get stopped() { return stopped } } }
function oldDraft(storage, mode = 'quick') {
  const key = `${LEGACY_DRAFT_PREFIX}main-a:${mode}`
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, token: 'old', draft: { ...createDraft(DEFAULT_SETTINGS, mode), sourceText: '旧原文', manualTranslation: '旧人工稿', providerId: 'old-provider', modelId: 'old-model' } }))
  return key
}

test('新设置只包含新会话默认值和历史开关，默认关闭保存', () => {
  assert.deepEqual(validateSessionSettings(DEFAULT_SESSION_SETTINGS), [])
  assert.equal(DEFAULT_SESSION_SETTINGS.rememberHistory, false)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, providerId: 'unexpected' }).length)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, maxInputChars: 0 }).length)
  assert.ok(validateSessionSettings({ ...DEFAULT_SESSION_SETTINGS, targetLanguage: '' }).length)
})
test('旧默认值兼容读取，手动保存开关不自动升级为自动历史保存', () => {
  const legacy = JSON.stringify({ ...DEFAULT_SETTINGS, rememberDrafts: true, targetLanguage: '日本語' })
  assert.equal(parseSettings(null, legacy).targetLanguage, '日本語')
  assert.equal(parseSettings(null, legacy).rememberHistory, false)
  assert.equal(parseSettings('{broken', legacy), undefined)
})
test('即时设置按修改字段合并最新值，多个窗口不会覆盖彼此未修改的字段', () => {
  const storage = new Storage(); const first = new SessionStore(storage); const second = new SessionStore(storage)
  assert.equal(first.patchSettings({ targetLanguage: 'English' }), true)
  assert.equal(second.patchSettings({ maxInputChars: 300 }), true)
  const saved = JSON.parse(storage.getItem(SETTINGS_KEY))
  assert.equal(saved.targetLanguage, 'English'); assert.equal(saved.maxInputChars, 300)
})
test('无效设置不写入，存储失败报告失败，不伪造保存成功', () => {
  const storage = new Storage(); const store = new SessionStore(storage)
  assert.equal(store.patchSettings({ targetLanguage: '' }), false)
  assert.equal(storage.getItem(SETTINGS_KEY), null)
  storage.failSet = true
  assert.equal(store.patchSettings({ targetLanguage: 'English' }), false)
  assert.equal(store.getSettings().targetLanguage, '中文')
  assert.equal(new SessionStore().patchSettings({ defaultMode: 'normal' }), false)
})
test('新会话有独立 ID，默认名称与父会话编号命名正确，内容不隐式继承', () => {
  const store = new SessionStore(new Storage())
  const a = store.createSession('main-a'); const b = store.createSession('main-a')
  assert.notEqual(a.id, b.id); assert.equal(a.name, '新翻译会话')
  store.renameSession(a.id, '故事A'); store.updateSession(a.id, { input: '父会话输入' })
  const c = store.createSession('main-a', a.id); const d = store.createSession('main-a', a.id)
  assert.equal(c.name, '故事A-01'); assert.equal(d.name, '故事A-02'); assert.equal(c.parentId, a.id); assert.equal(c.input, '')
  assert.equal(store.getActiveSessions('main-a').length, 4)
  assert.equal(store.createSession('other', a.id), undefined)
})
test('长名称编号不截断 emoji 编码且保持名称长度合法', () => {
  const store = new SessionStore(new Storage()); const a = store.createSession('main-a')
  assert.equal(store.renameSession(a.id, '😀'.repeat(120)), true)
  const child = store.createSession('main-a', a.id)
  assert.ok(decodeSession(child)); assert.ok(Array.from(child.name).length <= 120)
  assert.equal(store.renameSession(a.id, ' '), false)
})
test('模式是会话属性，切换保留内容；主窗口范围和不同翻译会话不串输入', () => {
  const store = new SessionStore(new Storage()); const a = store.createSession('main-a'); const b = store.createSession('main-a'); const c = store.createSession('main-b')
  store.updateSession(a.id, { input: 'A', mode: 'normal' }); store.updateSession(b.id, { input: 'B' })
  assert.equal(store.getSession(a.id).input, 'A'); assert.equal(store.getSession(a.id).mode, 'normal')
  assert.equal(store.getSession(b.id).input, 'B'); assert.equal(store.getSession(c.id).input, '')
  store.openSession('main-b', a.id); assert.equal(store.getActiveSession('main-b').id, c.id)
})
test('归档保留当前窗口会话与输入，恢复后回到使用列表', () => {
  const store = new SessionStore(new Storage()); const a = store.createSession('main-a')
  store.updateSession(a.id, { input: '未保存输入' }); store.archiveSession('main-a', a.id)
  assert.equal(store.getActiveSessions('main-a').length, 0)
  assert.equal(store.getArchivedSessions('main-a').length, 1)
  assert.equal(store.getAvailableSessions('main-a')[0].input, '未保存输入')
  store.openSession('main-a', a.id); assert.equal(store.getActiveSession('main-a'), undefined)
  store.archiveSession('main-a', a.id, false); assert.equal(store.getActiveSession('main-a').input, '未保存输入')
})
test('新会话冻结默认模式、语言、要求、单次上限，修改默认值只影响后续会话', () => {
  const store = new SessionStore(new Storage()); const a = store.createSession('main-a')
  store.patchSettings({ targetLanguage: 'English', defaultInstruction: '保持术语', maxInputChars: 3, defaultMode: 'normal' })
  const b = store.createSession('main-a')
  assert.equal(store.getSession(a.id).targetLanguage, '中文'); assert.equal(store.getSession(a.id).maxInputChars, 20000)
  assert.equal(b.targetLanguage, 'English'); assert.equal(b.instruction, '保持术语'); assert.equal(b.maxInputChars, 3)
})
test('开启历史后自动保存；关闭保留旧历史并停止写入；恢复默认也保留历史', () => {
  const storage = new Storage(); const store = new SessionStore(storage); const a = store.createSession('main-a')
  store.updateSession(a.id, { input: '先在内存' }); assert.equal(store.getHistory().length, 0)
  store.patchSettings({ rememberHistory: true }); assert.equal(store.getHistory()[0].input, '先在内存')
  store.updateSession(a.id, { input: '已保存输入' }); const saved = storage.getItem(historyKey(a.id))
  store.patchSettings({ rememberHistory: false }); store.updateSession(a.id, { input: '关闭后的输入', mode: 'normal' })
  assert.equal(storage.getItem(historyKey(a.id)), saved); assert.equal(store.getHistory()[0].input, '已保存输入'); assert.equal(store.getHistory()[0].mode, 'quick')
  store.patchSettings({ ...DEFAULT_SESSION_SETTINGS }); assert.equal(store.getHistory().length, 1)
  const restarted = new SessionStore(storage); restarted.ensureWorkspace('main-a')
  assert.equal(restarted.getActiveSession('main-a').input, '已保存输入')
})
test('历史清理支持快译、单条和多条，范围外记录与其他应用数据保留', () => {
  const storage = enabled(); storage.setItem('other-app', 'keep'); const store = new SessionStore(storage)
  const quick = store.createSession('main-a'); const normal = store.createSession('main-a'); store.updateSession(normal.id, { mode: 'normal' })
  assert.equal(store.deleteHistory(store.getHistory().filter(item => item.mode === 'quick').map(item => item.id)), true)
  assert.equal(store.getSession(quick.id), undefined); assert.equal(store.getSession(normal.id).mode, 'normal')
  assert.equal(storage.getItem('other-app'), 'keep')
  const b = store.createSession('main-b'); assert.equal(store.deleteHistory([normal.id, b.id]), true); assert.equal(store.getHistory().length, 0)
})
test('关联记忆删除尚未实现时明确拒绝，不提前删除历史', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a')
  assert.equal(store.deleteHistory([a.id], true), false); assert.ok(storage.getItem(historyKey(a.id)))
})
test('损坏历史原样保留，全部清理的明确范围可包含无法读取副本', () => {
  const storage = enabled(); storage.setItem(`${HISTORY_PREFIX}broken`, '{broken'); storage.setItem('foreign', 'keep')
  const store = new SessionStore(storage); const a = store.createSession('main-a'); const bad = store.getUnreadableHistory()
  assert.equal(bad.length, 1); assert.equal(store.deleteHistory([a.id], false, bad), true)
  assert.equal(storage.getItem(`${HISTORY_PREFIX}broken`), null); assert.equal(storage.getItem('foreign'), 'keep')
  assert.equal(store.deleteHistory([], false, [{ key: 'foreign', raw: 'keep' }]), false)
})
test('删除失败时保留当前输入，修复存储后允许重试', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a')
  store.updateSession(a.id, { input: '保留输入' }); storage.failRemoveKey = historyKey(a.id)
  assert.equal(store.deleteHistory([a.id]), false); assert.equal(store.getSession(a.id).input, '保留输入')
  storage.failRemoveKey = undefined; assert.equal(store.deleteHistory([a.id]), true)
})
test('旧草稿转为可查看历史，编辑后写新版；删除同时处理新版与旧版副本', () => {
  const storage = enabled(); const oldKey = oldDraft(storage); const store = new SessionStore(storage)
  const a = store.getHistory()[0]; assert.equal(a.input, '旧原文'); assert.equal(a.legacyManualText, '旧人工稿'); assert.equal(a.model.model, 'old-model')
  store.openSession('main-a', a.id); store.updateSession(a.id, { input: '新版编辑' })
  assert.ok(storage.getItem(oldKey)); assert.ok(storage.getItem(historyKey(a.id)))
  storage.failRemoveKey = oldKey
  assert.equal(store.deleteHistory([a.id]), false); assert.equal(store.getSession(a.id).input, '新版编辑')
  storage.failRemoveKey = undefined; assert.equal(store.deleteHistory([a.id]), true)
  assert.equal(storage.getItem(oldKey), null); assert.equal(storage.getItem(historyKey(a.id)), null)
})
test('存储配额失败只影响持久化，不丢当前输入', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a')
  storage.failSet = true; assert.equal(store.updateSession(a.id, { input: '仍可编辑😀' }), true)
  assert.equal(store.getSession(a.id).input, '仍可编辑😀'); assert.equal(store.getStatus(a.id), 'error'); assert.ok(store.getNotice())
})
test('两窗口陈旧保存被拒绝，明确覆盖才可替换；读取不存在副本保留编辑', () => {
  const storage = enabled(); const first = new SessionStore(storage); const a = first.createSession('main-a'); const second = new SessionStore(storage)
  first.updateSession(a.id, { input: '第一窗口' }); second.updateSession(a.id, { input: '第二窗口' })
  assert.equal(second.getStatus(a.id), 'conflict'); assert.equal(second.getSession(a.id).input, '第二窗口')
  assert.equal(second.overwriteSession(a.id), true); assert.equal(JSON.parse(storage.getItem(historyKey(a.id))).session.input, '第二窗口')
  storage.removeItem(historyKey(a.id)); assert.equal(second.reloadSession(a.id), false); assert.equal(second.getSession(a.id).input, '第二窗口')
})
test('其他窗口关闭历史保存后，旧窗口写前重新检查开关', () => {
  const storage = enabled(); const first = new SessionStore(storage); const a = first.createSession('main-a'); const second = new SessionStore(storage)
  const before = storage.getItem(historyKey(a.id)); first.patchSettings({ rememberHistory: false })
  second.updateSession(a.id, { input: '不再落盘' }); assert.equal(storage.getItem(historyKey(a.id)), before); assert.equal(second.getSettings().rememberHistory, false)
})
test('存储事件自动同步设置，未保存输入遇到外部更新保留并提示冲突', () => {
  const storage = enabled(); const first = new SessionStore(storage); const a = first.createSession('main-a'); const bus = events(); const second = new SessionStore(storage, bus.listen)
  first.patchSettings({ rememberHistory: false, targetLanguage: 'English' }); bus.send(SETTINGS_KEY)
  assert.equal(second.getSettings().targetLanguage, 'English'); second.updateSession(a.id, { input: '本窗口编辑' })
  first.patchSettings({ rememberHistory: true }); first.updateSession(a.id, { input: '其他窗口编辑' }); bus.send(historyKey(a.id))
  assert.equal(second.getSession(a.id).input, '本窗口编辑'); assert.equal(second.getStatus(a.id), 'conflict')
})
test('删除前检测外部版本变化，防止清理新历史；监听按生命周期释放', () => {
  const storage = enabled(); const bus = events(); const store = new SessionStore(storage, bus.listen); const a = store.createSession('main-a'); const other = new SessionStore(storage)
  other.updateSession(a.id, { input: '外部更新' }); assert.equal(store.deleteHistory([a.id]), false); assert.ok(storage.getItem(historyKey(a.id)))
  store.dispose(); assert.equal(bus.stopped, true)
})
test('单次上限不会裁剪输入，绝对边界拒绝时保留原值', () => {
  const store = new SessionStore(new Storage()); store.patchSettings({ maxInputChars: 1 }); const a = store.createSession('main-a')
  store.updateSession(a.id, { input: '😀中' }); assert.equal(store.getSession(a.id).input, '😀中')
  assert.equal(store.updateSession(a.id, { input: 'x'.repeat(200001) }), false); assert.equal(store.getSession(a.id).input, '😀中')
})
test('删除确认冻结版本；收到同步事件后仍不删除确认期间更新的历史', () => {
  const storage = enabled(); const bus = events(); const first = new SessionStore(storage, bus.listen); const a = first.createSession('main-a')
  const frozen = first.captureHistoryVersions([a.id]); const second = new SessionStore(storage)
  second.updateSession(a.id, { input: '确认期间新增内容' }); bus.send(historyKey(a.id))
  assert.equal(first.getSession(a.id).input, '确认期间新增内容')
  assert.equal(first.deleteHistory([a.id], false, [], frozen), false)
  assert.ok(storage.getItem(historyKey(a.id)))
})
test('损坏设置拒绝猜测覆盖，只有明确恢复默认才修复；历史仍保留', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a')
  storage.setItem(SETTINGS_KEY, '{broken')
  assert.equal(store.patchSettings({ targetLanguage: 'English' }), false); assert.equal(storage.getItem(SETTINGS_KEY), '{broken')
  assert.equal(store.patchSettings({}, true), true); assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).rememberHistory, false)
  assert.ok(storage.getItem(historyKey(a.id)))
})

test('归档与恢复遵守历史开关，保存的归档状态重启后保留', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a'); const b = store.createSession('main-a')
  store.updateSession(a.id, { input: '归档原文' }); store.openSession('main-a', a.id)
  assert.equal(store.archiveSession('wrong-owner', a.id), false)
  assert.equal(store.archiveSession('main-a', a.id), true); assert.equal(store.getActiveSession('main-a').id, b.id)
  assert.equal(store.getArchivedSessions('main-a')[0].input, '归档原文'); assert.ok(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt)
  const restarted = new SessionStore(storage); restarted.ensureWorkspace('main-a')
  assert.equal(restarted.getActiveSession('main-a').id, b.id); assert.equal(restarted.getArchivedSessions('main-a').length, 1)
  restarted.archiveSession('main-a', a.id, false); assert.equal(restarted.getActiveSession('main-a').input, '归档原文')
  assert.equal(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt, null)
})

test('关闭保存后归档只改变当前窗口，不改写已有历史；开启后保存归档内容', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a'); const raw = storage.getItem(historyKey(a.id))
  store.patchSettings({ rememberHistory: false }); store.archiveSession('main-a', a.id)
  assert.equal(storage.getItem(historyKey(a.id)), raw); assert.ok(store.getSession(a.id).archivedAt)
  store.patchSettings({ rememberHistory: true }); assert.ok(JSON.parse(storage.getItem(historyKey(a.id))).session.archivedAt)
})

test('旧 v2 会话缺少归档字段时兼容读取，不因读取改写历史', () => {
  const storage = enabled(); const original = new SessionStore(storage); const a = original.createSession('main-a')
  const data = JSON.parse(storage.getItem(historyKey(a.id))); delete data.session.archivedAt
  const raw = JSON.stringify(data); storage.setItem(historyKey(a.id), raw)
  const store = new SessionStore(storage); assert.equal(store.getSession(a.id).archivedAt, null); assert.equal(storage.getItem(historyKey(a.id)), raw)
  assert.equal(decodeSession({ ...data.session, archivedAt: 'not-date' }), undefined)
})

test('无本地存储时可删除纯内存会话，删除后切换到剩余会话', () => {
  const store = new SessionStore(); const a = store.createSession('main-a'); const b = store.createSession('main-a')
  store.updateSession(b.id, { input: '内存文本' }); const expected = store.captureHistoryVersions([b.id])
  assert.equal(store.deleteHistory([b.id], false, [], expected), true)
  assert.equal(store.getSession(b.id), undefined); assert.equal(store.getActiveSession('main-a').id, a.id)
})

test('删除确认期间内存输入修改，即使没有落盘也拒绝陈旧删除', () => {
  const store = new SessionStore(new Storage()); const a = store.createSession('main-a'); const expected = store.captureHistoryVersions([a.id])
  store.updateSession(a.id, { input: '确认后新增输入' })
  assert.equal(store.deleteHistory([a.id], false, [], expected), false); assert.equal(store.getSession(a.id).input, '确认后新增输入')
})

test('其他窗口归档已保存的当前会话后，干净窗口同步归档并切换选择', () => {
  const storage = enabled(); const first = new SessionStore(storage); const a = first.createSession('main-a'); const b = first.createSession('main-a')
  const bus = events(); const second = new SessionStore(storage, bus.listen); second.ensureWorkspace('main-a'); second.openSession('main-a', a.id)
  first.archiveSession('main-a', a.id); bus.send(historyKey(a.id))
  assert.equal(second.getArchivedSessions('main-a').length, 1); assert.equal(second.getActiveSession('main-a').id, b.id)
})

test('历史清理包含已归档会话，删除一个归档不会删除兄弟或父子会话', () => {
  const storage = enabled(); const store = new SessionStore(storage); const a = store.createSession('main-a'); const child = store.createSession('main-a', a.id)
  store.archiveSession('main-a', a.id); assert.equal(store.getHistory().length, 2)
  assert.equal(store.deleteHistory([a.id]), true); assert.ok(store.getSession(child.id)); assert.ok(storage.getItem(historyKey(child.id)))
})
