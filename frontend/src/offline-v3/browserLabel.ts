export function offlineBrowserLabel(userAgent = navigator.userAgent, platform = navigator.platform) {
  const browser = /Edg\//.test(userAgent) ? 'Microsoft Edge' : /Chrome\//.test(userAgent) ? 'Google Chrome' : 'Navegador compatible'
  return `${browser} · ${platform || 'Windows'}`
}
