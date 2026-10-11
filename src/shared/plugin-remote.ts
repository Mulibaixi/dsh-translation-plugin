import { QUICK_TRANSLATION_REMOTE } from './quick-translation.js'
import { TOPIC_BRIDGE_REMOTE } from './topic-bridge.js'
import { OBJECT_ASSET_REMOTE } from './object-assets.js'
import { TRANSLATION_MATERIAL_REMOTE } from './translation-material-remote.js'
import { NORMAL_TRANSLATION_REMOTE } from './normal-translation.js'
import { NORMAL_TRANSLATION_V2_REMOTE } from './normal-translation-v2.js'
import { TRANSLATION_SOURCES_REMOTE } from './translation-sources.js'

/** Typert owns one contribution per package/face; all namespaces share its lifetime. */
export const PLUGIN_REMOTE = {
  package: QUICK_TRANSLATION_REMOTE.package,
  descriptors: [...QUICK_TRANSLATION_REMOTE.descriptors, ...TOPIC_BRIDGE_REMOTE.descriptors, ...OBJECT_ASSET_REMOTE.descriptors, ...TRANSLATION_MATERIAL_REMOTE.descriptors, ...NORMAL_TRANSLATION_REMOTE.descriptors, ...NORMAL_TRANSLATION_V2_REMOTE.descriptors, ...TRANSLATION_SOURCES_REMOTE.descriptors],
}
