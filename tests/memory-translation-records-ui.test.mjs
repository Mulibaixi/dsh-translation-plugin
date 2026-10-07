import assert from 'node:assert/strict'
import test from 'node:test'
import { mount } from './quick-client-fixture.mjs'
import { memoryAssetsAddress } from '../dist/client/memory-assets-window.js'
import { appendTextUnit, appendTextRevision, selectFinalRevision, emptyTranslationHistory } from '../dist/client/translation-history.js'

const owner = 'synthetic-continuous-records', at = '2026-01-01T00:00:00.000Z'
function seed(store, session, entries) {
  let history = emptyTranslationHistory()
  entries.forEach((entry, index) => {
    const id = `unit:${session.id}:${index + 1}`, revisionId = `revision:${id}`
    const revision = { id: revisionId, operationId: `op:${id}`, model: { provider: 'provider-a', model: 'm1' }, draftVersion: 1,
      createdAt: at, updatedAt: at, accepted: true, status: 'completed', text: entry.translation, message: null }
    history = appendTextUnit(history, { id, source: entry.source, targetLanguage: '中文', instruction: '', createdAt: at }, revision)
    if (entry.final) history = selectFinalRevision(history, id, revisionId, at)
    if (entry.failedLatest) history = appendTextRevision(history, id, { ...revision, id: `failed:${id}`, operationId: `failed-op:${id}`, status: 'failed', text: '', message: 'synthetic failure' })
  })
  assert.equal(store.updateTranslationHistory(session.id, () => history), true)
  return history
}
async function setup() {
  const app = mount(), ui = app.renderer
  ui.render(app.panel, { sessionId: owner }); await ui.flush()
  const first = app.store.getActiveSession(owner)
  app.store.updateSession(first.id, { remark: '第一会话备注' })
  const second = app.store.createSession(owner, first.id), archived = app.store.createSession(owner, first.id, false)
  app.store.archiveSession(owner, archived.id)
  seed(app.store, first, [{ source: 'A source 1', translation: 'A final 1', final: true }, { source: 'A source 2', translation: 'A old complete candidate', failedLatest: true }])
  seed(app.store, second, [{ source: 'B source', translation: 'B final', final: true }])
  seed(app.store, archived, [{ source: 'Archived source', translation: 'Archived final', final: true }])
  const address = memoryAssetsAddress(owner, first.topicId)
  async function open(session = first) {
    app.resourceHost.restoreResource(owner, address, { topicId: session.topicId, sessionId: session.id }); await ui.flush(); await ui.click('译文记录')
  }
  return { app, ui, store: app.store, first, second, archived, address, open }
}
function groups(ui) { return ui.nodes().filter(node => node.props.className === 'dsh-tp-records-session') }
function records(ui) { return ui.nodes().find(node => node.props['aria-label'] === '译文记录' && node.type === 'section') }
function reader(ui) { return ui.nodes().find(node => node.props.className === 'dsh-tp-records-reader') }
function unit(ui, sessionId, order = 1) {
  const result = ui.nodes().find(node => node.type === 'article' && node.props['data-unit-id'] === `unit:${sessionId}:${order}`)
  assert.ok(result); return result
}
async function inUnit(ui, row, text) {
  const button = ui.nodes(row).find(node => node.type === 'button' && ui.text(node) === text)
  assert.ok(button); assert.ok(!button.props.disabled); button.props.onClick(); ui.render(); await ui.flush()
}
async function selectTopic(ui, topicId, bodyOnly = false) {
  const toolbar = bodyOnly ? ui.nodes().find(node => node.props.className === 'dsh-tp-assets-topic-toolbar') : undefined
  const anchor = toolbar ? ui.nodes(toolbar).find(node => node.props['aria-label'] === '选择资产主题') : ui.button('选择资产主题')
  anchor.props.onClick(); ui.render()
  const list = ui.nodes().find(node => node.props['aria-label'] === '资产主题列表')
  ui.nodes(list).find(node => node.props['data-topic-id'] === topicId).props.onClick(); ui.render(); await ui.flush()
}

