import { describe, expect, it } from 'vitest'
import {
  CUSTOM_API_CATALOG_LIMIT,
  customApiCatalogStatus,
  parseCustomApiModels
} from './custom-api-form'

describe('custom API model form semantics', () => {
  it('preserves order while trimming empty lines and reporting duplicates', () => {
    expect(parseCustomApiModels(' model-a\n\nmodel-b\r\nmodel-a\nMODEL-A ')).toEqual({
      models: ['model-a', 'model-b', 'MODEL-A'],
      duplicateCount: 1
    })
  })

  it('requires the selected model to be explicitly present in an imported catalog', () => {
    expect(customApiCatalogStatus({
      models: ['model-a', 'model-b'],
      selectedModel: 'model-c',
      syncModelCatalog: true
    })).toMatchObject({
      kind: 'error',
      valid: false,
      message: expect.stringContaining('不在目录中')
    })
  })

  it('reports the exact unique count and never promises an implicit selected model', () => {
    expect(customApiCatalogStatus({
      models: ['model-a', 'model-b'],
      selectedModel: 'model-a',
      syncModelCatalog: true,
      duplicateCount: 2
    })).toEqual({
      kind: 'ready',
      valid: true,
      message: '将精确写入 2 个模型；已忽略 2 个重复行；不会自动补入默认模型或上游其他模型。'
    })
  })

  it('explains the catalog limit before IPC validation can return a generic count error', () => {
    const models = Array.from({ length: CUSTOM_API_CATALOG_LIMIT + 1 }, (_, index) => `model-${index}`)
    expect(customApiCatalogStatus({
      models,
      selectedModel: models[0],
      syncModelCatalog: true
    })).toEqual({
      kind: 'error',
      valid: false,
      message: `模型目录最多支持 ${CUSTOM_API_CATALOG_LIMIT} 个唯一模型，当前为 ${CUSTOM_API_CATALOG_LIMIT + 1} 个。`
    })
  })

  it('does not require a catalog when exact import is disabled', () => {
    expect(customApiCatalogStatus({
      models: [],
      selectedModel: 'manual-model',
      syncModelCatalog: false
    })).toMatchObject({ kind: 'info', valid: true })
  })
})
