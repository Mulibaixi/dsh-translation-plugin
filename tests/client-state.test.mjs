import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  applyDefaultModel,
  createDraft,
  decodeDraft,
  decodeSettings,
  draftStorageKey,
  validateDraft,
  validateSettings,
} from '../dist/client/legacy-state.js'

function configuredSettings(overrides = {}) {
  return { ...DEFAULT_SETTINGS, providerId: 'provider-a', modelId: 'model-a', ...overrides }
}

function readyDraft(overrides = {}) {
  return { ...createDraft(configuredSettings()), sourceText: '待译原文', ...overrides }
}

test('默认设置不预设模型、不开启本地文本保存', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    schemaVersion: 1,
    providerId: '',
    modelId: '',
    defaultMode: 'quick',
    targetLanguage: '中文',
    defaultInstruction: '',
    maxInputChars: 20000,
    rememberDrafts: false,
  })
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), [])
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true)
})

test('新草稿冻结当时默认值，默认设置后续修改不影响已有草稿', () => {
  const settings = configuredSettings({ defaultInstruction: '保持术语', targetLanguage: '英文' })
  const draft = createDraft(settings)
  settings.providerId = 'provider-b'
  settings.modelId = 'model-b'
  settings.defaultInstruction = '改用口语'
  settings.targetLanguage = '法语'
  assert.equal(draft.providerId, 'provider-a')
  assert.equal(draft.modelId, 'model-a')
  assert.equal(draft.instruction, '保持术语')
  assert.equal(draft.targetLanguage, '英文')
  assert.equal(draft.mode, 'quick')
  assert.equal(createDraft(settings, 'normal').mode, 'normal')
})

test('显式应用默认模型只更新模型字段，不覆盖编辑内容', () => {
  const draft = readyDraft({
    mode: 'normal',
    instruction: '保留称谓',
    targetLanguage: '日文',
    manualTranslation: '人工编辑内容',
    providerId: 'custom-provider',
    modelId: 'custom-model',
    modelSource: 'override',
  })
  const before = { ...draft }
  const updated = applyDefaultModel(draft, configuredSettings({ providerId: 'new-provider', modelId: 'new-model' }))
  assert.deepEqual(updated, { ...before, providerId: 'new-provider', modelId: 'new-model', modelSource: 'default' })
  assert.deepEqual(draft, before)
  assert.notEqual(updated, draft)
})

test('设置严格校验 schema、字段和类型，不吞掉额外凭据字段', () => {
  const valid = configuredSettings()
  assert.deepEqual(decodeSettings(valid), valid)
  for (const value of [null, [], 'invalid', {}, { ...valid, schemaVersion: 2 },
    { ...valid, schemaVersion: '1' }, { ...valid, rememberDrafts: 'false' },
    { ...valid, defaultMode: 'auto' }, { ...valid, apiKey: 'unexpected-secret' },
    { ...valid, providerId: 123 }, { ...valid, modelId: null },
    { ...valid, defaultInstruction: {} }, { ...valid, targetLanguage: [] }]) {
    assert.equal(decodeSettings(value), undefined)
    assert.ok(validateSettings(value).length > 0)
  }
  const { targetLanguage: _omitted, ...incomplete } = valid
  assert.equal(decodeSettings(incomplete), undefined)
})

test('设置输入上限只允许 1 至 200000 的整数', () => {
  for (const maxInputChars of [1, 200000]) {
    assert.deepEqual(validateSettings(configuredSettings({ maxInputChars })), [])
  }
  for (const maxInputChars of [0, -1, 200001, 1.5, NaN, Infinity, '20000']) {
    assert.equal(decodeSettings(configuredSettings({ maxInputChars })), undefined)
  }
})

test('字符串长度边界按 Unicode codepoint 检查且不裁剪', () => {
  const valid = configuredSettings({
    providerId: '供'.repeat(200),
    modelId: '😀'.repeat(200),
    targetLanguage: '文'.repeat(80),
    defaultInstruction: '😀'.repeat(4000),
  })
  assert.deepEqual(decodeSettings(valid), valid)
  for (const [field, text] of [
    ['providerId', '供'.repeat(201)], ['modelId', '😀'.repeat(201)],
    ['targetLanguage', '文'.repeat(81)], ['defaultInstruction', '😀'.repeat(4001)],
  ]) {
    assert.equal(decodeSettings({ ...valid, [field]: text }), undefined)
  }
  assert.equal(decodeSettings({ ...valid, targetLanguage: ' \n\t' }), undefined)
})

