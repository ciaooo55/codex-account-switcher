import type { UsageWindow } from '../../../shared/types'

export function dateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function sourceFileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

export function secondsUntilReset(window: UsageWindow, checkedAt: string, now: number): number | null {
  const referenceNow = Math.max(now, Date.now())
  if (window.resetAt) {
    const timestamp = Date.parse(window.resetAt)
    return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - referenceNow) / 1_000)) : null
  }
  if (window.resetInSeconds === null) return null
  const checkedTimestamp = Date.parse(checkedAt)
  const elapsed = Number.isFinite(checkedTimestamp) ? Math.max(0, Math.floor((referenceNow - checkedTimestamp) / 1_000)) : 0
  return Math.max(0, window.resetInSeconds - elapsed)
}

export function resetMoment(window: UsageWindow, checkedAt: string): string {
  if (window.resetAt) return dateTime(window.resetAt)
  if (window.resetInSeconds !== null) {
    const checkedTimestamp = Date.parse(checkedAt)
    if (Number.isFinite(checkedTimestamp)) {
      return dateTime(new Date(checkedTimestamp + window.resetInSeconds * 1_000).toISOString())
    }
  }
  return '-'
}

export function resetCountdown(window: UsageWindow, checkedAt: string, now: number): string | null {
  const seconds = secondsUntilReset(window, checkedAt, now)
  if (seconds === null) return null
  if (seconds === 0) return '即将恢复'
  const weekly = window.windowSeconds === 604_800 || /周|week/i.test(window.label)
  const fiveHour = window.windowSeconds === 18_000 || /5\s*(?:小时|h(?:our)?s?)/i.test(window.label)
  if (weekly) return `剩余 ${Math.ceil(seconds / 3_600)} 小时`
  if (fiveHour) return `剩余 ${Math.ceil(seconds / 60)} 分钟`
  return seconds >= 21_600 ? `剩余 ${Math.ceil(seconds / 3_600)} 小时` : `剩余 ${Math.ceil(seconds / 60)} 分钟`
}