import { describe, expect, it } from 'vitest'
import { isInAppNavigation } from './navigation-guard'

describe('isInAppNavigation', () => {
  const packaged = 'file:///C:/app/resources/app.asar/out/renderer/index.html'

  it('allows reloading the packaged renderer page', () => {
    expect(isInAppNavigation(packaged, packaged)).toBe(true)
    expect(isInAppNavigation(packaged, `${packaged}#/settings`)).toBe(true)
  })

  it('blocks other local files and remote pages from the packaged app', () => {
    expect(isInAppNavigation(packaged, 'file:///C:/Users/lee/evil.html')).toBe(false)
    expect(isInAppNavigation(packaged, 'https://example.com/')).toBe(false)
    expect(isInAppNavigation(packaged, 'javascript:alert(1)')).toBe(false)
  })

  it('allows same-origin navigation on the dev server only', () => {
    const dev = 'http://localhost:5173/'
    expect(isInAppNavigation(dev, 'http://localhost:5173/index.html')).toBe(true)
    expect(isInAppNavigation(dev, 'http://localhost:5174/')).toBe(false)
    expect(isInAppNavigation(dev, 'https://example.com/')).toBe(false)
  })

  it('blocks navigation when either URL is invalid', () => {
    expect(isInAppNavigation('', packaged)).toBe(false)
    expect(isInAppNavigation(packaged, 'not a url')).toBe(false)
  })
})
