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
async function fixture(remote = {}) {
  let contribution
  const calls = { prepare: [], submit: [] }
  const materials = {
    async capabilities() { return ok({ ready: true, directSubmit: true, storage: 'runtime_only' }) },
    async prepare(request) { calls.prepare.push(structuredClone(request)); return ok(receipt(request)) },
    async finish(request) { return ok(receipt({ ...request, kind: calls.prepare.at(-1)?.kind ?? 'material' }, request.outcome === 'submitted' ? 'submitted' : 'released')) },
    async submit(request) { calls.submit.push(structuredClone(request)); return ok(receipt(request, 'submitted')) },
    ...remote,
  }
  const app = mount({ settings: { ...DEFAULT_SESSION_SETTINGS, defaultMode: 'normal' }, materials, topics: topicRemote(),
    conversation: { submissions: { register(_rootOwner, registered) { contribution = registered; return () => {} } } } })
  const ui = app.renderer
  ui.render(app.panel, { sessionId: 'synthetic-main' }); await ui.flush(); await ui.flush()
  return { app, ui, calls, materials, freeze(requestId) { return contribution.freeze({ sessionId: 'synthetic-main', requestId, timestamp: 0, mode: 'queue', draftRev: 1, source: 'click' }) } }
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

test('生产File选择同步传根freeze，native材料被阻止；UI移除后可以冻结文本', async () => {
  const f = await fixture(), { app, ui } = f
  try {
    await ui.input('待翻译内容', 'Synthetic material')
    const input = ui.allNodes().find(node => node.type === 'input' && node.props.type === 'file' && node.props['aria-label'] === '待译文件')
    assert.ok(input); assert.equal(input.props.disabled, false)
    input.props.onChange({ currentTarget: { files: [{ name: 'synthetic.txt' }], value: 'synthetic.txt' } })
    // No render/effect is allowed between file selection and the root gesture.
    await assert.rejects(f.freeze('file-selected').prepare(new AbortController().signal), /文件材料尚未接入/)
    ui.render(); await ui.flush()
    assert.equal(ui.button('发送待译材料').props.disabled, true); assert.equal(f.calls.prepare.length, 0)
    await ui.click('移除待译文件')
    const prepared = f.freeze('file-removed'); await prepared.prepare(new AbortController().signal); prepared.finish('accepted'); await ui.flush()
    assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.prepare[0].material.sourceText, 'Synthetic material')
    assert.equal(ui.control('待翻译内容').props.value, 'Synthetic material')
  } finally { await app.dispose() }
})
