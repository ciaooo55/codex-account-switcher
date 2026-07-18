import type { AppSettings, AutoSwitchRunResult, AutoSwitchState } from '../../shared/types'

interface AutoSwitchSchedulerOptions {
  getSettings(): Promise<AppSettings>
  execute(): Promise<AutoSwitchRunResult>
  onState(state: AutoSwitchState): void
  now?: () => Date
}

export function shouldNotifyAutoSwitchCompletion(
  previous: AutoSwitchState | null,
  current: AutoSwitchState,
  quitting = false
): boolean {
  return !quitting && Boolean(previous?.running && !current.running && current.lastSwitchedAccountId)
}

export class AutoSwitchScheduler {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private state: AutoSwitchState = {
    enabled: false,
    running: false,
    nextCheckAt: null,
    lastCheckAt: null,
    lastMessage: '自动切换未启用',
    lastSwitchedAccountId: null
  }
  private readonly now: () => Date

  constructor(private readonly options: AutoSwitchSchedulerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  getState(): AutoSwitchState {
    return { ...this.state }
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.reschedule()
  }

  async settingsChanged(): Promise<void> {
    await this.reschedule()
  }

  async runNow(force = false): Promise<AutoSwitchRunResult> {
    if (this.state.running) {
      return {
        ok: false,
        switched: false,
        message: '自动检测任务正在运行',
        checkedAccountIds: [],
        switchedAccountId: null
      }
    }
    const settings = await this.options.getSettings()
    if (!force && !settings.autoSwitchEnabled) {
      return {
        ok: false,
        switched: false,
        message: '自动切换未启用',
        checkedAccountIds: [],
        switchedAccountId: null
      }
    }
    this.clearTimer()
    this.publish({
      enabled: settings.autoSwitchEnabled,
      running: true,
      nextCheckAt: null,
      lastMessage: '正在检查当前账号'
    })
    let result: AutoSwitchRunResult
    try {
      result = await this.options.execute()
      this.publish({
        running: false,
        lastCheckAt: this.now().toISOString(),
        lastMessage: result.message,
        lastSwitchedAccountId: result.switchedAccountId
      })
    } catch (error) {
      result = {
        ok: false,
        switched: false,
        message: error instanceof Error ? error.message : '自动检测失败',
        checkedAccountIds: [],
        switchedAccountId: null
      }
      this.publish({
        running: false,
        lastCheckAt: this.now().toISOString(),
        lastMessage: result.message
      })
    }
    await this.scheduleFromSettings()
    return result
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.publish({ running: false, nextCheckAt: null })
  }

  private async reschedule(): Promise<void> {
    this.clearTimer()
    const settings = await this.options.getSettings()
    this.publish({
      enabled: settings.autoSwitchEnabled,
      nextCheckAt: null,
      lastMessage: settings.autoSwitchEnabled
        ? this.state.lastMessage === '自动切换未启用' ? '等待定时检查' : this.state.lastMessage
        : '自动切换未启用'
    })
    if (!this.state.running) await this.scheduleFromSettings()
  }

  private async scheduleFromSettings(): Promise<void> {
    if (this.stopped || this.state.running) return
    const settings = await this.options.getSettings()
    if (!settings.autoSwitchEnabled) {
      this.publish({ enabled: false, nextCheckAt: null })
      return
    }
    const delay = settings.autoSwitchIntervalSeconds * 1_000
    this.publish({
      enabled: true,
      nextCheckAt: new Date(this.now().getTime() + delay).toISOString()
    })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runNow().catch(() => undefined)
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private publish(patch: Partial<AutoSwitchState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onState(this.getState())
  }
}