test('连续记录：默认关联会话且不跟随工作区，主题含归档按固定序号逐单元配对，无最终不回退', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  await f.open(f.second)
  assert.equal(records(f.ui).props['data-records-scope'], 'session')
  assert.deepEqual(groups(f.ui).map(node => node.props['data-session-id']), [f.second.id])
  f.store.openSession(owner, f.first.id); f.ui.render()
  assert.deepEqual(groups(f.ui).map(node => node.props['data-session-id']), [f.second.id])
  assert.equal(f.store.moveSessionInDisplay(owner, f.second.id, f.first.id), true)
  await f.ui.input('译文查阅范围', 'topic')
  assert.deepEqual(groups(f.ui).map(node => node.props['data-session-id']), [f.first.id, f.second.id, f.archived.id])
  const rows = f.ui.nodes().filter(node => node.props.className === 'dsh-tp-record-unit')
  assert.equal(rows.length, 4)
  for (const row of rows) assert.deepEqual(f.ui.nodes(row).filter(node => ['原文', '最终译文'].includes(node.props['aria-label'])).map(node => node.props['aria-label']), ['原文', '最终译文'])
  const target = f.ui.nodes(unit(f.ui, f.first.id, 2)).find(node => node.props['aria-label'] === '最终译文')
  assert.match(f.ui.text(target), /尚无最终译文/); assert.ok(!f.ui.text(target).includes('A old complete candidate'))
  assert.equal(f.ui.nodes().filter(node => node.type === 'textarea').length, 0, 'reading does not begin editing')
  assert.equal(f.store.getTranslationHistory(f.first.id).units[1].final, null, 'reading does not finalize')
  assert.equal(groups(f.ui)[0].children[0].children.join(''), '第一会话备注')
  assert.ok(!f.ui.nodes().some(node => node.props['aria-label'] === '译文条目列表'))
})

test('连续记录：会话/范围/主题切换保留稿与滚动，显式重复导航采用关联会话，停靠正文主题Menu同scope', async t => {
  const f = await setup(); t.after(() => f.app.dispose()); await f.open()
  await f.ui.click(`${f.first.name} · 文本 1`); await f.ui.click('编辑译文'); await f.ui.input('编辑译文', 'A unsaved draft')
  const scrollElement = { scrollTop: 180 }; reader(f.ui).props.ref.current = scrollElement
  reader(f.ui).props.onScroll({ currentTarget: scrollElement })
  await f.ui.input('查阅会话', f.second.id); assert.equal(scrollElement.scrollTop, 0)
  await f.ui.click(`${f.second.name} · 文本 1`); await f.ui.click('编辑译文'); await f.ui.input('编辑译文', 'B unsaved draft')
  scrollElement.scrollTop = 70; reader(f.ui).props.onScroll({ currentTarget: scrollElement })
  await f.ui.input('译文查阅范围', 'topic'); assert.equal(scrollElement.scrollTop, 0)
  const other = f.store.createSession(owner); seed(f.store, other, [{ source: 'Other topic source', translation: 'Other topic final', final: true }]); f.ui.render()
  await selectTopic(f.ui, other.topicId, true); await f.ui.click('译文记录')
  assert.equal(records(f.ui).props['data-records-scope'], 'topic', 'no association defaults to topic')
  const hiddenReader = f.ui.allNodes().find(node => node.props.className === 'dsh-tp-records-reader' && node.props.ref.current === scrollElement)
  hiddenReader.props.onScroll({ currentTarget: { scrollTop: 0 } })
  await selectTopic(f.ui, f.first.topicId, true)
  assert.equal(records(f.ui).props['data-records-scope'], 'topic')
  await f.ui.input('译文查阅范围', 'session'); assert.equal(f.ui.control('查阅会话').props.value, f.second.id)
  assert.equal(scrollElement.scrollTop, 70); assert.equal(f.ui.control('编辑译文').props.value, 'B unsaved draft')
  await f.ui.input('查阅会话', f.first.id); assert.equal(scrollElement.scrollTop, 180); assert.equal(f.ui.control('编辑译文').props.value, 'A unsaved draft')
  await f.ui.input('译文查阅范围', 'topic'); await f.open(f.second)
  assert.equal(records(f.ui).props['data-records-scope'], 'session'); assert.equal(f.ui.control('查阅会话').props.value, f.second.id)
  assert.equal(f.ui.control('编辑译文').props.value, 'B unsaved draft')
  assert.equal(f.store.getActiveSession(owner).id, other.id, 'asset navigation does not change the workspace')
})

