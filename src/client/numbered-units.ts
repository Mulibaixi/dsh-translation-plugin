import { isFileJobUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import { currentFinalRevision, currentDocumentFinalRevision, isTextUnit, type TranslationUnit } from './translation-history.js'
import { parseUnitRequest, type NumberedUnit, type UnitContent, type UnitDirectory, type UnitReadRequest } from '../shared/numbered-units.js'
import type { FileHistoryClient } from './file-history.js'
import { parseHistoryTextRead, parseHistoryTextPage, HISTORY_TEXT_PAGE_POINTS, type HistoryTextPage } from '../shared/history-text.js'

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
/** The existing open set is the content scope; numbers resolve to immutable unit identities. */
export class NumberedUnits {
  constructor(private readonly sessions: SessionStore, private readonly files: () => FileHistoryClient | undefined) {}
  private session(main: string, id?: string) {
    const session = id ? this.sessions.getSession(id) : this.sessions.getActiveSession(main)
    if (!session || !this.sessions.isSessionOpen(main, session.id) || this.sessions.isSessionDeleted(session.id)) fail('session_not_open', '请先在当前主会话侧栏打开并选中翻译会话，或指定已打开的会话。')
    if (this.sessions.getStatus(session.id) === 'conflict') fail('history_conflict', '当前会话记录有冲突，请先核对。')
    return session
  }
  private summary(main: string, sessionId: string, unit: TranslationUnit): NumberedUnit {
    const target = { kind: 'unit' as const, mainSessionId: main, translationSessionId: sessionId, unitId: unit.id, sourceVersion: unit.sourceVersion }
    const text = isTextUnit(unit)
    const file = !text ? this.files()?.numberedVersions(target) : undefined
    if (isFileJobUnit(unit)) return { target, number: unit.order, kind: 'file', status: unit.deletion ? 'deleted' : file?.status ?? 'missing', versions: file?.versions ?? [], finalVersion: file?.finalVersion ?? null }
    const final = text ? currentFinalRevision(unit) : currentDocumentFinalRevision(unit)
    return { target: { kind: 'unit', mainSessionId: main, translationSessionId: sessionId, unitId: unit.id, sourceVersion: unit.sourceVersion },
      number: unit.order, kind: text ? 'text' : 'file', status: unit.deletion ? 'deleted' : text ? unit.revisions.at(-1)?.status ?? 'no_result' : file?.status ?? unit.tasks.at(-1)?.status ?? 'no_result',
      versions: text ? unit.revisions.filter(revision => revision.status !== 'deleted').map(revision => revision.order) : file?.versions ?? unit.revisions.map((_, index) => index + 1),
      finalVersion: text ? currentFinalRevision(unit)?.order ?? null : file?.finalVersion ?? (final ? unit.revisions.findIndex(revision => revision.id === final.id) + 1 : null),
      ...(final && unit.final ? { finalSelection: unit.final.selection } : {}) }
  }
  list(main: string, raw: unknown): UnitDirectory {
    const request = parseUnitRequest(raw, false), session = this.session(main, request.translationSessionId)
    this.files()?.ensureUnitNumbers(session.id)
    const units = this.sessions.getTranslationHistory(session.id)?.units ?? [], offset = request.offset ?? 0, limit = request.limit ?? 50
    return { translationSessionId: session.id, items: units.slice(offset, offset + limit).map(unit => this.summary(main, session.id, unit)), nextOffset: offset + limit < units.length ? offset + limit : null }
  }
  /** Historical reading never supplies a current target for a write or retranslation. */
  readHistory(main: string, raw: unknown): HistoryTextPage {
    const request = parseHistoryTextRead(raw), session = this.session(main, request.translationSessionId)
    const unit = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === request.unitId)
    if (!unit || unit.deletion || !this.sessions.canAccessUnit(main, session.id, unit.id)) fail('unit_not_found', '此历史单元不存在、已删除或不可访问。')
    if (!isTextUnit(unit)) fail('unsupported_history_unit', '此历史读取入口仅支持普通翻译文本及文件正文单元。')
    const source = unit.sourceVersions.find(source => source.version === request.sourceVersion)
    if (!source) fail('source_not_found', '此准确原文版本不存在或已删除。')
    const revision = request.side === 'translation' ? unit.revisions.find(revision => revision.id === request.revisionId) : undefined
    if (request.side === 'translation' && (!revision || revision.status === 'deleted' || revision.sourceVersion !== request.sourceVersion)) fail('revision_not_found', '此准确译文版本不存在、已删除或不属于指定原文。')
    if (request.side === 'translation' && revision!.status !== 'completed') fail('revision_incomplete', '此译文版本尚未完整完成，不能按固定历史正文读取。')
    const points = Array.from(request.side === 'source' ? source.text : revision!.text), start = request.start ?? 0
    if (start > points.length) fail('range_out_of_bounds', `此历史正文共 ${points.length} 码点，读取起点超出范围。`)
    const end = Math.min(points.length, start + HISTORY_TEXT_PAGE_POINTS)
    const page = parseHistoryTextPage({ ...request, start, text: points.slice(start, end).join(''), totalCodePoints: points.length, nextStart: end < points.length ? end : null })
    if (!this.sessions.canAccessUnit(main, session.id, unit.id) || this.sessions.getTranslationHistory(session.id)?.units.find(current => current.id === unit.id) !== unit) fail('content_changed', '读取期间会话已关闭或历史单元发生变化，请重新读取准确版本。')
    return page
  }
  async read(main: string, raw: unknown): Promise<readonly UnitContent[]> {
    const request = parseUnitRequest(raw, true), session = this.session(main, request.translationSessionId)
    this.files()?.ensureUnitNumbers(session.id)
    // Capture all targets before the first await; switching the sidebar cannot redirect this read.
    const units = request.unitNumbers.map(number => {
      const unit = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.order === number)
      if (!unit) fail('unit_not_found', `单元 ${number} 不存在。`)
      if (unit.deletion) fail('unit_deleted', `单元 ${number} 已删除，编号保留。`)
      if (request.sourceVersion !== undefined && unit.sourceVersion !== request.sourceVersion) fail('stale_source_version', `单元 ${number} 原文版本已变化，请重新读取目录。`)
      return unit
    })
    const pages: UnitContent[] = []
    for (const unit of units) {
      const info = this.summary(main, session.id, unit), side = request.side ?? 'translation', start = request.start ?? 0
      if (isTextUnit(unit)) {
        const revision = request.revisionNumber === undefined ? currentFinalRevision(unit) : unit.revisions.find(revision => revision.order === request.revisionNumber)
        if (side === 'translation' && (!revision || revision.status === 'deleted')) {
          pages.push({ unit: info, side, revisionNumber: request.revisionNumber ?? null, text: null, totalCodePoints: 0, start, nextStart: null, message: request.revisionNumber ? '此译文版本不存在或已删除。' : '当前没有有效定稿，可指定目录中的译文版本。' }); continue
        }
        const points = Array.from(side === 'source' ? unit.source : revision!.text)
        if (start > points.length) fail('range_out_of_bounds', `单元 ${unit.order} 内容共 ${points.length} 码点，读取起点超出范围。`)
        const end = Math.min(points.length, start + 4000)
        pages.push({ unit: info, side, revisionNumber: side === 'source' ? null : revision!.order, text: points.slice(start, end).join(''), totalCodePoints: points.length, start, nextStart: end < points.length ? end : null })
      } else {
        const files = this.files(); if (!files) fail('file_history_unavailable', '文件历史服务尚未就绪。')
        pages.push({ unit: info, side, ...await files.readNumbered(info.target, request) })
      }
      if (!this.sessions.canAccessUnit(main, session.id, unit.id) || this.sessions.getTranslationHistory(session.id)?.units.find(current => current.id === unit.id) !== unit) fail('content_changed', '读取期间会话已关闭或单元发生变化，请重新读取准确目标。')
    }
    return pages
  }
}
