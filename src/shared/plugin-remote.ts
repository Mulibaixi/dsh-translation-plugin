import { LOCAL_DATA_REMOTE } from './local-data.js'
import { REFERENCE_REMOTE } from './reference-memory.js'
import { QUICK_TRANSLATION_REMOTE } from './quick-translation.js'
import { TOPIC_BRIDGE_REMOTE } from './topic-bridge.js'
import { OBJECT_ASSET_REMOTE } from './object-assets.js'
import { TRANSLATION_MATERIAL_REMOTE } from './translation-material-remote.js'
import { NORMAL_TRANSLATION_REMOTE } from './normal-translation.js'
import { NORMAL_TRANSLATION_V2_REMOTE } from './normal-translation-v2.js'
import { TRANSLATION_SOURCES_REMOTE } from './translation-sources.js'
import { TRANSLATION_SOURCE_STORAGE_REMOTE } from './translation-source-storage.js'
import { TRANSLATION_SOURCE_INTEGRITY_REMOTE } from './translation-source-integrity.js'
import { DOCUMENT_EXECUTION_REMOTE } from './document-execution.js'
import { DOCUMENT_REVIEW_REMOTE } from './document-review-bridge.js'

/** Typert owns one contribution per package/face; all namespaces share its lifetime. */
export const PLUGIN_REMOTE = {
  package: QUICK_TRANSLATION_REMOTE.package,
  descriptors: [...LOCAL_DATA_REMOTE.descriptors, ...REFERENCE_REMOTE.descriptors, ...QUICK_TRANSLATION_REMOTE.descriptors, ...TOPIC_BRIDGE_REMOTE.descriptors, ...OBJECT_ASSET_REMOTE.descriptors, ...TRANSLATION_MATERIAL_REMOTE.descriptors, ...NORMAL_TRANSLATION_REMOTE.descriptors, ...NORMAL_TRANSLATION_V2_REMOTE.descriptors, ...TRANSLATION_SOURCES_REMOTE.descriptors, ...TRANSLATION_SOURCE_STORAGE_REMOTE.descriptors, ...TRANSLATION_SOURCE_INTEGRITY_REMOTE.descriptors, ...DOCUMENT_EXECUTION_REMOTE.descriptors, ...DOCUMENT_REVIEW_REMOTE.descriptors],
}