test('连续记录：原文/旧修订不可变，人工新候选独立设最终，归档保持只读', async t => {
  const f = await setup(); t.after(() => f.app.dispose()); await f.open()
  const before = structuredClone(f.store.getTranslationHistory(f.first.id).units[0])
  await f.ui.click(`${f.first.name} · 文本 1`); await f.ui.click('编辑译文'); await f.ui.input('编辑译文', 'New manual candidate'); await f.ui.click('保存新版本')
  let current = f.store.getTranslationHistory(f.first.id).units[0]
  assert.equal(current.source, before.source); assert.deepEqual(structuredClone(current.revisions[0]), before.revisions[0]); assert.deepEqual(structuredClone(current.final), before.final)
  assert.equal(current.revisions.at(-1).kind, 'manual'); assert.equal(current.revisions.at(-1).baseRevisionId, before.revisions[0].id)
  assert.match(f.ui.text(), /候选 · 版本 2/)
  await inUnit(f.ui, unit(f.ui, f.first.id), '设为最终')
  current = f.store.getTranslationHistory(f.first.id).units[0]
  assert.equal(current.final.revisionId, current.revisions.at(-1).id)
  await inUnit(f.ui, unit(f.ui, f.first.id), '复制最终译文'); assert.equal(f.app.copies.at(-1), 'New manual candidate')
  f.store.archiveSession(owner, f.first.id); f.ui.render()
  const button = f.ui.nodes(unit(f.ui, f.first.id)).find(node => node.type === 'button' && f.ui.text(node) === '编辑译文')
  assert.equal(button.props.disabled, true)
})

test('连续记录导出：当前会话快照冻结缺项，切主题范围不扩确认；主题导出含归档按固定序号', async t => {
  const f = await setup(); t.after(() => f.app.dispose()); await f.open()
  await f.ui.click('导出 JSON'); assert.ok(f.ui.nodes().some(node => node.props['aria-label'] === '导出译文确认'))
  await f.ui.input('译文查阅范围', 'topic')
  const secondUnit = f.store.getTranslationHistory(f.first.id).units[1]
  f.store.updateTranslationHistory(f.first.id, history => selectFinalRevision(history, secondUnit.id, secondUnit.revisions[0].id, at)); f.ui.render()
  await f.ui.click('仅导出已定稿')
  const frozen = JSON.parse(await f.app.downloads[0].blob.text())
  assert.equal(frozen.scope, 'session'); assert.equal(frozen.sessions.length, 1); assert.equal(frozen.sessions[0].id, f.first.id)
  assert.equal(frozen.sessions[0].units[1].status, 'missing'); assert.equal(frozen.sessions[0].units[1].translation, null)
  assert.equal(f.store.moveSessionInDisplay(owner, f.second.id, f.first.id), true)
  await f.ui.click('导出 TXT')
  assert.equal(await f.app.downloads[1].blob.text(), 'A final 1\n\nA old complete candidate\n\nB final\n\nArchived final')
  await f.ui.click('导出 JSON')
  const topic = JSON.parse(await f.app.downloads[2].blob.text())
  assert.equal(topic.scope, 'topic'); assert.deepEqual(topic.sessions.map(session => session.id), [f.first.id, f.second.id, f.archived.id])
})

test('连续记录：无关联/空会话明示空态，全缺导出不补旧成功；双列与窄屏行结构保持', async t => {
  const f = await setup(); t.after(() => f.app.dispose())
  const empty = f.store.createSession(owner, f.first.id, false)
  await f.open(empty); assert.match(f.ui.text(), /当前范围尚无译文记录/)
  assert.equal(groups(f.ui).length, 0)
  const failed = f.store.createSession(owner); seed(f.store, failed, [{ source: 'Missing source', translation: 'Old successful body', failedLatest: true }]); await f.open(failed)
  await f.ui.click('导出 TXT'); assert.equal(f.ui.button('仅导出已定稿').props.disabled, true); assert.equal(f.app.downloads.length, 0)
  assert.equal(f.store.getTranslationHistory(failed.id).units[0].final, null)
  const styles = f.ui.allNodes().filter(node => node.type === 'style').map(node => node.children.join('')).join('\n')
  assert.match(styles, /\.dsh-tp-record-pair\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/u)
  assert.match(styles, /@container \(max-width: 600px\)[^]*?\.dsh-tp-record-pair\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/u)
  assert.match(styles, /\[data-dockkit-float\] \.dsh-tp-assets-topic-toolbar\s*\{\s*display: none/u)
})
