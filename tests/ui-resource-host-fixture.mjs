import assert from 'node:assert/strict'

// Host inventory and independent keyed bodies, using the existing light renderer.
// This is a tab/float contract fixture, not a desktop DOM or visual window test.
export function createResourceHost(react, renderer) {
  const slots = new Map(), definitions = new Map(), resources = new Map(), workspaces = new Map(), floats = []
  let owner, activeResource, nextTab = 0
  const slotKey = target => `${target.name}:${target.key ?? target.id ?? ''}`
  function closeResource(id) { resources.get(id)?.controller.abort(); resources.delete(id); if (activeResource === id) activeResource = undefined }
  function openResource(address, sessionId, options) {
    const definition = [...definitions.values()].find(definition => definition.canOpen?.(address)); assert.ok(definition, 'resource has a registered tab type')
    let resource = [...resources.values()].find(resource => resource.sessionId === sessionId && resource.contentId === address)
    if (!resource) {
      resource = { tabId: `synthetic-resource-${++nextTab}`, sessionId, kind: definition.kind, contentId: address, definitionId: definition.id, controller: new AbortController() }
      resources.set(resource.tabId, resource)
    }
    resource.params = options?.params
    activeResource = resource.tabId
    return resource
  }
  function tabInfo(id, sessionId, address, visible, controller, close, params) {
    return { tab: { id, contentId: address, visible, signal: controller.signal, navigation: { address, params, revision: 0 },
      actions: { openResource: (address, options) => { openResource(address, sessionId, options) }, openTab() {}, close, bindCommands() { return () => {} } } } }
  }
  function HostedWorkspace(props = {}) {
    if (owner !== props.sessionId) activeResource = undefined
    owner = props.sessionId
    if (!workspaces.has(owner)) workspaces.set(owner, new AbortController())
    const workspace = slots.get('sidebar.right.pane.tab:dsh-translation-plugin'); assert.ok(workspace)
    return react.createElement('div', { className: 'synthetic-resource-host' },
      react.createElement('div', { hidden: activeResource !== undefined }, react.createElement(workspace, { ...props,
        useTabInfo: () => tabInfo(`workspace:${owner}`, owner, 'translation-workspace', activeResource === undefined, workspaces.get(owner), () => {}) })),
      ...[...resources.values()].map(resource => {
        const props = { sessionId: resource.sessionId,
          useTabInfo: () => tabInfo(resource.tabId, resource.sessionId, resource.contentId, activeResource === resource.tabId, resource.controller, () => closeResource(resource.tabId), resource.params) }
        const title = slots.get(`sidebar.right.pane.tab.title:${resource.definitionId}`)
        return react.createElement('div', { key: resource.tabId, hidden: activeResource !== resource.tabId },
          title ? react.createElement('header', { 'data-synthetic-host-caption': true }, react.createElement(title, { ...props, key: `title:${resource.tabId}` })) : null,
          react.createElement(slots.get(`sidebar.right.pane.tab:${resource.definitionId}`), { ...props, key: resource.tabId }))
      }))
  }
  const sidebarRight = {
    openTabs: { getSnapshot: () => [...resources.values()].map(({ sessionId, tabId, kind, contentId }) => ({ sessionId, tabId, kind, contentId })) },
    mounted: { getSnapshot: () => owner },
    float(tabId, rect) { assert.ok(resources.has(tabId)); floats.push({ tabId, rect }) },
  }
  renderer.showTranslation = () => { activeResource = undefined; renderer.render() }
  return {
    slots: { register(target, component) { const key = slotKey(target); assert.ok(!slots.has(key), 'keyed body cannot overwrite another contribution'); slots.set(key, component); return () => slots.delete(key) },
      inject(_name, register) { return register() } },
    sidebarRightTabs: { register(definition) { assert.ok(!definitions.has(definition.id)); definitions.set(definition.id, definition); return () => definitions.delete(definition.id) } },
    sidebarRight, floats, definitions, registrations: slots,
    panel: HostedWorkspace,
    get settingsPage() { return slots.get('settings.section:dsh-translation-plugin') },
    get activeResource() { return activeResource ? resources.get(activeResource) : undefined },
    restoreResource(sessionId, address) { const resource = openResource(address, sessionId); renderer.render(); return resource },
    // Simulate the host caption close action, outside the resource Body.
    closeAssetCaption() { if (activeResource) closeResource(activeResource); renderer.render() },
    showTranslation: renderer.showTranslation,
  }
}
