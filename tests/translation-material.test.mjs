import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTranslationMaterialEnvelope } from '../dist/shared/translation-material.js'
import { TranslationMaterialStore } from '../dist/memory/translation-material-store.js'

const scope = { ownerId: 'main-a', mainSessionId: 'main-a', requestId: 'request-a', operationId: 'operation-a' }
function material(patch = {}) {
  return { materialId: 'material-a', sourceVersion: 1, topicId: 'topic-a', translationSessionId: 'translation-a', draftVersion: 7,
    sourceText: 'Synthetic original\nSecond line', targetLanguage: '中文', instruction: 'Keep the line break',
    model: { provider: 'synthetic', model: 'translation', reasoningEffort: 'high' }, maxInputChars: 20000, ...patch }
}
function envelope(scopePatch = {}, materialPatch = {}) { return { ...scope, ...scopePatch, kind: 'material', material: material(materialPatch) } }
function accepted(result) { assert.equal(result.ok, true); return result.value }

test('同一主提交只同步冻结一次；当前草稿编辑和调用者修改不能回写已提交快照', () => {
  const store = new TranslationMaterialStore(), draft = material()
  let captures = 0
  const capture = () => { captures++; return { kind: 'material', material: draft } }
  const first = accepted(store.freeze(scope, capture))
  draft.sourceText = 'Synthetic next draft'; draft.draftVersion++
  draft.targetLanguage = 'English'; draft.model.model = 'next-model'
  first.material.sourceText = 'Caller modification'; first.material.model.model = 'caller-model'
  const repeated = accepted(store.freeze(scope, capture))
  assert.equal(captures, 1)
  assert.equal(repeated.material.sourceText, 'Synthetic original\nSecond line')
  assert.equal(repeated.material.targetLanguage, '中文')
  assert.equal(repeated.material.model.model, 'translation')
  assert.equal(repeated.material.draftVersion, 7)
  repeated.material.instruction = 'Caller edit'
  assert.equal(store.get('main-a', 'request-a').material.instruction, 'Keep the line break')
  assert.equal(draft.sourceText, 'Synthetic next draft')
  assert.equal(store.storage, 'runtime_only')
})

test('材料以主会话和requestId隔离；重复桥交付复用原快照，冲突不会覆盖', () => {
  const store = new TranslationMaterialStore()
  const original = accepted(store.receive(envelope()))
  const reordered = { kind: 'material', material: { ...material(), model: { model: 'translation', provider: 'synthetic', reasoningEffort: 'high' } }, ...scope }
  assert.deepEqual(accepted(store.receive(reordered)), original)
  assert.equal(store.receive(envelope({}, { sourceText: 'Conflicting source' })).error.code, 'idempotency_conflict')
  let captured = false
  const conflict = store.freeze({ ...scope, operationId: 'different-operation' }, () => { captured = true; return { kind: 'none' } })
  assert.equal(conflict.error.code, 'idempotency_conflict'); assert.equal(captured, false)
  accepted(store.receive(envelope({ ownerId: 'main-b', mainSessionId: 'main-b', operationId: 'operation-b' }, { materialId: 'material-b', topicId: 'topic-b', translationSessionId: 'translation-b', sourceText: 'Other owner' })))
  assert.equal(store.get('main-a', 'request-a').material.sourceText, original.material.sourceText)
  assert.equal(store.get('main-b', 'request-a').material.sourceText, 'Other owner')
})

test('未到达、明确无材料和本次取消是三个不同结果；none/omit不能携带正文', () => {
  const store = new TranslationMaterialStore()
  assert.equal(store.get('main-a', 'request-a'), undefined)
  assert.deepEqual(accepted(store.freeze(scope, () => ({ kind: 'none' }))), { ...scope, kind: 'none' })
  const omitted = { ...scope, requestId: 'request-b', operationId: 'operation-b' }
  assert.deepEqual(accepted(store.freeze(omitted, () => ({ kind: 'omit' }))), { ...omitted, kind: 'omit' })
  for (const kind of ['none', 'omit']) assert.throws(() => parseTranslationMaterialEnvelope({ ...scope, kind, material: material() }), TypeError)
})

test('讨论允许未选翻译模型；单次上限使用Unicode码点且不混淆草稿版本与源版本', () => {
  const value = parseTranslationMaterialEnvelope(envelope({}, { sourceText: '😀文', maxInputChars: 2, model: null, draftVersion: 23 }))
  assert.equal(value.material.model, null)
  assert.equal(value.material.sourceVersion, 1)
  assert.equal(value.material.draftVersion, 23)
  assert.equal(value.material.sourceText, '😀文')
  assert.throws(() => parseTranslationMaterialEnvelope(envelope({}, { sourceText: '😀文', maxInputChars: 1 })), TypeError)
  assert.throws(() => parseTranslationMaterialEnvelope({ ...value, mainSessionId: 'other-main' }), TypeError)
  assert.throws(() => parseTranslationMaterialEnvelope({ ...value, mainCommand: 'Do something' }), TypeError)
  assert.throws(() => parseTranslationMaterialEnvelope(envelope({}, { files: ['synthetic.txt'] })), TypeError)
})

test('明确修正的前源版本引用与旧单元引用可独立保留；引用本身不修改原快照', () => {
  const store = new TranslationMaterialStore()
  accepted(store.receive(envelope({}, { unitReference: { unitId: 'old-unit', sourceVersion: 4 } })))
  const corrected = envelope({ requestId: 'request-correction', operationId: 'operation-correction' }, {
    sourceVersion: 2, draftVersion: 8, sourceText: 'Synthetic corrected source',
    unitReference: { unitId: 'old-unit', sourceVersion: 4 },
    revises: { materialId: 'material-a', sourceVersion: 1, operationId: 'operation-a' },
  })
  accepted(store.receive(corrected))
  const previous = store.get('main-a', 'request-a'), next = store.get('main-a', 'request-correction')
  assert.equal(previous.material.sourceVersion, 1)
  assert.equal(previous.material.sourceText, 'Synthetic original\nSecond line')
  assert.equal(next.material.materialId, previous.material.materialId)
  assert.deepEqual(next.material.revises, { materialId: 'material-a', sourceVersion: 1, operationId: 'operation-a' })
  assert.deepEqual(next.material.unitReference, { unitId: 'old-unit', sourceVersion: 4 })
  assert.throws(() => parseTranslationMaterialEnvelope({ ...corrected, material: { ...corrected.material, revises: { ...corrected.material.revises, materialId: 'different-material' } } }), TypeError)
})

test('释放仅影响指定待联动快照；关闭清除运行期材料并停止后续冻结', () => {
  const store = new TranslationMaterialStore()
  accepted(store.receive(envelope()))
  accepted(store.receive(envelope({ requestId: 'request-b', operationId: 'operation-b' }, { materialId: 'material-b' })))
  assert.equal(store.release('other-main', 'request-a'), false)
  assert.equal(store.release('main-a', 'request-a'), true)
  assert.equal(store.get('main-a', 'request-a'), undefined)
  assert.equal(store.get('main-a', 'request-b').material.materialId, 'material-b')
  store.dispose()
  assert.equal(store.get('main-a', 'request-b'), undefined)
  let captured = false
  const result = store.freeze(scope, () => { captured = true; return { kind: 'none' } })
  assert.equal(result.error.code, 'invalid_state'); assert.equal(captured, false)
  assert.equal(store.receive(envelope()).error.code, 'invalid_state')
})
