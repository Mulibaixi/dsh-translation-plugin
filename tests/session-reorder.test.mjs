import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionReorder, SESSION_REORDER_HOLD_MS } from '../dist/client/session-reorder.js'
import { reorderSurface, pointer } from './session-reorder-fixture.mjs'
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const surface = reorderSurface(['a', 'b', 'c']), previews = [], commits = []
  const gesture = createSessionReorder(drop => previews.push(drop), drop => commits.push(drop))
  const down = (id = 'a', overrides = {}) => gesture.down(id, { ...pointer('pointerdown', 15, overrides), currentTarget: surface.rows[['a', 'b', 'c'].indexOf(id)] })
  return { ...surface, previews, commits, gesture, down }
}

test('400ms长按激活，移动预览，松开提交并吞掉紧随的合成click', t => {
  const s = setup(t); s.down(); t.mock.timers.tick(SESSION_REORDER_HOLD_MS - 1)
  assert.equal(s.rows[0].capture, undefined); assert.deepEqual(s.previews, [])
  t.mock.timers.tick(1); assert.equal(s.rows[0].capture, 1)
  const moving = pointer('pointermove', 88); s.doc.dispatchEvent(moving)
  assert.equal(moving.defaultPrevented, true); assert.deepEqual(s.previews.at(-1), { id: 'a', targetId: 'c', after: true })
  s.doc.dispatchEvent(pointer('pointerup', 88))
  assert.deepEqual(s.commits, [{ id: 'a', targetId: 'c', after: true }]); assert.equal(s.rows[0].capture, undefined)
  assert.equal(s.gesture.consumeClick('b'), false); assert.equal(s.gesture.consumeClick('a'), true); assert.equal(s.gesture.consumeClick('a'), false)
  assert.equal(s.frames.size, 0); s.gesture.dispose()
})

test('短按、激活前移动和滚动保持原生行为，右键不启动长按', t => {
  const s = setup(t)
  s.down(); const release = pointer('pointerup'); s.doc.dispatchEvent(release); t.mock.timers.tick(400)
  assert.equal(release.defaultPrevented, false); assert.equal(s.gesture.consumeClick('a'), false)
  s.down(); const moving = pointer('pointermove', 30); s.doc.dispatchEvent(moving); t.mock.timers.tick(400)
  assert.equal(moving.defaultPrevented, false); assert.equal(s.rows[0].capture, undefined)
  s.down(); s.doc.dispatchEvent(new Event('scroll')); t.mock.timers.tick(400)
  s.down('a', { button: 2 }); t.mock.timers.tick(400)
  assert.deepEqual(s.previews, []); assert.deepEqual(s.commits, []); s.gesture.dispose()
})

test('pointercancel、Escape、失去捕获、显式取消和卸载清理长按与帧循环', t => {
  const s = setup(t)
  for (const type of ['pointercancel', 'keydown', 'lostpointercapture']) {
    s.down(); t.mock.timers.tick(400)
    if (type === 'lostpointercapture') s.rows[0].dispatchEvent(pointer(type))
    else if (type === 'keydown') s.doc.dispatchEvent(Object.assign(new Event(type), { key: 'Escape' }))
    else s.doc.dispatchEvent(pointer(type))
    assert.equal(s.rows[0].capture, undefined); assert.equal(s.frames.size, 0)
  }
  s.down(); s.gesture.cancel(); t.mock.timers.tick(400)
  s.down(); s.gesture.dispose(); t.mock.timers.tick(400)
  assert.deepEqual(s.commits, []); assert.equal(s.rows[0].capture, undefined)
})

test('激活后靠近边缘自动滚动，原生滚动重算预览，结束清帧', t => {
  const s = setup(t); s.down(); t.mock.timers.tick(400)
  s.doc.dispatchEvent(pointer('pointermove', 98)); s.frame()
  assert.ok(s.list.scrollTop > 0 && s.list.scrollTop <= 7); assert.equal(s.frames.size, 1)
  s.doc.dispatchEvent(new Event('scroll')); assert.equal(s.rows[0].capture, 1)
  s.doc.dispatchEvent(pointer('pointerup', 98)); assert.equal(s.frames.size, 0); assert.equal(s.commits.length, 1)
  s.gesture.dispose()
})
