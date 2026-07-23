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
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { AppSnapshot, UpdateState } from '../../../../shared/ipc'
import type { AppSettings } from '../../../../shared/types'
import type { RequestConfirmation } from '../../hooks/useConfirmation'
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
  if (!open) return null

  return (
        <div className="modal-backdrop" role="presentation">
          <section ref={settingsDialogRef} className="settings-panel" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
            <div className="panel-header"><h2>设置</h2><button className="icon-button" title="关闭" aria-label="关闭设置" onClick={() => closeSettingsDialog()} disabled={busy}><X size={18} /></button></div>
            <label>aa 托管凭证库<input aria-label="应用凭证库" value={snapshot.importDirectory} readOnly /></label>
            <label>导入文件默认目录<div className="path-input"><input value={settingsDraft.accountDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, accountDirectory: event.target.value })} /><button title="选择目录" onClick={async () => { const path = await codexApi().chooseAccountDirectory(); if (path) setSettingsDraft({ ...settingsDraft, accountDirectory: path }) }}><FolderOpen size={17} /></button></div></label>
            <label>CPA 共享账号目录（Codex + Grok）<div className="path-input"><input value={settingsDraft.grokDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, grokDirectory: event.target.value })} /><button title="选择 CPA 共享目录" onClick={async () => { const path = await codexApi().chooseGrokDirectory(); if (path) setSettingsDraft({ ...settingsDraft, grokDirectory: path }) }}><FolderOpen size={17} /></button></div></label>
            <label>auth.json 路径<input value={settingsDraft.authPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, authPath: event.target.value })} /></label>
            <label>config.toml 路径<input value={settingsDraft.configPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, configPath: event.target.value })} /></label>
            <div className="settings-grid">
              <label>并发数<input aria-label="并发数" type="number" min={1} max={12} value={settingsDraft.concurrency} onChange={(event) => setSettingsDraft({ ...settingsDraft, concurrency: Number(event.target.value) })} /></label>
              <label>超时（毫秒）<input type="number" min={1000} value={settingsDraft.timeoutMs} onChange={(event) => setSettingsDraft({ ...settingsDraft, timeoutMs: Number(event.target.value) })} /></label>
              <label>备份保留数<input type="number" min={1} value={settingsDraft.backupRetention} onChange={(event) => setSettingsDraft({ ...settingsDraft, backupRetention: Number(event.target.value) })} /></label>
              <label>深度检测模型<input value={settingsDraft.deepTestModel} onChange={(event) => setSettingsDraft({ ...settingsDraft, deepTestModel: event.target.value })} /></label>
            </div>
            <section className="custom-api-panel" aria-label="自定义 API">
              <div className="section-heading">
                <div><strong>自定义 API</strong><span>可从上游获取模型后逐行增删，并选择是否导入 Codex。保存前会真实发送 hi，成功后由你决定是否修复会话并重启。应用保存的 Key 副本使用 DPAPI 加密，但 Codex 运行配置会按兼容格式写入明文 Key</span></div>
                <span className={`saved-secret ${snapshot.customApi.hasApiKey ? 'ready' : ''}`}>{snapshot.customApi.hasApiKey ? 'Key 已保存' : '未保存 Key'}</span>
              </div>
              <label>API 地址<input value={settingsDraft.customApiBaseUrl} onChange={(event) => {
                setSettingsDraft({ ...settingsDraft, customApiBaseUrl: event.target.value })
                setCustomApiModels([])
                setCustomApiModelsText('')
                setCustomApiModelsNote('')
              }} placeholder="https://api.example.com/v1 或完整 .../v1/chat/completions" /></label>
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
              <label className="check-option"><input type="checkbox" checked={customApiSyncCatalog} onChange={(event) => setCustomApiSyncCatalog(event.target.checked)} />将下面的模型目录导入 Codex</label>
              <label>同步到 Codex 的模型目录（每行一个，可自由增删）
                <textarea
                  aria-label="同步到 Codex 的模型目录"
                  rows={6}
                  value={customApiModelsText}
                  onChange={(event) => {
                    const text = event.target.value
                    const seen = new Set<string>()
                    const models = text.split(/\r?\n/).map((item) => item.trim()).filter((item) => {
                      if (!item || seen.has(item)) return false
                      seen.add(item)
                      return true
                    })
                    setCustomApiModelsText(text)
                    setCustomApiModels(models)
                    setCustomApiModelsNote(`将同步 ${models.length + (models.includes(settingsDraft.customApiModel.trim()) ? 0 : 1)} 个模型（当前模型会自动保留）`)
                  }}
                  placeholder={'model-a\nmodel-b\n也可以手动增加上游未列出的模型'}
                />
              </label>
              {customApiModelsNote ? <p className="custom-api-models-note">{customApiModelsNote}</p> : null}
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
              <div className="custom-api-actions">
                <button type="button" className="secondary-button" disabled={busy || !settingsDraft.customApiBaseUrl.trim() || (!snapshot.customApi.hasApiKey && !customApiKey.trim())} onClick={() => void run(async () => {
                  const listed = await codexApi().listCustomApiModels({
                    baseUrl: settingsDraft.customApiBaseUrl,
                    ...(customApiKey.trim() ? { apiKey: customApiKey } : {})
                  })
                  setCustomApiModels(listed.models)
                  setCustomApiModelsText(listed.models.join('\n'))
                  setCustomApiModelsNote(listed.message)
                  if (!listed.ok) throw new Error(listed.message)
                  if (listed.models.length > 0) {
                    const current = settingsDraft.customApiModel.trim()
                    if (!current || !listed.models.includes(current)) {
                      setSettingsDraft({ ...settingsDraft, customApiModel: listed.models[0], customApiBaseUrl: listed.baseUrl || settingsDraft.customApiBaseUrl })
                    } else if (listed.baseUrl) {
                      setSettingsDraft({ ...settingsDraft, customApiBaseUrl: listed.baseUrl })
                    }
                  }
                }, '已获取自定义 API 模型列表', false)}>
                  获取模型列表
                </button>
                <button className="primary-button" onClick={() => void (async () => {
                  if (!await requestConfirmation({
                    title: '测试并切换第三方 API',
                    message: '先真实测试 API；通过后保存 provider 配置，再由你选择是否修复会话并重启 Codex。',
                    detail: '测试失败不会修改配置。强制保存需要第二次确认，且不会自动重启。',
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
                    if (result.catalogModels?.length) {
                      setCustomApiModels(result.catalogModels)
                      setCustomApiModelsText(result.catalogModels.join('\n'))
                    }
                    setCustomApiModelsNote(result.message)
                    if (result.selectedModel || result.discoveredBaseUrl) {
                      setSettingsDraft({
                        ...settingsDraft,
                        customApiModel: result.selectedModel || settingsDraft.customApiModel,
                        customApiBaseUrl: result.discoveredBaseUrl || settingsDraft.customApiBaseUrl
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
                })()} disabled={busy || (!snapshot.customApi.hasApiKey && !customApiKey.trim())}>
                  <KeyRound size={16} />测试并切换
                </button>
              </div>
            </section>
            <section className="update-panel" aria-label="应用更新">
              <div>
                <strong>应用更新</strong>
                <span>{updateState?.message ?? '正在读取版本信息'}</span>
              </div>
              {updateState?.status === 'available' && (
                <button onClick={() => void downloadUpdate()} disabled={busy}>
                  <Download size={16} />下载 {updateState.availableVersion}
                </button>
              )}
              {updateState?.status === 'downloading' && (
                <button disabled><LoaderCircle className="spin" size={16} />{Math.round(updateState.percent ?? 0)}%</button>
              )}
              {updateState?.status === 'downloaded' && (
                <button className="primary-button" onClick={() => void installUpdate()}>
                  <PackageOpen size={16} />安装并重启
                </button>
              )}
              {!['available', 'downloading', 'downloaded'].includes(updateState?.status ?? '') && (
                <button onClick={() => void checkForUpdates()} disabled={updateState?.status === 'checking'}>
                  {updateState?.status === 'checking' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  检查更新
                </button>
              )}
            </section>
            <div className="panel-actions"><button className="secondary-button" onClick={() => closeSettingsDialog()} disabled={busy}><X size={16} />取消</button><button className="primary-button" disabled={busy} onClick={() => void run(async () => { if (settingsDraft.autoSwitchEnabled && settingsDraft.autoSwitchAccountIds.length === 0) throw new Error('启用自动切换前至少选择一个候选账号'); await codexApi().updateSettings(settingsDraft); closeSettingsDialog(true) }, '设置已保存')}><CheckCircle2 size={16} />保存设置</button></div>
          </section>
        </div>
  )
}
