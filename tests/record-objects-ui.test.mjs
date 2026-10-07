import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'
import { recordObjectsKey } from '../dist/client/record-object-store.js'
import { appendTextUnit, appendTextRevision, selectFinalRevision, appendManualRevision } from '../dist/client/translation-history.js'

const owner = 'synthetic-object-ui', at = '2026-10-07T00:00:00.000Z'
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const asset = (n = 1, kind = 'image') => ({ objectId: `object-${uuid(n)}`, assetId: `asset-${uuid(n)}`, version: 1, kind, name: `synthetic-${n}.png`, bytes: 3 })
const envelope = value => ({ ok: true, value: { ok: true, value } })
function topicPort() {
  let closed = false, release
  return { capabilities: async () => ({ ok: true, value: { ready: true } }), connect(identity) {
    closed = false
    return { send() {}, dispose() { closed = true; release?.() }, async *[Symbol.asyncIterator]() {
      yield { kind: 'ready', ...identity }
      while (!closed) await new Promise(resolve => { release = resolve })
    } }
  } }
}
async function setup({ rememberHistory = false } = {}) {
  const uploaded = [], registered = [], opened = [], state = { openFails: true }
  const app = mount({ settings: { schemaVersion: 2, defaultMode: 'quick', targetLanguage: '中文', defaultInstruction: '', maxInputChars: 20000, rememberHistory }, topics: topicPort(),
    fileUpload: { async upload(...args) { uploaded.push(args); return { ok: true, value: { receiptId: `receipt:${uploaded.length}`, file: { attachmentId: 'synthetic', name: args[2], bytes: 3 } } } } },
    objects: { capabilities: async () => envelope({ ready: true, nativeOpen: true }), register: async request => { registered.push(structuredClone(request)); const value = asset(registered.length, request.kind); return envelope({ ...value, objectId: request.existingObjectId ?? value.objectId, persistence: 'saved' }) },
      open: async request => { opened.push(structuredClone(request)); return state.openFails ? { ok: true, value: { ok: false, error: { code: 'open_failed', message: '合成原件打开失败' } } } : envelope({ opened: true }) } } })
  const ui = app.renderer; ui.render(app.panel, { sessionId: owner }); await ui.flush()
  const session = app.store.getActiveSession(owner)
  const revision = { id: 'revision', operationId: 'operation', model: { provider: 'provider-a', model: 'm1' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: 'T😀[图片1]', message: null }
  app.store.updateTranslationHistory(session.id, history => selectFinalRevision(appendTextUnit(history, { id: 'unit', source: 'S😀[图片1]', targetLanguage: '中文', instruction: '', createdAt: at }, revision), 'unit', 'revision', at))
  async function records() { app.resourceHost.restoreResource(owner, memoryAssetsAddress(owner, session.topicId), { topicId: session.topicId, sessionId: session.id }); await ui.flush(); await ui.click('译文记录'); await ui.click(`${session.name} · 文本 1`) }
  await records(); await ui.flush()
  const target = { ownerId: owner, topicId: session.topicId, sessionId: session.id, unitId: 'unit', side: 'source', revisionId: null }
  async function file(name = 'synthetic.png') { const input = ui.control('选择原件文件'); assert.equal(input.props.disabled, false); input.props.onChange({ currentTarget: { files: [Object.assign(new Blob(['abc']), { name })] } }); ui.render(); await ui.flush() }
  async function add(input) { const result = await app.objects.addReference(input, app.objects.getSnapshot(owner, session.topicId, session.id).version); ui.render(); await ui.flush(); return result.reference }
  return { app, ui, session, target, state, uploaded, registered, opened, file, add, records }
}

test('原文手动上传→具体位置固定对象link；literal marker不解析，沿用原件与独立结果保持对象编号/版本', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  assert.equal(f.ui.nodes().filter(node => node.props.className === 'dsh-tp-object-link').length, 0)
  await f.ui.input('关联位置', '2'); await f.file(); await f.ui.click('关联'); await f.ui.flush()
  const source = f.app.objects.getReferences(f.target)[0]
  assert.equal(source.offset, 2); assert.equal(f.uploaded.length, 1); assert.equal(f.registered[0].receiptId, 'receipt:1')
  assert.equal(f.ui.nodes().filter(node => node.props.className === 'dsh-tp-object-link').length, 1)
  assert.equal(f.ui.button('编辑译文').props.disabled, false, 'source refs permit target edits')
  await f.ui.input('关联到', 'revision'); await f.ui.input('关联方式', 'reuse'); await f.ui.input('选择原件', source.refId); await f.ui.click('关联')
  const target = { ...f.target, side: 'revision', revisionId: 'revision' }, reused = f.app.objects.getReferences(target)[0]
  assert.equal(f.uploaded.length, 1); assert.deepEqual(reused.asset, source.asset); assert.equal(reused.objectOrdinal, 1)
  assert.equal(f.ui.button('编辑译文').props.disabled, true)
  await f.ui.input('关联方式', 'result'); await f.ui.input('关联位置', '1'); await f.file('synthetic-result.png'); await f.ui.click('关联'); await f.ui.flush()
  const refs = f.app.objects.getReferences(target)
  assert.equal(refs.length, 2); assert.equal(refs[1].asset.objectId, source.asset.objectId); assert.notEqual(refs[1].asset.assetId, source.asset.assetId); assert.equal(refs[1].objectOrdinal, 1)
  assert.equal(f.app.store.getTranslationHistory(f.session.id).units[0].source, 'S😀[图片1]'); assert.equal(f.app.store.getTranslationHistory(f.session.id).units[0].revisions[0].text, 'T😀[图片1]')
})
test('逐对象打开失败保留label/固定版本原位重试；切final不携带旧ref错误，失效位置另列可打开', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  const old = await f.add({ ...f.target, side: 'revision', revisionId: 'revision', offset: 0, asset: asset() })
  await f.ui.click('打开图片1：synthetic-1.png'); assert.match(f.ui.text(), /合成原件打开失败/); assert.ok(f.ui.button('打开图片1：synthetic-1.png'))
  f.state.openFails = false; await f.ui.click('打开图片1：synthetic-1.png'); assert.equal(f.ui.text().includes('合成原件打开失败'), false); assert.equal(f.opened.length, 2); assert.deepEqual(f.opened[0], f.opened[1])
  f.state.openFails = true; await f.ui.click('打开图片1：synthetic-1.png')
  f.app.store.updateTranslationHistory(f.session.id, history => selectFinalRevision(appendManualRevision(history, 'unit', { id: 'other', baseRevisionId: 'revision', text: 'OTHER FINAL', at }), 'unit', 'other', at)); f.ui.render()
  assert.equal(f.ui.text().includes('合成原件打开失败'), false); assert.equal(f.ui.nodes().some(node => node.props['data-object-ref-id'] === old.refId), false)
  const original = f.app.objects.getReferences.bind(f.app.objects)
  f.app.objects.getReferences = scope => scope.side === 'source' ? [{ ...old, ...f.target, offset: 999 }] : original(scope)
  f.ui.render(); const unavailable = f.ui.nodes().find(node => node.props['aria-label'] === '关联位置不可用'); assert.ok(unavailable); assert.match(f.ui.text(unavailable), /\[图片1\].*关联位置不可用/)
  assert.ok(f.ui.nodes(unavailable).some(node => node.type === 'button'))
})
test('对象base在controller/workspace与records均拒绝改写，源对象不阻；未保存稿后来新增refs仍保留', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  await f.ui.click('编辑译文'); await f.ui.input('编辑译文', 'UNSAVED TARGET')
  await f.add({ ...f.target, side: 'revision', revisionId: 'revision', offset: 0, asset: asset() })
  assert.equal(f.ui.control('编辑译文').props.value, 'UNSAVED TARGET'); assert.equal(f.ui.button('保存新版本').props.disabled, true)
  assert.equal(f.app.quick.saveManualRevision(f.session.id, 'unit', 'revision', 'blocked'), false)
  f.ui.showTranslation(); await f.ui.flush()
  assert.equal(f.ui.button('编辑文本 1 版本 1').props.disabled, true); assert.match(f.ui.button('编辑文本 1 版本 1').props.title, /位置只读/)
  await f.ui.click('复制文本 1 版本 1'); assert.equal(f.app.copies.at(-1), '[图片1]T😀[图片1]')
})
test('新增save_failed保留登记身份，quota恢复重存仅引用且不重复上传/编号；归档所有输入只读', async t => {
  const f = await setup({ rememberHistory: true }); t.after(() => f.app.dispose())
  const set = f.app.storage.setItem.bind(f.app.storage), key = recordObjectsKey(f.session.id)
  f.app.storage.setItem = (name, value) => { if (name === key) throw new Error('synthetic quota'); set(name, value) }
  await f.file(); await f.ui.click('关联'); await f.ui.flush()
  assert.ok(f.ui.button('重试保存关联')); const before = f.app.objects.getSnapshot(owner, f.session.topicId, f.session.id)
  assert.equal(before.references.length, 1); assert.match(f.ui.text(), /关联位置尚未保存/)
  f.app.storage.setItem = set; await f.ui.click('重试保存关联'); await f.ui.flush()
  const after = f.app.objects.getSnapshot(owner, f.session.topicId, f.session.id)
  assert.equal(after.references.length, 1); assert.equal(after.version, before.version); assert.equal(f.uploaded.length, 1); assert.equal(f.registered.length, 1)
  f.app.store.archiveSession(owner, f.session.id); f.ui.render()
  for (const label of ['关联到', '关联方式', '原件类型', '关联位置', '选择原件文件']) assert.equal(f.ui.control(label).props.disabled, true)
})
test('可靠formulaSource跟原件持久、沿用保留、结果新文件不暗继承；无source不自动生成预览', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  await f.ui.input('原件类型', 'formula'); await f.file('synthetic-formula.tex'); await f.ui.input('公式源', 'x^2+\\frac{1}{2}'); await f.ui.click('关联'); await f.ui.flush()
  const source = f.app.objects.getReferences(f.target)[0]; assert.equal(source.formulaSource, 'x^2+\\frac{1}{2}'); assert.equal(f.ui.control('公式源').props.value, '')
  assert.ok(f.ui.nodes().some(node => node.props['data-native-markdown'])); assert.ok(f.ui.button('打开公式1：synthetic-1.png'))
  await f.ui.input('关联到', 'revision'); await f.ui.input('关联方式', 'reuse'); await f.ui.input('选择原件', source.refId); await f.ui.click('关联')
  assert.equal(f.app.objects.getReferences({ ...f.target, side: 'revision', revisionId: 'revision' })[0].formulaSource, source.formulaSource)
  await f.ui.input('关联方式', 'result'); await f.ui.input('关联位置', '1'); await f.file('new-formula.tex'); assert.equal(f.ui.control('公式源').props.value, ''); await f.ui.click('关联')
  assert.equal(f.app.objects.getReferences({ ...f.target, side: 'revision', revisionId: 'revision' })[1].formulaSource, undefined)
})
test('scope导出冻结对象引用，确认期间新增ref不追随；workspace菜单与records相同JSON/TXT', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  await f.add({ ...f.target, side: 'revision', revisionId: 'revision', offset: 0, asset: asset() })
  const revision = { id: 'failed', operationId: 'failed', model: { provider: 'provider-a', model: 'm1' }, draftVersion: 1, createdAt: at, updatedAt: at, accepted: true, status: 'failed', text: '', message: null }
  f.app.store.updateTranslationHistory(f.session.id, history => appendTextUnit(history, { id: 'missing', source: 'MISSING', targetLanguage: '中文', instruction: '', createdAt: at }, revision)); f.ui.render()
  await f.ui.click('导出 TXT'); assert.ok(f.ui.nodes().some(node => node.props['aria-label'] === '导出译文确认'))
  await f.add({ ...f.target, side: 'revision', revisionId: 'revision', offset: 1, asset: asset(2) }); await f.ui.click('仅导出已定稿')
  assert.equal(await f.app.downloads.at(-1).blob.text(), '[图片1]T😀[图片1]')
  f.ui.showTranslation(); await f.ui.flush(); const title = f.ui.nodes().find(node => node.props.className === 'dsh-tp-current-title')
  f.ui.context(title); await f.ui.click('导出对照 JSON'); await f.ui.click('当前会话'); await f.ui.click('仅导出已定稿')
  const json = JSON.parse(await f.app.downloads.at(-1).blob.text()); assert.equal(json.schemaVersion, 2); assert.equal(json.objectReferences.length, 2); assert.equal(json.sessions[0].units[0].translation, 'T😀[图片1]')
})
test('Body主题portal打开时native tab捕获关闭，原生event不被阻止', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  const toolbar = f.ui.nodes().find(node => node.props.className === 'dsh-tp-assets-topic-toolbar'), anchor = f.ui.nodes(toolbar).find(node => node.props['aria-label'] === '选择资产主题')
  anchor.props.onClick(); f.ui.render(); assert.ok(f.ui.nodes().some(node => node.props['aria-label'] === '资产主题列表'))
  let stopped = false
  f.app.dispatchDocument('pointerdown', { target: { closest: selector => selector === '[data-dockkit-tab]' ? {} : null }, stopPropagation() { stopped = true }, preventDefault() { stopped = true } })
  assert.equal(stopped, false); assert.equal(f.ui.nodes().some(node => node.props['aria-label'] === '资产主题列表'), false)
})
