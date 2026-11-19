/**
 * 主窗口只允许停留在应用自身页面：同一个文件（打包后）或同源地址（开发服务器）。
 * 其他跳转一律拒绝，避免带 preload 权限的窗口被导航到外部内容。
 */
export function isInAppNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)
    if (current.protocol !== target.protocol) return false
    if (current.protocol === 'file:') {
      return current.host === target.host && current.pathname === target.pathname
    }
    if (current.protocol === 'http:' || current.protocol === 'https:') {
      return current.origin === target.origin
    }
    return false
  } catch {
    return false
  }
}
