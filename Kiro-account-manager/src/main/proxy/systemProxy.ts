// 系统代理检测（Windows 注册表 / macOS scutil）

let _cachedSystemProxy: string | null = null
let _systemProxyCacheTime = 0
const SYSTEM_PROXY_CACHE_TTL = 30_000 // 30秒缓存

export function getSystemProxy(): string | null {
  const now = Date.now()
  if (_systemProxyCacheTime > 0 && now - _systemProxyCacheTime < SYSTEM_PROXY_CACHE_TTL) {
    return _cachedSystemProxy
  }
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process')
      const result = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      if (result.includes('0x1')) {
        const serverResult = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf8', timeout: 3000, windowsHide: true }
        )
        const match = serverResult.match(/ProxyServer\s+REG_SZ\s+(.+)/)
        if (match) {
          let proxy = match[1].trim()
          if (proxy && !proxy.startsWith('http') && !proxy.startsWith('socks')) {
            proxy = `http://${proxy}`
          }
          _cachedSystemProxy = proxy || null
          _systemProxyCacheTime = now
          return _cachedSystemProxy
        }
      }
    } else if (process.platform === 'darwin') {
      const { execSync } = require('child_process')
      const result = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 })
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(result)
      if (httpEnabled) {
        const hostMatch = result.match(/HTTPProxy\s*:\s*(\S+)/)
        const portMatch = result.match(/HTTPPort\s*:\s*(\d+)/)
        if (hostMatch) {
          const proxy = `http://${hostMatch[1]}${portMatch ? ':' + portMatch[1] : ''}`
          _cachedSystemProxy = proxy
          _systemProxyCacheTime = now
          return _cachedSystemProxy
        }
      }
    }
  } catch { /* 检测失败静默回退直连 */ }
  _cachedSystemProxy = null
  _systemProxyCacheTime = now
  return null
}
