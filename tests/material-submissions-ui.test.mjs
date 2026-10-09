import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'
import { DEFAULT_SESSION_SETTINGS } from '../dist/client/sessions.js'
const ok = value => ({ ok: true, value: { ok: true, value } })
function receipt(request, stage = 'prepared') {
  const { ownerId, mainSessionId, requestId, operationId, kind } = request
  return { ownerId, mainSessionId, requestId, operationId, kind, stage }
}
function topicRemote() {
  return { async capabilities() { return { ok: true, value: { ready: true } } }, connect(identity) {
    let closed = false, wake
    return { send() {}, dispose() { closed = true; wake?.() }, async *[Symbol.asyncIterator]() {
      yield { kind: 'ready', ...identity }
      while (!closed) await new Promise(resolve => { wake = resolve })
    } }
  } }
}
async function fixture(remote = {}, options = {}) {
  let contribution
  const calls = { prepare: [], submit: [], upload: [], import: [], sourceCapabilities: 0 }
  const materials = {
    async capabilities() { return ok({ ready: true, directSubmit: true, storage: 'runtime_only' }) },
    async prepare(request) { calls.prepare.push(structuredClone(request)); return ok(receipt(request)) },
    async finish(request) { return ok(receipt({ ...request, kind: calls.prepare.at(-1)?.kind ?? 'material' }, request.outcome === 'submitted' ? 'submitted' : 'released')) },
    async submit(request) { calls.submit.push(structuredClone(request)); return ok(receipt(request, 'submitted')) },
    ...remote,
  }
  const source = { sourceId: 'source-11111111-1111-1111-1111-111111111111', version: 1, name: 'synthetic.txt', bytes: 6, totalCodePoints: 6,
    encoding: 'utf-8', bom: false, sha256: 'a'.repeat(64), persistence: 'runtime_only' }
  const sources = { async capabilities() { calls.sourceCapabilities++; return ok({ ready: true, storage: 'runtime_only', encoding: 'utf-8',
    maxBytes: 2 * 1024 * 1024, maxPageCodePoints: 4000, maxPageBytes: 32768 }) }, async importReceipt(request) {
    calls.import.push(structuredClone(request)); return ok({ ...source, name: calls.upload.at(-1).file.name })
  } }
  const fileUpload = { async upload(ownerId, file, name, signal) { calls.upload.push({ ownerId, file, name, signal }); return { ok: true, value: { receiptId: 'native-upload' } } } }
  const app = mount({ settings: { ...DEFAULT_SESSION_SETTINGS, defaultMode: 'normal' }, materials, sources, fileUpload, topics: topicRemote(), ...options,
    conversation: { submissions: { register(_rootOwner, registered) { contribution = registered; return () => {} } } } })
  const ui = app.renderer
  ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); await ui.flush()
  return { app, ui, calls, materials, fileUpload, sources, freeze(requestId) { return contribution.freeze({ sessionId: 'synthetic-main', requestId, timestamp: 0, mode: 'queue', draftRev: 1, source: 'click' }) } }
}

test('生产Workspace普通Send无需模型，正式提交A后保留编辑B并区分版本', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(), { app, ui } = f
  try {
    assert.equal(app.store.getActiveSession('synthetic-main').model, null)
    f.materials.submit = async request => { f.calls.submit.push(structuredClone(request)); await gate; return ok(receipt(request, 'submitted')) }
    await ui.input('待翻译内容', 'A'); assert.equal(ui.button('发送待译材料').props.disabled, false)
    ui.button('发送待译材料').props.onClick(); ui.render(); await ui.flush()
    assert.equal(ui.button('正在提交材料').props.disabled, true)
    await ui.input('待翻译内容', 'B'); release(); await ui.flush(); await ui.flush()
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.submit[0].material.sourceText, 'A')
    assert.equal(ui.control('待翻译内容').props.value, 'B'); assert.match(ui.text(), /已提交的是草稿版本.*当前草稿/)
    assert.ok(!ui.text().includes('翻译完成'))
  } finally { release(); await app.dispose() }
})

