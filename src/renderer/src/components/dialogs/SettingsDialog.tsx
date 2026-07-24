import {
  CheckCircle2,
  Download,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  X
} from 'lucide-react'
import { useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { AppSnapshot, UpdateState } from '../../../../shared/ipc'
import type { AppSettings } from '../../../../shared/types'
import type { RequestConfirmation } from '../../hooks/useConfirmation'
import { Button, DialogActions, DialogBackdrop, DialogHeader, DialogPanel } from '@/components/ui'
import { customApiCatalogStatus, parseCustomApiModels } from '@/lib/custom-api-form'
import { parseCustomApiPaste } from '../../../../shared/custom-api'
import { codexApi } from '../../services/codexApi'

export type SettingsDialogProps = {
  open: boolean
  snapshot: AppSnapshot
  settingsDraft: AppSettings
  setSettingsDraft: Dispatch<SetStateAction<AppSettings | null>>
  settingsDialogRef: RefObject<HTMLElement | null>
  busy: boolean
  customApiKey: string
  setCustomApiKey: (value: string) => void
  customApiModels: string[]
  setCustomApiModels: Dispatch<SetStateAction<string[]>>
  customApiModelsText: string
  setCustomApiModelsText: (value: string) => void
  customApiSyncCatalog: boolean
  setCustomApiSyncCatalog: (value: boolean) => void
  customApiModelsNote: string
  setCustomApiModelsNote: (value: string) => void
  updateState: UpdateState | null
  closeSettingsDialog: (saved?: boolean) => void
  run(action: () => Promise<unknown>, success?: string, reloadAfter?: boolean): unknown
  requestConfirmation: RequestConfirmation
  reload: () => Promise<void>
  setMessage: Dispatch<SetStateAction<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>>
  downloadUpdate: () => Promise<void> | void
  installUpdate: () => Promise<void> | void
  checkForUpdates: () => Promise<void> | void
}

export function SettingsDialog({
  open,
  snapshot,
  settingsDraft,
  setSettingsDraft,
  settingsDialogRef,
  busy,
  customApiKey,
  setCustomApiKey,
  customApiModels,
  setCustomApiModels,
  customApiModelsText,
  setCustomApiModelsText,
  customApiSyncCatalog,
  setCustomApiSyncCatalog,
  customApiModelsNote,
  setCustomApiModelsNote,
  updateState,
  closeSettingsDialog,
  run,
  requestConfirmation,
  reload,
  setMessage,
  downloadUpdate,
  installUpdate,
  checkForUpdates
}: SettingsDialogProps): React.JSX.Element | null {
  const [pasteText, setPasteText] = useState('')
  const [pasteNote, setPasteNote] = useState('')
  if (!open) return null

  const parsedModels = parseCustomApiModels(customApiModelsText)
  const catalogStatus = customApiCatalogStatus({
    models: customApiModels,
    selectedModel: settingsDraft.customApiModel,
    syncModelCatalog: customApiSyncCatalog,
    duplicateCount: parsedModels.duplicateCount
  })
  const hasUsableKey = snapshot.customApi.hasApiKey || Boolean(customApiKey.trim())
  const hasBaseUrl = Boolean(settingsDraft.customApiBaseUrl.trim())
  const hasSelectedModel = Boolean(settingsDraft.customApiModel.trim())
  const canSwitchCustomApi = !busy && hasUsableKey && hasBaseUrl && hasSelectedModel && catalogStatus.valid

  const replaceEditedModels = (models: string[]): void => {
    const normalized = parseCustomApiModels(models.join('\n')).models
    setCustomApiModels(normalized)
    setCustomApiModelsText(normalized.join('\n'))
  }

  const addSelectedModelToCatalog = (): void => {
    const selectedModel = settingsDraft.customApiModel.trim()
    if (!selectedModel || customApiModels.includes(selectedModel)) return
    replaceEditedModels([...customApiModels, selectedModel])
    setCustomApiModelsNote(`已明确将默认模型“${selectedModel}”加入编辑目录`)
  }

  return (
        <DialogBackdrop className="modal-backdrop">
          <DialogPanel ref={settingsDialogRef} className="settings-panel max-w-[760px]" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
            <DialogHeader className="panel-header flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3"><h2 className="text-[15px] font-semibold text-[var(--color-text)]">设置</h2><Button variant="ghost" size="icon" title="关闭" aria-label="关闭设置" onClick={() => closeSettingsDialog()} disabled={busy}><X size={18} /></Button></DialogHeader>
            <label>aa 托管凭证库<input aria-label="应用凭证库" value={snapshot.importDirectory} readOnly /></label>
            <label>导入文件默认目录<div className="path-input"><input value={settingsDraft.accountDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, accountDirectory: event.target.value })} /><Button title="选择目录" onClick={async () => { const path = await codexApi().chooseAccountDirectory(); if (path) setSettingsDraft({ ...settingsDraft, accountDirectory: path }) }}><FolderOpen size={17} /></Button></div></label>
            <label>CPA 共享账号目录（Codex + Grok）<div className="path-input"><input value={settingsDraft.grokDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, grokDirectory: event.target.value })} /><Button title="选择 CPA 共享目录" onClick={async () => { const path = await codexApi().chooseGrokDirectory(); if (path) setSettingsDraft({ ...settingsDraft, grokDirectory: path }) }}><FolderOpen size={17} /></Button></div></label>
            <label>auth.json 路径<input value={settingsDraft.authPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, authPath: event.target.value })} /></label>
            <label>config.toml 路径<input value={settingsDraft.configPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, configPath: event.target.value })} /></label>
            <div className="settings-grid">
              <label>并发数<input aria-label="并发数" type="number" min={1} max={12} value={settingsDraft.concurrency} onChange={(event) => setSettingsDraft({ ...settingsDraft, concurrency: Number(event.target.value) })} /></label>
              <label>超时（毫秒）<input type="number" min={1000} value={settingsDraft.timeoutMs} onChange={(event) => setSettingsDraft({ ...settingsDraft, timeoutMs: Number(event.target.value) })} /></label>
              <label>备份保留数<input type="number" min={1} value={settingsDraft.backupRetention} onChange={(event) => setSettingsDraft({ ...settingsDraft, backupRetention: Number(event.target.value) })} /></label>
              <label>深度检测模型<input value={settingsDraft.deepTestModel} onChange={(event) => setSettingsDraft({ ...settingsDraft, deepTestModel: event.target.value })} /></label>
            </div>
            <section className="custom-api-panel space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3" aria-label="自定义 API">
              <div className="section-heading">
                <div><strong>自定义 API</strong><span>可从上游获取模型后逐行增删，并选择是否导入 Codex。保存前会真实发送 hi，成功后由你决定是否修复会话并重启。应用保存的 Key 副本使用 DPAPI 加密，但 Codex 运行配置会按兼容格式写入明文 Key</span></div>
                <span className={`saved-secret ${snapshot.customApi.hasApiKey ? 'ready' : ''}`}>{snapshot.customApi.hasApiKey ? 'Key 已保存' : '未保存 Key'}</span>
              </div>
              <label>API 地址<input aria-describedby="custom-api-address-help" value={settingsDraft.customApiBaseUrl} onChange={(event) => {
                setSettingsDraft({ ...settingsDraft, customApiBaseUrl: event.target.value })
                setCustomApiModelsNote('API 地址已修改；现有编辑目录保持不变，请在切换前核对。')
              }} placeholder="https://api.example.com/v1 或完整 .../v1/responses" /></label>
              <p id="custom-api-address-help" className="custom-api-models-note">这里填写真实上游地址。获取模型时可能探测兼容路径，但不会用探测地址覆盖你的输入。</p>
              <div className="settings-grid">
                <label>模型
                  <input
                    list="custom-api-model-options"
                    value={settingsDraft.customApiModel}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, customApiModel: event.target.value })}
                    placeholder={customApiModels.length > 0 ? '从编辑后的目录选择，也可手动填写' : '必填：用于真实 hi 测试'}
                  />
                  <datalist id="custom-api-model-options">
                    {customApiModels.map((modelId) => (
                      <option key={modelId} value={modelId} />
                    ))}
                  </datalist>
                </label>
                <label>API Key<input type="password" value={customApiKey} onChange={(event) => setCustomApiKey(event.target.value)} placeholder={snapshot.customApi.hasApiKey ? '留空继续使用已保存 Key' : '输入 API Key'} autoComplete="new-password" /></label>
              </div>
              <details className="paste-recognizer rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
                <summary className="cursor-pointer select-none text-[13px] font-medium text-[var(--color-text)]">粘贴识别（URL / Key / Base64 / JSON）</summary>
                <div className="mt-2 space-y-2">
                  <textarea
                    aria-label="粘贴识别输入"
                    rows={3}
                    value={pasteText}
                    onChange={(event) => setPasteText(event.target.value)}
                    placeholder="可粘贴完整 URL + Key、url=...&key=...、JSON 或 Base64 数据；会自动解码并测试 /v1 与无后缀两种写法"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="secondary" disabled={busy || !pasteText.trim()} onClick={() => void run(async () => {
                      const parsed = parseCustomApiPaste(pasteText)
                      if (parsed.baseUrl) setSettingsDraft({ ...settingsDraft, customApiBaseUrl: parsed.baseUrl })
                      if (parsed.apiKey) setCustomApiKey(parsed.apiKey)
                      setPasteNote(parsed.note)
                      if (!parsed.baseUrl && !parsed.apiKey) throw new Error(parsed.note)
                    }, '已识别并填入字段', false)}>
                      识别并填入
                    </Button>
                    <Button type="button" variant="secondary" disabled={busy || (!settingsDraft.customApiBaseUrl.trim() && !pasteText.trim())} onClick={() => void run(async () => {
                      let baseUrl = settingsDraft.customApiBaseUrl.trim()
                      let apiKey = customApiKey.trim()
                      if (pasteText.trim()) {
                        const parsed = parseCustomApiPaste(pasteText)
                        if (parsed.baseUrl) { baseUrl = parsed.baseUrl; setSettingsDraft({ ...settingsDraft, customApiBaseUrl: parsed.baseUrl }) }
                        if (parsed.apiKey) { apiKey = parsed.apiKey; setCustomApiKey(parsed.apiKey) }
                        setPasteNote(parsed.note)
                      }
                      if (!baseUrl) throw new Error('未识别到 API 地址')
                      const listed = await codexApi().listCustomApiModels({ baseUrl, ...(apiKey ? { apiKey } : {}) })
                      setPasteNote(listed.message)
                      setCustomApiModelsNote(listed.message)
                      if (!listed.ok) throw new Error(listed.message)
                      const listedModels = parseCustomApiModels(listed.models.join('\n')).models
                      replaceEditedModels(listedModels)
                      if (listedModels.length > 0 && !settingsDraft.customApiModel.trim()) {
                        setSettingsDraft({ ...settingsDraft, customApiModel: listedModels[0] })
                        setPasteNote(`${listed.message}；默认模型已设为“${listedModels[0]}”`)
                      }
                    }, '已识别并获取模型列表', false)}>
                      识别并获取模型
                    </Button>
                    {pasteNote ? <span className="custom-api-models-note">{pasteNote}</span> : null}
                  </div>
                </div>
              </details>


              <label className="check-option"><input type="checkbox" checked={customApiSyncCatalog} onChange={(event) => setCustomApiSyncCatalog(event.target.checked)} />将下面目录作为 Codex 的完整模型列表（精确覆盖）</label>
              <label>Codex 模型目录（每行一个，顺序保留）
                <textarea
                  aria-label="同步到 Codex 的模型目录"
                  aria-describedby="custom-api-catalog-status"
                  aria-invalid={customApiSyncCatalog && !catalogStatus.valid}
                  rows={6}
                  value={customApiModelsText}
                  onChange={(event) => {
                    const text = event.target.value
                    const models = parseCustomApiModels(text).models
                    setCustomApiModelsText(text)
                    setCustomApiModels(models)
                    setCustomApiModelsNote('')
                  }}
                  placeholder={'model-a\nmodel-b\n只会导入这里明确列出的模型'}
                />
              </label>
              <div id="custom-api-catalog-status" className={`custom-api-catalog-status ${catalogStatus.kind}`} role={catalogStatus.kind === 'error' ? 'alert' : 'status'}>
                <span>{catalogStatus.message}</span>
                {customApiSyncCatalog && hasSelectedModel && !customApiModels.includes(settingsDraft.customApiModel.trim()) ? (
                  <Button type="button" size="sm" variant="secondary" onClick={addSelectedModelToCatalog}>将默认模型加入目录</Button>
                ) : null}
              </div>
              {customApiModelsNote ? <p className="custom-api-models-note" role="status">{customApiModelsNote}</p> : null}
              {customApiModels.length > 0 ? (
                <label>从编辑后的模型目录中选择
                  <select
                    value={customApiModels.includes(settingsDraft.customApiModel) ? settingsDraft.customApiModel : ''}
                    onChange={(event) => setSettingsDraft({ ...settingsDraft, customApiModel: event.target.value })}
                  >
                    <option value="">（使用上方填写的模型）</option>
                    {customApiModels.map((modelId) => (
                      <option key={modelId} value={modelId}>{modelId}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="custom-api-actions flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" disabled={busy || !settingsDraft.customApiBaseUrl.trim() || (!snapshot.customApi.hasApiKey && !customApiKey.trim())} onClick={() => void run(async () => {
                  const listed = await codexApi().listCustomApiModels({
                    baseUrl: settingsDraft.customApiBaseUrl,
                    ...(customApiKey.trim() ? { apiKey: customApiKey } : {})
                  })
                  setCustomApiModelsNote(listed.message)
                  if (!listed.ok) throw new Error(listed.message)
                  const listedModels = parseCustomApiModels(listed.models.join('\n')).models
                  replaceEditedModels(listedModels)
                  if (listedModels.length > 0 && !settingsDraft.customApiModel.trim()) {
                    setSettingsDraft({ ...settingsDraft, customApiModel: listedModels[0] })
                    setCustomApiModelsNote(`${listed.message}；默认模型已设为“${listedModels[0]}”`)
                  }
                }, '已获取自定义 API 模型列表', false)}>
                  从上游替换模型目录
                </Button>
                <Button variant="default" onClick={() => void (async () => {
                  if (!await requestConfirmation({
                    title: '测试并切换第三方 API',
                    message: `将使用“${settingsDraft.customApiModel.trim()}”真实测试 ${settingsDraft.customApiBaseUrl.trim()}；通过后写入 Codex。`,
                    detail: customApiSyncCatalog
                      ? `模型目录将精确覆盖为当前 ${customApiModels.length} 个条目，不会自动增加其他模型。测试失败不会修改配置。`
                      : '不会写入托管模型目录。测试失败不会修改配置；强制保存需要第二次确认。',
                    confirmLabel: '测试并保存',
                    tone: 'warning'
                  })) return
                  await run(async () => {
                    const profile = {
                      baseUrl: settingsDraft.customApiBaseUrl,
                      model: settingsDraft.customApiModel,
                      models: customApiModels,
                      syncModelCatalog: customApiSyncCatalog,
                      ...(customApiKey.trim() ? { apiKey: customApiKey } : {})
                    }
                    let result = await codexApi().switchToCustomApi(profile, true)
                    if (!result.ok && result.canForce) {
                      const force = await requestConfirmation({
                        title: 'API 测试失败',
                        message: result.message,
                        detail: '强制切换后 Codex 可能无法发送消息或启动异常。配置仍会备份，可使用“恢复备份 API”撤销。',
                        confirmLabel: '仍然强制切换',
                        tone: 'danger'
                      })
                      if (!force) throw new Error('API 测试未通过，已取消强制切换；本地配置未修改')
                      result = await codexApi().switchToCustomApi({ ...profile, force: true }, true)
                    }
                    if (!result.ok) throw new Error(result.message)
                    if (result.restartResult && !result.restartResult.ok) {
                      throw new Error(`自定义 API 已保存，但 Codex 重启失败：${result.restartResult.message}`)
                    }
                    if (result.catalogModels !== undefined) {
                      replaceEditedModels(result.catalogModels)
                    }
                    setCustomApiModelsNote(result.message)
                    if (result.selectedModel) {
                      setSettingsDraft({
                        ...settingsDraft,
                        customApiModel: result.selectedModel
                      })
                    }
                    setCustomApiKey('')
                    await reload()
                    if (result.warning) {
                      setMessage({ kind: 'warn', text: `${result.message}；未自动重启 Codex` })
                      return
                    }
                    const restart = await requestConfirmation({
                      title: '第三方 API 已切换',
                      message: result.message,
                      detail: '重启会先自动修复对话，再启动官方 Codex。选择暂不重启会保留已保存的配置。',
                      confirmLabel: '修复并重启',
                      cancelLabel: '暂不重启',
                      tone: 'warning'
                    })
                    if (!restart) {
                      setMessage({ kind: 'ok', text: `${result.message}；已切换，暂未重启` })
                      return
                    }
                    const restarted = await codexApi().restartCodex()
                    if (!restarted.ok) throw new Error(`API 已切换，但自动修复/重启失败：${restarted.message}`)
                    setMessage({ kind: 'ok', text: `${result.message}；已自动修复对话并重启 Codex` })
                  }, undefined, false)
                })()} disabled={!canSwitchCustomApi}>
                  <KeyRound size={16} />测试并切换
                </Button>
              </div>
            </section>
            <section className="update-panel flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3" aria-label="应用更新">
              <div>
                <strong>应用更新</strong>
                <span>{updateState?.message ?? '正在读取版本信息'}</span>
              </div>
              {updateState?.status === 'available' && (
                <Button onClick={() => void downloadUpdate()} disabled={busy}>
                  <Download size={16} />下载 {updateState.availableVersion}
                </Button>
              )}
              {updateState?.status === 'downloading' && (
                <Button disabled><LoaderCircle className="spin" size={16} />{Math.round(updateState.percent ?? 0)}%</Button>
              )}
              {updateState?.status === 'downloaded' && (
                <Button variant="default" onClick={() => void installUpdate()}>
                  <PackageOpen size={16} />安装并重启
                </Button>
              )}
              {!['available', 'downloading', 'downloaded'].includes(updateState?.status ?? '') && (
                <Button onClick={() => void checkForUpdates()} disabled={updateState?.status === 'checking'}>
                  {updateState?.status === 'checking' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  检查更新
                </Button>
              )}
            </section>
            <DialogActions className="panel-actions flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3"><Button variant="secondary" onClick={() => closeSettingsDialog()} disabled={busy}><X size={16} />取消</Button><Button variant="default" disabled={busy} onClick={() => void run(async () => { if (settingsDraft.autoSwitchEnabled && settingsDraft.autoSwitchAccountIds.length === 0) throw new Error('启用自动切换前至少选择一个候选账号'); await codexApi().updateSettings(settingsDraft); closeSettingsDialog(true) }, '设置已保存')}><CheckCircle2 size={16} />保存设置</Button></DialogActions>
          </DialogPanel>
        </DialogBackdrop>
  )
}
