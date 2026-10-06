import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_ASSETS_TAB_KIND, memoryAssetsAddress, openMemoryAssets, parseMemoryAssetsAddress,
} from '../dist/client/memory-assets-window.js'

const scope = { ownerId: 'owner-a', topicId: 'topic-a' }

function fixture({ visible = true, mounted = scope.ownerId, restored = false, commit = true } = {}) {
  let tabs = restored ? [{ sessionId: scope.ownerId, tabId: 'restored', kind: MEMORY_ASSETS_TAB_KIND, contentId: memoryAssetsAddress(scope.ownerId, scope.topicId) }] : []
  let next = 0
  const opened = []
  const floated = []
  const abort = new AbortController()
  const sidebar = {
    mounted: { getSnapshot: () => mounted },
    openTabs: { getSnapshot: () => tabs },
    float(tabId, rect) { floated.push({ tabId, rect }) },
  }
  const tab = {
    id: 'workspace', contentId: 'workspace', navigation: { address: 'workspace' }, visible, signal: abort.signal,
    actions: {
      openResource(address) {
        opened.push(address)
        if (commit && !tabs.some(row => row.sessionId === scope.ownerId && row.kind === MEMORY_ASSETS_TAB_KIND && row.contentId === address)) {
          tabs = [...tabs, { sessionId: scope.ownerId, tabId: `asset-${++next}`, kind: MEMORY_ASSETS_TAB_KIND, contentId: address }]
        }
        // Actual DSH openResource deliberately returns void.
      },
      close() {},
    },
  }
  return {
    sidebar, origin: { ownerId: scope.ownerId, tab }, abort, opened, floated,
    closeAsset() { tabs = [] },
    setMounted(value) { mounted = value },
    addOtherOwner() { tabs = [{ sessionId: 'owner-b', tabId: 'foreign', kind: MEMORY_ASSETS_TAB_KIND, contentId: memoryAssetsAddress(scope.ownerId, scope.topicId) }] },
  }
}

test('resource identity round-trips encoded owner/topic and a fixed terms entry', () => {
  const expected = { ownerId: '主 会话/one', topicId: '主题?two#%' }
  const address = memoryAssetsAddress(expected.ownerId, expected.topicId)
  assert.equal(address, 'dsh-resource://translation-assets/%E4%B8%BB%20%E4%BC%9A%E8%AF%9D%2Fone/%E4%B8%BB%E9%A2%98%3Ftwo%23%25/terms')
  assert.deepEqual(parseMemoryAssetsAddress(address), expected)
})

test('invalid resource scope or malformed address is rejected', () => {
  const address = memoryAssetsAddress(scope.ownerId, scope.topicId)
  for (const value of [
    'https://translation-assets/owner-a/topic-a/terms', address + '/extra', address + '?owner=other', address + '#other',
    'dsh-resource://translation-assets//topic/terms', 'dsh-resource://translation-assets/owner/%FF/terms',
    'dsh-resource://translation-assets/%00/topic/terms', 'dsh-resource://translation-assets/../topic/terms',
    'dsh-resource://user@translation-assets/owner/topic/terms', 'dsh-resource://translation-assets/owner/topic/records',
  ]) assert.equal(parseMemoryAssetsAddress(value), undefined, value)
  assert.throws(() => memoryAssetsAddress('', 'topic'))
  assert.throws(() => memoryAssetsAddress('owner', '..'))
})

test('resource owner is checked against its enclosing Session rather than current focus', () => {
  const address = memoryAssetsAddress(scope.ownerId, scope.topicId)
  assert.deepEqual(parseMemoryAssetsAddress(address, scope.ownerId), scope)
  assert.equal(parseMemoryAssetsAddress(address, 'owner-b'), undefined)
})

test('a first bound open finds the committed id after a void return and floats a large panel', () => {
  const f = fixture()
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope, { width: 1200, height: 900 }), true)
  assert.deepEqual(f.opened, [memoryAssetsAddress(scope.ownerId, scope.topicId)])
  assert.deepEqual(f.floated, [{ tabId: 'asset-1', rect: { x: 120, y: 90, width: 960, height: 720 } }])
})

test('reopening an existing resource preserves its current docking placement', () => {
  const f = fixture()
  openMemoryAssets(f.sidebar, f.origin, scope)
  openMemoryAssets(f.sidebar, f.origin, scope)
  assert.equal(f.opened.length, 2)
  assert.equal(f.floated.length, 1)
  assert.equal(f.sidebar.openTabs.getSnapshot().length, 1)
})

test('a restored resource is revealed without automatically floating again', () => {
  const f = fixture({ restored: true })
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), true)
  assert.equal(f.sidebar.openTabs.getSnapshot()[0].tabId, 'restored')
  assert.equal(f.floated.length, 0)
})

test('explicitly closed resources reopen as a new floating occurrence', () => {
  const f = fixture()
  openMemoryAssets(f.sidebar, f.origin, scope)
  f.closeAsset()
  openMemoryAssets(f.sidebar, f.origin, scope)
  assert.deepEqual(f.floated.map(row => row.tabId), ['asset-1', 'asset-2'])
})

test('a background body uses its bound open without floating on the foreground Session', () => {
  const f = fixture({ visible: false })
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), true)
  assert.equal(f.opened.length, 1)
  assert.equal(f.floated.length, 0)
})

test('a focus change during bound open prevents the global float from acting on another owner', () => {
  const f = fixture()
  const open = f.origin.tab.actions.openResource
  f.origin.tab.actions.openResource = (...args) => { open(...args); f.setMounted('owner-b') }
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), true)
  assert.equal(f.floated.length, 0)
})

test('cross-owner requests and closed tab occurrences cannot navigate', () => {
  const f = fixture()
  assert.equal(openMemoryAssets(f.sidebar, f.origin, { ...scope, ownerId: 'owner-b' }), false)
  f.abort.abort()
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), false)
  assert.equal(f.opened.length, 0)
  assert.equal(f.floated.length, 0)
})

test('no committed record means no guessed id or float after a void open', () => {
  const f = fixture({ commit: false })
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), false)
  assert.equal(f.floated.length, 0)
})

test('saved metadata for another owner cannot count as this owner’s existing resource', () => {
  const f = fixture()
  f.addOtherOwner()
  assert.equal(openMemoryAssets(f.sidebar, f.origin, scope), true)
  assert.deepEqual(f.floated.map(row => row.tabId), ['asset-1'])
})