test('生产File选择同步传根freeze，原文与TXT共存明确阻止；UI移除后可以冻结文本', async () => {
  const f = await fixture(), { app, ui } = f
  try {
    await ui.input('待翻译内容', 'Synthetic material')
    const input = ui.allNodes().find(node => node.type === 'input' && node.props.type === 'file' && node.props['aria-label'] === '待译文件')
    assert.ok(input); assert.equal(input.props.disabled, false)
    input.props.onChange({ currentTarget: { files: [new File(['Source'], 'synthetic.txt')], value: 'synthetic.txt' } })
    // No render/effect is allowed between file selection and the root gesture.
    await assert.rejects(f.freeze('file-selected').prepare(new AbortController().signal), /原文与 TXT 请选择一种/)
    ui.render(); await ui.flush()
    assert.equal(ui.button('发送待译材料').props.disabled, true); assert.equal(f.calls.prepare.length, 0)
    await ui.click('移除待译文件')
    const prepared = f.freeze('file-removed'); await prepared.prepare(new AbortController().signal); prepared.finish('accepted'); await ui.flush()
    assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.prepare[0].material.sourceText, 'Synthetic material')
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic material')
  } finally { await app.dispose() }
})

test('生产TXT-only点击Send自动上传导入提交一次，无额外命令或确认', async () => {
  const f = await fixture(), { app, ui } = f
  try {
    const file = new File(['Source'], 'synthetic.txt')
    const input = ui.allNodes().find(node => node.type === 'input' && node.props.type === 'file')
    assert.equal(input.props.accept, '.txt')
    input.props.onChange({ currentTarget: { files: [file], value: file.name } }); ui.render(); await ui.flush()
    assert.equal(ui.button('发送待译材料').props.disabled, false)
    await ui.click('发送待译材料'); await ui.flush()
    assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.upload[0].file, file); assert.equal(f.calls.import.length, 1); assert.equal(f.calls.submit.length, 1)
    assert.equal(f.calls.submit[0].material.sourceText, undefined); assert.equal(f.calls.submit[0].material.sourceRef.name, file.name)
    assert.match(ui.text(), /TXT 可交付主模型准备，分批翻译尚未接入/); assert.match(ui.text(), /synthetic.txt/)
    assert.equal(app.mountCalls, 1); assert.equal(app.store.getTranslationHistory(app.store.getActiveSession('synthetic-main').id).units.length, 0)
  } finally { await app.dispose() }
  assert.equal(app.unmountCalls, 1); assert.equal(app.remote.translationSources, undefined)
})

test('生产主发送冻结File后关闭面板仍完成同份准备，文件不读字节', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve }), f = await fixture(), { app, ui } = f
  try {
    const file = new File(['Source'], 'synthetic.txt')
    for (const method of ['text', 'arrayBuffer', 'stream']) file[method] = () => assert.fail('only native upload may read File')
    ui.allNodes().find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ currentTarget: { files: [file], value: file.name } })
    const contribution = f.freeze('panel-frozen')
    f.fileUpload.upload = async (ownerId, frozen, name, signal) => { f.calls.upload.push({ ownerId, file: frozen, name, signal }); await gate; return { ok: true, value: { receiptId: 'panel-native' } } }
    const pending = contribution.prepare(new AbortController().signal)
    await ui.input('待翻译内容', 'new draft B')
    ui.render(app.settingsPage, {}); await ui.flush()
    assert.equal(app.materials.getSelectedFile(app.store.getActiveSession('synthetic-main').id), undefined)
    release(); await pending; contribution.finish('accepted'); await ui.flush()
    assert.equal(f.calls.upload[0].file, file); assert.equal(f.calls.prepare.length, 1)
    assert.equal(f.calls.prepare[0].material.sourceRef.name, file.name); assert.equal(f.calls.prepare[0].material.sourceText, undefined)
    assert.equal(app.store.getActiveSession('synthetic-main').input, 'new draft B')
  } finally { release(); await app.dispose() }
})

test('Sources随唯一aggregate mount就绪；挂载等待中卸载不会晚调用原稿RPC', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve }), f = await fixture({}, { mountGate: gate }), { app, ui } = f
  ui.allNodes().find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ currentTarget: { files: [new File(['Source'], 'synthetic.txt')], value: '' } })
  ui.render(); await ui.flush()
  assert.equal(ui.button('发送待译材料').props.disabled, true); assert.equal(f.calls.sourceCapabilities, 0)
  const disposing = app.dispose(); release(); await disposing
  assert.equal(f.calls.sourceCapabilities, 0); assert.equal(f.calls.upload.length, 0)
  assert.equal(app.mountCalls, 1); assert.equal(app.unmountCalls, 1); assert.equal(app.remote.translationSources, undefined)
})
