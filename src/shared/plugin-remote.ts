import { QUICK_TRANSLATION_REMOTE } from './quick-translation.js'
import { TOPIC_BRIDGE_REMOTE } from './topic-bridge.js'

/** Typert owns one contribution per package/face; both namespaces share its lifetime. */
export const PLUGIN_REMOTE = {
  package: QUICK_TRANSLATION_REMOTE.package,
  descriptors: [...QUICK_TRANSLATION_REMOTE.descriptors, ...TOPIC_BRIDGE_REMOTE.descriptors],
}
