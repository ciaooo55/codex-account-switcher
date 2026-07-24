export const CUSTOM_API_CATALOG_LIMIT = 500
export const CUSTOM_API_MODEL_ID_LIMIT = 128

export interface ParsedCustomApiModels {
  models: string[]
  duplicateCount: number
}

export interface CustomApiCatalogStatus {
  kind: 'info' | 'ready' | 'error'
  message: string
  valid: boolean
}

/**
 * Turns the line-oriented editor into the exact ordered model set sent over IPC.
 * Empty lines and duplicate IDs are not meaningful catalog entries, so they are
 * omitted and reported to the user instead of being silently counted.
 */
export function parseCustomApiModels(text: string): ParsedCustomApiModels {
  const seen = new Set<string>()
  const models: string[] = []
  let duplicateCount = 0

  for (const line of text.split(/\r?\n/)) {
    const model = line.trim()
    if (!model) continue
    if (seen.has(model)) {
      duplicateCount += 1
      continue
    }
    seen.add(model)
    models.push(model)
  }

  return { models, duplicateCount }
}

export function customApiCatalogStatus(input: {
  models: readonly string[]
  selectedModel: string
  syncModelCatalog: boolean
  duplicateCount?: number
}): CustomApiCatalogStatus {
  const { models, syncModelCatalog, duplicateCount = 0 } = input
  const selectedModel = input.selectedModel.trim()

  if (!syncModelCatalog) {
    return {
      kind: 'info',
      message: '不会写入托管模型目录；下方内容仅保留在本次编辑中。',
      valid: true
    }
  }

  if (models.length === 0) {
    return {
      kind: 'error',
      message: '模型目录为空。请至少填写一个模型，或关闭“精确导入模型目录”。',
      valid: false
    }
  }

  if (models.length > CUSTOM_API_CATALOG_LIMIT) {
    return {
      kind: 'error',
      message: `模型目录最多支持 ${CUSTOM_API_CATALOG_LIMIT} 个唯一模型，当前为 ${models.length} 个。`,
      valid: false
    }
  }

  const oversizedModel = models.find((model) => model.length > CUSTOM_API_MODEL_ID_LIMIT)
  if (oversizedModel) {
    return {
      kind: 'error',
      message: `模型 ID 最多 ${CUSTOM_API_MODEL_ID_LIMIT} 个字符：“${oversizedModel.slice(0, 32)}${oversizedModel.length > 32 ? '…' : ''}”。`,
      valid: false
    }
  }

  if (!selectedModel) {
    return {
      kind: 'error',
      message: '请从这份目录中选择一个 Codex 默认模型。',
      valid: false
    }
  }

  if (!models.includes(selectedModel)) {
    return {
      kind: 'error',
      message: `默认模型“${selectedModel}”不在目录中。请选择目录中的模型，或明确将它加入目录。`,
      valid: false
    }
  }

  const duplicateNote = duplicateCount > 0 ? `；已忽略 ${duplicateCount} 个重复行` : ''
  return {
    kind: 'ready',
    message: `将精确写入 ${models.length} 个模型${duplicateNote}；不会自动补入默认模型或上游其他模型。`,
    valid: true
  }
}