test('草稿可恢复未完成的空输入，不误判为可提交任务', () => {
  const draft = createDraft(DEFAULT_SETTINGS)
  assert.deepEqual(decodeDraft(draft), draft)
  assert.ok(validateDraft(draft, DEFAULT_SETTINGS).some((error) => error.includes('原文不能为空')))
  assert.ok(validateDraft(draft, DEFAULT_SETTINGS).some((error) => error.includes('Provider ID不能为空')))
  assert.ok(validateDraft(draft, DEFAULT_SETTINGS).some((error) => error.includes('Model ID不能为空')))
  assert.deepEqual(decodeDraft({ ...draft, targetLanguage: '' }), { ...draft, targetLanguage: '' })
})

test('草稿解码严格拒绝不支持的 schema、模式、来源、缺字段与错误类型', () => {
  const draft = readyDraft()
  for (const value of [null, [], {}, { ...draft, schemaVersion: 2 },
    { ...draft, mode: 'auto' }, { ...draft, modelSource: 'main-chat' },
    { ...draft, sourceText: 12 }, { ...draft, instruction: null },
    { ...draft, manualTranslation: [] }, { ...draft, providerId: false },
    { ...draft, modelId: {} }, { ...draft, targetLanguage: 1 },
    { ...draft, apiKey: 'unexpected-secret' }]) {
    assert.equal(decodeDraft(value), undefined)
  }
  const { manualTranslation: _omitted, ...incomplete } = draft
  assert.equal(decodeDraft(incomplete), undefined)
})

test('草稿恢复允许 200000 字符，但不裁剪过大的原文或人工稿', () => {
  for (const field of ['sourceText', 'manualTranslation']) {
    const boundary = readyDraft({ [field]: '😀'.repeat(200000) })
    assert.deepEqual(decodeDraft(boundary), boundary)
    assert.equal(decodeDraft({ ...boundary, [field]: '😀'.repeat(200001) }), undefined)
  }
  for (const [field, text] of [
    ['instruction', '中'.repeat(4001)], ['targetLanguage', '语'.repeat(81)],
    ['providerId', 'p'.repeat(201)], ['modelId', 'm'.repeat(201)],
  ]) {
    assert.equal(decodeDraft(readyDraft({ [field]: text })), undefined)
  }
})

test('提交检查使用中文与 emoji 字符数，单个 emoji 不按两个字符计算', () => {
  const settings = configuredSettings({ maxInputChars: 3 })
  assert.deepEqual(validateDraft(readyDraft({ sourceText: '中😀文' }), settings), [])
  assert.ok(validateDraft(readyDraft({ sourceText: '中😀文字' }), settings)
    .some((error) => error.includes('不能超过 3 个字符')))
  assert.ok(validateDraft(readyDraft({ sourceText: ' \n\t' }), settings)
    .some((error) => error.includes('原文不能为空')))
})

test('未配置独立模型、空目标语言和过长要求不能通过提交检查', () => {
  const settings = configuredSettings()
  for (const overrides of [
    { providerId: ' ' }, { modelId: '' }, { targetLanguage: '\t' },
    { instruction: '长'.repeat(4001) },
  ]) {
    assert.ok(validateDraft(readyDraft(overrides), settings).length > 0)
  }
})

test('草稿存储键严格隔离会话与模式，编码分隔符与中文', () => {
  const session = '会话/a:b %'
  const normal = draftStorageKey(session, 'normal')
  const quick = draftStorageKey(session, 'quick')
  assert.notEqual(normal, quick)
  assert.notEqual(quick, draftStorageKey(`${session}2`, 'quick'))
  assert.ok(quick.includes(encodeURIComponent(session)))
  assert.notEqual(draftStorageKey('a:b', 'quick'), draftStorageKey('a%3Ab', 'quick'))
  assert.equal(quick, draftStorageKey(session, 'quick'))
  assert.throws(() => draftStorageKey(' \t', 'quick'), /会话标识/)
  assert.throws(() => draftStorageKey('session', 'auto'), /模式无效/)
})
