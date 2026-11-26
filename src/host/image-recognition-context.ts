const imageRegion = /气泡|对白|对话|旁白|拟声词|页[眉脚边]|顶[部栏]|底[部栏]|[上下左右]方|边[栏框]|标题|水印|注音|振假名|原文|文字|第[一二三四五六七八九十0-9]+[格栏列]|\b(?:balloons?|bubbles?|dialogue|captions?|narration|sound effects?|sfx|panels?|top|bottom|margins?|headings?|titles?|footers?|headers?|watermarks?|ruby|furigana|text)\b/iu
const transcriptionAction = /(?:识读|识别|提取|转写|转录|抄录|只读|仅读|读取)|\b(?:OCR|transcribe|extract|omit|exclude|skip|ignore|read only|only read)\b/iu
const scopeAction = /(?:只|仅|无需|不用|不要|不必)(?:需|需要)?(?:翻译|翻(?![嵌成])|译(?!成))|忽略|略过|跳过|排除|不读|不包含|\b(?:(?:only|never|do not|don't)\s+translate|translate\s+only)\b/iu
const explicitScope = /^(?:识读范围|转写范围|transcription scope|OCR scope)\s*[:：]\s*\S/iu
const speakerMapping = /^(?:人物对应|角色对应|说话人对应|character mapping|speaker mapping)\s*[:：]|(?:丸子头|麻花辫|直发|卷发|[长短黑白金红]发|(?:左|右)(?:侧|边)(?:的人物|的人|角色)?|穿[^，,]{1,15}的)[^，,]{0,10}(?:是|叫|对应)[^，,]+|\b(?:hair|person|character|speaker|on the (?:left|right))\b[^,]{0,45}\b(?:is|belongs to|matches)\s+\S/iu

/** Select explicit source-facing instructions from a request shared with translation. */
export function imageRecognitionContext(requirements: string): {
  readonly transcriptionScope?: string
  readonly characterClues?: string
} {
  const scopes: string[] = [], characters: string[] = []
  // Keep OCR clauses separate from adjacent instructions about the resulting translation.
  for (const part of requirements.split(/[\r\n。；;!?！？,，]+|(?<=[a-z]{3}\.)[ \t]+|(?<=\S)\s+and\s+(?=(?:use|write|make|render|keep|express)\b)|(?:并且|并|同时)(?=(?:使用|用词|用|表达|译文|让|保持))/iu)) {
    const clause = part.trim()
    if (speakerMapping.test(clause)) characters.push(clause)
    else if (explicitScope.test(clause) || imageRegion.test(clause) && (transcriptionAction.test(clause) || scopeAction.test(clause))) {
      scopes.push(clause.replace(/翻译|(?<=[只仅不])翻(?![嵌成])|(?<=[只仅不])译(?!成)|\btranslate\b/giu, word => /[a-z]/iu.test(word) ? 'transcribe' : '转写'))
    }
  }
  return { ...(scopes.length ? { transcriptionScope: scopes.join('\n') } : {}),
    ...(characters.length ? { characterClues: characters.join('\n') } : {}) }
}
