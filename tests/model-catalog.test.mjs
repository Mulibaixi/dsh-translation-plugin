import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelCatalog, matchesModel } from '../dist/client/models.js'

const catalogValue = () => ({ ok: true, value: { default: { provider: 'deepseek', model: 'model-a' }, routableProviders: [], groups: [
  { id: 'third-party', name: 'Third', models: [{ id: 'model-c', name: 'Other' }] },
  { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'model-a', name: 'DeepSeek Model', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] },
  { id: 'deepseek-account', name: 'Account', models: [{ id: 'model-b', name: 'Account Model' }] },
], failures: [{ id: 'failed', name: 'Failed Provider', message: 'private error details are not shown' }] } })

test('模型目录通过主窗口同一 modelCatalog API 懒加载并共享一次在途请求', async () => {
  let calls = 0; const models = new ModelCatalog({ modelCatalog: async () => { calls++; return catalogValue() } })
  assert.equal(calls, 0); const a = models.load(); const b = models.load(); assert.equal(a, b)
  await a; await models.load(); assert.equal(calls, 1); assert.equal(models.getSnapshot().status, 'ready')
  assert.deepEqual(models.getSnapshot().groups.map(group => group.id), ['deepseek-account', 'deepseek', 'third-party'])
  assert.equal(models.getSnapshot().groups[1].models[0].reasoning.defaultEffort, 'high')
  assert.deepEqual(models.getSnapshot().failures, [{ id: 'failed', name: 'Failed Provider' }])
})
test('Host 目录错误或结构不符时报告失败，不构造假模型', async () => {
  for (const response of [{ ok: false, error: {} }, { ok: true, value: {} }]) {
    const models = new ModelCatalog({ modelCatalog: async () => response }); await models.load()
    assert.equal(models.getSnapshot().status, 'error'); assert.deepEqual(models.getSnapshot().groups, [])
  }
})
test('目录失效与断连后忽略旧响应，重新加载新 Host 目录', async () => {
  const resolvers = []; const models = new ModelCatalog({ modelCatalog: () => new Promise(resolve => resolvers.push(resolve)) })
  const first = models.load(); await Promise.resolve(); models.invalidate(true)
  const second = models.load(); await Promise.resolve(); resolvers[1](catalogValue()); await second
  const newer = models.getSnapshot(); resolvers[0]({ ok: false }); await first
  assert.equal(models.getSnapshot(), newer); models.invalidate(true); assert.deepEqual(models.getSnapshot().groups, [])
})
test('目录卸载后在途结果不写入，订阅注销有效', async () => {
  let resolve; let notified = 0; const models = new ModelCatalog({ modelCatalog: () => new Promise(fn => { resolve = fn }) })
  const off = models.subscribe(() => { notified++ }); const pending = models.load(); await Promise.resolve(); off(); models.dispose(); resolve(catalogValue()); await pending
  assert.equal(notified, 1); assert.equal(models.getSnapshot().status, 'loading')
})
test('搜索与主窗口一样支持忽略大小写、空格及非连续字符', () => {
  assert.equal(matchesModel('DeepSeek Model', '  dsm  '), true); assert.equal(matchesModel('DeepSeek Model', 'xyz'), false); assert.equal(matchesModel('Other', ''), true)
})
