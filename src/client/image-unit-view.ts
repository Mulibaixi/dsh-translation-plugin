import { imageFileFormat, imageLetteringPrompt } from '../shared/image-translation.js'
import type { ImageUnit, TextRevision } from './translation-history.js'
import type { LocalSession } from './sessions.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { NormalTranslationClient } from './normal-translation.js'
import { SourceTextEditor } from './source-text-editor.js'
import { h, react } from './react.js'
import { IconChevronRightOutlineRegular, Menu, MenuItemButton } from './native-ui.js'
import { saveExport } from './browser-download.js'
import { imageLetteringArchive, readImageSize, renderTextImage } from './image-export.js'

interface ImageViewProps {
  readonly unit: ImageUnit
  readonly session: LocalSession
  readonly materials?: MaterialSubmissionsClient | undefined
  readonly viewFiles?: ViewFilesClient | undefined
}

export function ImageOriginalButton({ unit, session, materials, viewFiles }: ImageViewProps): unknown {
  const [busy, setBusy] = react.useState(false)
  const [notice, setNotice] = react.useState('')
  const [preview, setPreview] = react.useState('')
  const opening = react.useRef(false)
  const mounted = react.useRef(true)
  react.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  react.useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const original = unit.original
  async function open(): Promise<void> {
    if (opening.current || !original || !materials || !viewFiles) return
    opening.current = true
    setBusy(true)
    setNotice('')
    try {
      const snapshot = await materials.resolveFileSource(session.id, unit.id)
      if (!mounted.current) return
      if (!snapshot) throw new Error('原图暂不可打开。')
      if (snapshot.savedSource || snapshot.librarySource) {
        const result = await viewFiles.openSource({ namespaceId: viewFiles.getNamespaceId(), sessionId: session.id, unitId: unit.id,
          kind: 'source', title: original.name, fileName: original.name }, snapshot)
        if (result.ok || !mounted.current) return
      }
      const bytes = await viewFiles.readImageOriginal(snapshot, original)
      const format = imageFileFormat(original.name)
      if (mounted.current) setPreview(URL.createObjectURL(new Blob([bytes], { type: format === 'jpg' ? 'image/jpeg' : `image/${format}` })))
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : '原图打开失败。') }
    finally { opening.current = false; if (mounted.current) setBusy(false) }
  }
  return h('div', null,
    h('button', { type: 'button', title: original?.name, disabled: busy || !original || !materials || !viewFiles, onClick: () => { void open() } }, busy ? '正在打开…' : '打开原图'),
    notice ? h('small', { role: 'alert' }, notice) : null,
    preview ? h('div', { className: 'dsh-tp-dialog', role: 'dialog', 'aria-label': '原图预览' },
      h('button', { type: 'button', onClick: () => setPreview('') }, '关闭'),
      h('img', { src: preview, alt: original?.name ?? '原图', style: { display: 'block', maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain' } })) : null)
}

export function ImageBackground({ unit, session, normal }: ImageViewProps & { readonly normal?: NormalTranslationClient | undefined }): unknown {
  const [editing, setEditing] = react.useState(false)
  const blocked = normal?.sourceEditBlockedReason(session.id, unit.id)
  return h('details', { className: 'dsh-tp-muted dsh-tp-image-background' },
    h('summary', null, '画面背景'),
    !editing && normal && session.archivedAt === null ? h('button', {
      type: 'button', className: 'dsh-tp-image-background-edit', disabled: !!blocked, title: blocked, onClick: () => setEditing(true),
    }, '编辑背景') : null,
    editing && normal ? h(SourceTextEditor, { unit, session, normal, field: 'background', close: () => setEditing(false) }) :
      h('div', { className: 'dsh-tp-translation-text' }, unit.backgroundDescription || '暂无背景描述'))
}

export function ImageExportMenu({ unit, session, revision, materials, viewFiles }: ImageViewProps & { readonly revision: TextRevision }): unknown {
  const [menu, setMenu] = react.useState<'exports' | 'text-image' | null>(null)
  const [busy, setBusy] = react.useState(false)
  const saving = react.useRef(false)
  const [notice, setNotice] = react.useState('')
  const original = unit.original, format = original && imageFileFormat(original.name)
  const name = original?.name.replace(/\.[^.]+$/u, '').slice(0, 160).replace(/[. ]+$/u, '') || `图片-${unit.order}`
  async function readOriginal() {
    if (!original || !format || !materials || !viewFiles) throw new Error('原图暂不可读取。')
    const snapshot = await materials.resolveFileSource(session.id, unit.id)
    if (!snapshot) throw new Error('原图暂不可读取。')
    return { format, bytes: await viewFiles.readImageOriginal(snapshot, original) }
  }
  async function makePrompt(bytes?: Uint8Array<ArrayBuffer>): Promise<string> {
    return imageLetteringPrompt(unit.source, revision.text, bytes && await readImageSize(bytes))
  }
  async function save(kind: 'translation' | 'bilingual' | 'prompt' | 'package'): Promise<void> {
    if (saving.current || revision.status !== 'completed' || !revision.text.trim()) return
    saving.current = true
    setMenu(null)
    setBusy(true)
    setNotice('')
    try {
      const fileName = `${name}-v${revision.order}-${kind === 'prompt' ? '翻嵌提示词.txt' : kind === 'package' ? '翻嵌素材包.zip' : kind === 'bilingual' ? '双语.png' : '译文.png'}`
      const mimeType = kind === 'prompt' ? 'text/plain;charset=utf-8' : kind === 'package' ? 'application/zip' : 'image/png'
      const result = await saveExport({ fileName, mimeType,
        content: async () => {
          if (kind === 'prompt') {
            const image = await readOriginal().catch(() => undefined)
            return new Blob([await makePrompt(image?.bytes)], { type: mimeType })
          }
          if (kind === 'package') {
            const { format, bytes } = await readOriginal()
            return imageLetteringArchive(format, bytes, await makePrompt(bytes))
          }
          return renderTextImage([
            ...(kind === 'bilingual' ? [{ label: '原文', text: unit.source }] : []),
            { label: '译文', text: revision.text },
          ])
        },
      })
      if (result !== 'cancelled') setNotice(result === 'saved' ? '文件已保存。' : `已发起下载：${fileName}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : '导出失败。') }
    finally { saving.current = false; setBusy(false) }
  }
  if (revision.status === 'deleted') return null
  const rows = menu === 'text-image' ? [
    h(MenuItemButton, { onSelect: () => setMenu('exports') }, '返回'),
    h(MenuItemButton, { separatorBefore: true, onSelect: () => { void save('translation') } }, '译文'),
    h(MenuItemButton, { disabled: !unit.source.trim(), onSelect: () => { void save('bilingual') } }, '双语'),
  ] : [
    h(MenuItemButton, { onSelect: () => setMenu('text-image') },
      h('span', { className: 'dsh-tp-submenu-label' }, '导出文字图片……', h(IconChevronRightOutlineRegular, { size: 14 }))),
    h(MenuItemButton, { disabled: !unit.source.trim(), onSelect: () => { void save('prompt') } }, '导出翻嵌提示词……'),
    h(MenuItemButton, { disabled: !unit.source.trim() || !format || !materials || !viewFiles, onSelect: () => { void save('package') } }, '导出翻嵌素材包……'),
  ]
  return h('div', null,
    h(Menu, {
      open: menu !== null, onClose: () => setMenu(null), portal: true, align: 'end', compact: true, listClassName: 'dsh-tp-popup',
      anchor: h('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': menu !== null, disabled: busy || revision.status !== 'completed' || !revision.text.trim(),
        onClick: () => setMenu(current => current ? null : 'exports') }, busy ? '正在导出…' : '导出'),
    }, ...rows),
    notice ? h('small', { role: 'status' }, notice) : null)
}
