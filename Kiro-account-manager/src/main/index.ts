import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as machineIdModule from './machineId'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { encode, decode } from 'cbor-x'
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import icon from '../../resources/icon.png?asset'
import { ProxyServer, configureProxyClients, type ProxyAccount, type ProxyConfig, type ProxyClientTarget, type ProxyClientModel } from './proxy'
import { 
  initKProxyService, 
  getKProxyService, 
  generateDeviceId, 
  isValidDeviceId,
  type KProxyConfig,
  type DeviceIdMapping
} from './kproxy'
import { fetchKiroModels, fetchSubscriptionToken, fetchAvailableSubscriptions, setUserPreference, setUseKProxyForApiInProxy, setLogStreamEvents, setPayloadSizeLimitKB, setTokenBufferReserve } from './proxy/kiroApi'
import { getSystemProxy } from './proxy/systemProxy'
import { proxyLogStore, interceptConsole } from './proxy/logger'
import { registerIPCHandlers as registerRegistrationHandlers } from './registration/ipc-handlers'
import {
  createTray,
  destroyTray,
  updateTrayMenu,
  updateCurrentAccount,
  updateAccountList,
  setTrayTooltip,
  updateTrayLanguage,
  type TraySettings,
  defaultTraySettings
} from './tray'

// ============ 鑷姩鏇存柊閰嶇疆 ============
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
const AUTO_UPDATE_ON_STARTUP = process.env.KAM_AUTO_UPDATE_ON_STARTUP === '1'
let autoUpdateOnStartup = AUTO_UPDATE_ON_STARTUP

function setupAutoUpdater(): void {
  // 妫€鏌ユ洿鏂板嚭閿?  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error)
    mainWindow?.webContents.send('update-error', error.message)
  })

  // 妫€鏌ユ洿鏂颁腑
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    mainWindow?.webContents.send('update-checking')
  })

  // 鏈夊彲鐢ㄦ洿鏂?  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // 娌℃湁鍙敤鏇存柊
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available, current:', info.version)
    mainWindow?.webContents.send('update-not-available', { version: info.version })
  })

  // 涓嬭浇杩涘害
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  // 涓嬭浇瀹屾垚
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })
}

// ============ Kiro API 璋冪敤 ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API 绔偣閰嶇疆 - 瀹樻柟 Kiro 鎻掍欢浠呮敮鎸?us-east-1 鍜?eu-central-1
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// 鏍规嵁 SSO 鍖哄煙鏄犲皠鍒版渶杩戠殑 REST API 绔偣
function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  // 濡傛灉鏄敮鎸佺殑绔偣鍖哄煙锛岀洿鎺ヤ娇鐢?  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  // EU 鍖哄煙鏄犲皠鍒?eu-central-1
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  // 鍏朵粬鍖哄煙榛樿 us-east-1
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// 鑾峰彇澶囩敤 REST API 绔偣锛堢敤浜?fallback锛?function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  // 杩斿洖鍙︿竴涓鐐逛綔涓?fallback
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

// API 绫诲瀷閰嶇疆
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // 榛樿浣跨敤 REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// 鏄惁浣跨敤 K-Proxy 浠ｇ悊鍙戦€?API 璇锋眰
let useKProxyForApi: boolean = false

export function setUseKProxyForApi(enabled: boolean): void {
  useKProxyForApi = enabled
  // 鍚屾璁剧疆鍒?kiroApi.ts
  setUseKProxyForApiInProxy(enabled)
  console.log(`[API] Use K-Proxy for API requests: ${enabled}`)
}

export function getUseKProxyForApi(): boolean {
  return useKProxyForApi
}

// 鑾峰彇缃戠粶浠ｇ悊 agent锛堜紭鍏?K-Proxy锛屽叾娆＄敤鎴疯缃唬鐞嗭紝鍏舵绯荤粺浠ｇ悊锛?function getNetworkAgent(): ProxyAgent | undefined {
  if (useKProxyForApi) {
    const kproxyService = getKProxyService()
    if (kproxyService?.isRunning()) {
      const config = kproxyService.getConfig()
      const proxyUrl = `http://${config.host}:${config.port}`
      return new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } })
    }
  }
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (envProxy) {
    return new ProxyAgent({ uri: envProxy, requestTls: { rejectUnauthorized: false } })
  }
  const systemProxy = getSystemProxy()
  if (systemProxy) {
    return new ProxyAgent({ uri: systemProxy, requestTls: { rejectUnauthorized: false } })
  }
  return undefined
}

// 閫氱敤 fetch 鍑芥暟锛屼娇鐢?getNetworkAgent 鑾峰彇浠ｇ悊
async function fetchWithAppProxy(url: string, options: RequestInit): Promise<Response> {
  const agent = getNetworkAgent()
  if (agent) {
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// 鍏煎鍑芥暟锛屾寚鍚?getNetworkAgent
function getKProxyAgent(): ProxyAgent | undefined {
  return getNetworkAgent()
}

// ============ OIDC Token 鍒锋柊 ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

// 绀句氦鐧诲綍 (GitHub/Google) 鐨?Token 鍒锋柊绔偣
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ 浠ｇ悊璁剧疆 ============

// 璁剧疆浠ｇ悊鐜鍙橀噺
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    process.env.HTTP_PROXY = url
    process.env.HTTPS_PROXY = url
    process.env.http_proxy = url
    process.env.https_proxy = url
    console.log(`[Proxy] Enabled: ${url}`)
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// ============ 闃叉姈 store 鍐欏叆锛堝噺灏戠鐩?I/O锛?============
const pendingStoreWrites: Map<string, unknown> = new Map()
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null
const STORE_FLUSH_INTERVAL = 5000 // 5 绉掓壒閲忓啓鍏ヤ竴娆?
function debouncedStoreSet(key: string, value: unknown): void {
  pendingStoreWrites.set(key, value)
  if (!storeFlushTimer) {
    storeFlushTimer = setTimeout(flushStoreWrites, STORE_FLUSH_INTERVAL)
  }
}

function flushStoreWrites(): void {
  storeFlushTimer = null
  if (!store || pendingStoreWrites.size === 0) return
  for (const [key, value] of pendingStoreWrites) {
    store.set(key, value)
  }
  pendingStoreWrites.clear()
}

let trayMenuTimer: ReturnType<typeof setTimeout> | null = null

function debouncedUpdateTrayMenu(): void {
  if (trayMenuTimer) return
  trayMenuTimer = setTimeout(() => {
    trayMenuTimer = null
    updateTrayMenu()
  }, 3000)
}

// ============ Kiro API 鍙嶄唬鏈嶅姟鍣?============
let proxyServer: ProxyServer | null = null

function initProxyServer(): ProxyServer {
  if (proxyServer) return proxyServer

  // 纭繚鏃ュ織瀛樺偍宸插垵濮嬪寲锛坅pp.whenReady 涓凡璋冪敤锛屾澶勫厹搴曪級
  proxyLogStore.initialize(app.getPath('userData'))

  // 浠?store 鍔犺浇淇濆瓨鐨勯厤缃紝濡傛灉娌℃湁鍒欎娇鐢ㄩ粯璁ら厤缃?  const savedConfig = store?.get('proxyConfig') as Partial<ProxyConfig> | undefined
  // 浠?store 鍔犺浇淇濆瓨鐨?Usage API 绫诲瀷
  const savedUsageApiType = store?.get('usageApiType') as 'rest' | 'cbor' | undefined
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType)
  }
  // 浠?store 鍔犺浇淇濆瓨鐨?K-Proxy 浠ｇ悊璁剧疆
  const savedUseKProxyForApi = store?.get('useKProxyForApi') as boolean | undefined
  if (savedUseKProxyForApi !== undefined) {
    setUseKProxyForApi(savedUseKProxyForApi)
  }
  // 浠?store 鍔犺浇淇濆瓨鐨勭疮璁?credits 鍜?tokens
  const savedTotalCredits = (store?.get('proxyTotalCredits') as number) || 0
  const savedInputTokens = (store?.get('proxyInputTokens') as number) || 0
  const savedOutputTokens = (store?.get('proxyOutputTokens') as number) || 0
  // 浠?store 鍔犺浇淇濆瓨鐨勮姹傜粺璁?  const savedTotalRequests = (store?.get('proxyTotalRequests') as number) || 0
  const savedSuccessRequests = (store?.get('proxySuccessRequests') as number) || 0
  const savedFailedRequests = (store?.get('proxyFailedRequests') as number) || 0
  const defaultConfig: ProxyConfig = {
    enabled: false,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    maxRetries: 3,
    retryDelayMs: 1000,
    tokenRefreshBeforeExpiry: 300, // 5鍒嗛挓鎻愬墠鍒锋柊
    enableServerSideToolAutoContinue: false,
    clientDrivenToolExecution: true
  }
  
  // 鍚堝苟淇濆瓨鐨勯厤缃拰榛樿閰嶇疆
  const config: ProxyConfig = savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig

  // 鎭㈠ payload 澶у皬闄愬埗
  if (config.payloadSizeLimitKB) {
    setPayloadSizeLimitKB(config.payloadSizeLimitKB)
  }
  // 鎭㈠ Token buffer reserve
  if (config.tokenBufferReserve) {
    setTokenBufferReserve(config.tokenBufferReserve)
  }

  proxyServer = new ProxyServer(
    config,
    {
      onRequest: (info) => {
        mainWindow?.webContents.send('proxy-request', info)
      },
      onResponse: (info) => {
        mainWindow?.webContents.send('proxy-response', info)
      },
      onError: (error) => {
        console.error('[ProxyServer] Error:', error)
        mainWindow?.webContents.send('proxy-error', error.message)
      },
      onStatusChange: (running, port) => {
        mainWindow?.webContents.send('proxy-status-change', { running, port })
      },
      // Token 鍒锋柊鍥炶皟 - 澶嶇敤宸叉湁鐨勫埛鏂伴€昏緫
      onTokenRefresh: async (account) => {
        try {
          console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`)
          const refreshResult = await refreshTokenByMethod(
            account.refreshToken || '',
            account.clientId || '',
            account.clientSecret || '',
            account.region || 'us-east-1',
            account.authMethod
          )

          if (refreshResult.success && refreshResult.accessToken) {
            return {
              success: true,
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresAt: Date.now() + (refreshResult.expiresIn || 3600) * 1000
            }
          }
          return { success: false, error: refreshResult.error || 'Token 鍒锋柊澶辫触' }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
      },
      // 璐﹀彿鏇存柊鍥炶皟 - 閫氱煡娓叉煋杩涚▼鏇存柊璐﹀彿鏁版嵁
      onAccountUpdate: (account) => {
        mainWindow?.webContents.send('proxy-account-update', {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt
        })
      },
      // 璐﹀彿琚?Kiro 鍚庣闀挎湡灏佺 - 閫氱煡娓叉煋杩涚▼鏍囪 lastError + 鎸佷箙鍖栧埌 store
      // 涓嶅悓浜?token 澶辨晥锛岄渶瑕佷汉宸ヨВ灏侊紱璐﹀彿姹犲凡鑷姩璺宠繃璇ヨ处鍙?      onAccountSuspended: (info) => {
        console.warn(`[ProxyServer] Account suspended: ${info.email || info.accountId} (${info.reason})`)
        // 鎺ㄩ€?IPC 浜嬩欢缁欏墠绔?store
        mainWindow?.webContents.send('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
        // 鍚屾鍐欏叆 store accountData[id].lastError, 淇濊瘉涓嬫鍚姩鏃?UI 浠嶇劧鑳界湅鍒板皝绂佺姸鎬?        if (store) {
          try {
            const accountData = store.get('accountData') as { accounts?: Record<string, Record<string, unknown>> } | undefined
            if (accountData?.accounts?.[info.accountId]) {
              accountData.accounts[info.accountId] = {
                ...accountData.accounts[info.accountId],
                status: 'error',
                lastError: `[${info.reason}] ${info.message}`,
                lastCheckedAt: Date.now()
              }
              store.set('accountData', accountData)
              lastSavedData = accountData
            }
          } catch (e) {
            console.error('[ProxyServer] Failed to persist suspended state:', e)
          }
        }
      },
      // Credits 鏇存柊鍥炶皟 - 浣跨敤闃叉姈鎸佷箙鍖?      onCreditsUpdate: (totalCredits) => {
        debouncedStoreSet('proxyTotalCredits', totalCredits)
      },
      // Tokens 鏇存柊鍥炶皟 - 浣跨敤闃叉姈鎸佷箙鍖?      onTokensUpdate: (inputTokens, outputTokens) => {
        debouncedStoreSet('proxyInputTokens', inputTokens)
        debouncedStoreSet('proxyOutputTokens', outputTokens)
      },
      // 璇锋眰缁熻鏇存柊鍥炶皟 - 浣跨敤闃叉姈鎸佷箙鍖?      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        debouncedStoreSet('proxyTotalRequests', totalRequests)
        debouncedStoreSet('proxySuccessRequests', successRequests)
        debouncedStoreSet('proxyFailedRequests', failedRequests)
        // 鏇存柊鎵樼洏鑿滃崟锛堜篃闃叉姈锛岄伩鍏嶉绻侀噸寤鸿彍鍗曪級
        debouncedUpdateTrayMenu()
      },
      // 璐﹀彿姹犱负绌烘椂鎳掑姞杞?- 浠?store 璇诲彇璐﹀彿鏁版嵁鍚屾鍒?pool
      onPoolEmpty: async () => {
        await initStore()
        if (!store) return
        const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
        if (!accountData?.accounts) return
        const proxyAccounts = Object.values(accountData.accounts)
          .filter((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
          .map((acc: any) => ({
            id: acc.id,
            email: acc.email,
            accessToken: acc.credentials.accessToken,
            refreshToken: acc.credentials?.refreshToken,
            profileArn: acc.profileArn,
            expiresAt: acc.credentials?.expiresAt,
            machineId: acc.machineId,
            clientId: acc.credentials?.clientId,
            clientSecret: acc.credentials?.clientSecret,
            region: acc.credentials?.region || 'us-east-1',
            authMethod: acc.credentials?.authMethod,
            provider: acc.credentials?.provider || acc.idp
          }))
        if (proxyAccounts.length > 0 && proxyServer) {
          const pool = proxyServer.getAccountPool()
          proxyAccounts.forEach(acc => pool.addAccount(acc))
          console.log(`[ProxyServer] Lazy-synced ${proxyAccounts.length} accounts from store`)
        }
      }
    }
  )

  // 鎭㈠淇濆瓨鐨勭疮璁?credits
  if (savedTotalCredits > 0) {
    proxyServer.setTotalCredits(savedTotalCredits)
  }

  // 鎭㈠淇濆瓨鐨勭疮璁?tokens
  if (savedInputTokens > 0 || savedOutputTokens > 0) {
    proxyServer.setTotalTokens(savedInputTokens, savedOutputTokens)
  }

  // 鎭㈠淇濆瓨鐨勮姹傜粺璁?  if (savedTotalRequests > 0 || savedSuccessRequests > 0 || savedFailedRequests > 0) {
    proxyServer.setRequestStats(savedTotalRequests, savedSuccessRequests, savedFailedRequests)
  }

  return proxyServer
}

// ============ 闅愮妯″紡鎵撳紑娴忚鍣?============
import { exec, execSync } from 'child_process'

// 鑾峰彇 Windows 榛樿娴忚鍣?function getWindowsDefaultBrowser(): string {
  try {
    // 浠庢敞鍐岃〃璇诲彇榛樿娴忚鍣?    const progId = execSync(
      'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    
    if (progId.includes('ChromeHTML') || progId.includes('Google')) return 'chrome'
    if (progId.includes('MSEdgeHTM') || progId.includes('Edge')) return 'msedge'
    if (progId.includes('FirefoxURL') || progId.includes('Firefox')) return 'firefox'
    if (progId.includes('BraveHTML') || progId.includes('Brave')) return 'brave'
    if (progId.includes('Opera')) return 'opera'
    
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// 浣跨敤闅愮妯″紡鎵撳紑娴忚鍣?function openBrowserInPrivateMode(url: string): void {
  const platform = process.platform
  console.log(`[Browser] Opening in private mode on ${platform}: ${url}`)

  try {
    if (platform === 'win32') {
      // Windows: 妫€娴嬮粯璁ゆ祻瑙堝櫒骞朵娇鐢ㄥ搴旂殑闅愮妯″紡鍙傛暟
      const defaultBrowser = getWindowsDefaultBrowser()
      console.log(`[Browser] Detected default browser: ${defaultBrowser}`)
      
      let command = ''
      switch (defaultBrowser) {
        case 'chrome':
          command = `start chrome --incognito "${url}"`
          break
        case 'msedge':
          command = `start msedge -inprivate "${url}"`
          break
        case 'firefox':
          command = `start firefox -private-window "${url}"`
          break
        case 'brave':
          command = `start brave --incognito "${url}"`
          break
        case 'opera':
          command = `start opera --private "${url}"`
          break
        default:
          // 鏈煡娴忚鍣紝灏濊瘯甯歌娴忚鍣?          console.log('[Browser] Unknown default browser, trying common browsers...')
          exec(`start chrome --incognito "${url}"`, (err) => {
            if (err) {
              exec(`start msedge -inprivate "${url}"`, (err2) => {
                if (err2) {
                  exec(`start firefox -private-window "${url}"`, (err3) => {
                    if (err3) {
                      console.log('[Browser] Fallback to default browser (non-private)')
                      shell.openExternal(url)
                    }
                  })
                }
              })
            }
          })
          return
      }
      
      exec(command, (err) => {
        if (err) {
          console.log(`[Browser] Failed to open ${defaultBrowser}, fallback to default`)
          shell.openExternal(url)
        }
      })
    } else if (platform === 'darwin') {
      // macOS: 灏濊瘯 Chrome -> Firefox -> 榛樿娴忚鍣?      exec(`open -na "Google Chrome" --args --incognito "${url}"`, (err) => {
        if (err) {
          exec(`open -a Firefox --args -private-window "${url}"`, (err2) => {
            if (err2) {
              console.log('[Browser] Fallback to default browser')
              shell.openExternal(url)
            }
          })
        }
      })
    } else {
      // Linux: 灏濊瘯 Chrome -> Chromium -> Firefox
      exec(`google-chrome --incognito "${url}"`, (err) => {
        if (err) {
          exec(`chromium --incognito "${url}"`, (err2) => {
            if (err2) {
              exec(`firefox -private-window "${url}"`, (err3) => {
                if (err3) {
                  console.log('[Browser] Fallback to default browser')
                  shell.openExternal(url)
                }
              })
            }
          })
        }
      })
    }
  } catch (error) {
    console.error('[Browser] Error opening in private mode:', error)
    shell.openExternal(url)
  }
}

// IdC (BuilderId) 鐨?OIDC Token 鍒锋柊
async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1'
): Promise<OidcRefreshResult> {
  console.log(`[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...`)
  
  const url = `https://oidc.${region}.amazonaws.com/token`
  
  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  }
  
  try {
    const response = await fetchWithAppProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)
    
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken, // 鍙兘涓嶈繑鍥炴柊鐨?refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 绀句氦鐧诲綍 (GitHub/Google) 鐨?Token 鍒锋柊
async function refreshSocialToken(refreshToken: string): Promise<OidcRefreshResult> {
  console.log(`[Social] Refreshing token...`)
  
  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`
  const machineId = getCurrentMachineId()
  
  try {
    const response = await fetchWithAppProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': getKiroUserAgent(machineId)
      },
      body: JSON.stringify({ refreshToken })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }
    
    const data = await response.json()
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)
    
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[Social] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 閫氱敤 Token 鍒锋柊 - 鏍规嵁 authMethod 閫夋嫨鍒锋柊鏂瑰紡
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string
): Promise<OidcRefreshResult> {
  // 濡傛灉鏄ぞ浜ょ櫥褰曪紝浣跨敤 Kiro Auth Service 鍒锋柊
  if (authMethod === 'social') {
    return refreshSocialToken(token)
  }
  // 鍚﹀垯浣跨敤 OIDC 鍒锋柊 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Kiro 鐗堟湰鍜?User-Agent 鐢熸垚
const KIRO_VERSION = '0.6.18'

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

function getCurrentMachineId(): string | undefined {
  const kproxyService = getKProxyService()
  if (!kproxyService) return undefined
  return kproxyService.getDeviceId()
}

// ============ AWS SSO 璁惧鎺堟潈娴佺▼ ============
interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

async function ssoDeviceAuth(bearerToken: string, region: string = 'us-east-1'): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const portalBase = 'https://portal.sso.us-east-1.amazonaws.com'
  const startUrl = 'https://view.awsapps.com/start'
  const scopes = ['codewhisperer:analysis', 'codewhisperer:completions', 'codewhisperer:conversations', 'codewhisperer:taskassist', 'codewhisperer:transformations']

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let deviceSessionToken: string
  let interval = 1

  // Step 1: 娉ㄥ唽 OIDC 瀹㈡埛绔?  console.log('[SSO] Step 1: Registering OIDC client...')
  try {
    const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiro Account Manager',
        clientType: 'public',
        scopes,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: startUrl
      })
    })
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`)
    const regData = await regRes.json() as { clientId: string; clientSecret: string }
    clientId = regData.clientId
    clientSecret = regData.clientSecret
    console.log(`[SSO] Client registered: ${clientId.substring(0, 30)}...`)
  } catch (e) {
    return { success: false, error: `娉ㄥ唽瀹㈡埛绔け璐? ${e}` }
  }

  // Step 2: 鍙戣捣璁惧鎺堟潈
  console.log('[SSO] Step 2: Starting device authorization...')
  try {
    const devRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    })
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`)
    const devData = await devRes.json() as { deviceCode: string; userCode: string; interval?: number }
    deviceCode = devData.deviceCode
    userCode = devData.userCode
    interval = devData.interval || 1
    console.log(`[SSO] Device code obtained, user_code: ${userCode}`)
  } catch (e) {
    return { success: false, error: `璁惧鎺堟潈澶辫触: ${e}` }
  }

  // Step 3: 楠岃瘉 Bearer Token (whoAmI)
  console.log('[SSO] Step 3: Verifying bearer token...')
  try {
    const whoRes = await fetchWithAppProxy(`${portalBase}/token/whoAmI`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Accept': 'application/json' }
    })
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`)
    console.log('[SSO] Bearer token verified')
  } catch (e) {
    return { success: false, error: `Token 楠岃瘉澶辫触: ${e}` }
  }

  // Step 4: 鑾峰彇璁惧浼氳瘽浠ょ墝
  console.log('[SSO] Step 4: Getting device session token...')
  try {
    const sessRes = await fetchWithAppProxy(`${portalBase}/session/device`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    if (!sessRes.ok) throw new Error(`Device session failed: ${sessRes.status}`)
    const sessData = await sessRes.json() as { token: string }
    deviceSessionToken = sessData.token
    console.log('[SSO] Device session token obtained')
  } catch (e) {
    return { success: false, error: `鑾峰彇璁惧浼氳瘽澶辫触: ${e}` }
  }

  // Step 5: 鎺ュ彈鐢ㄦ埛浠ｇ爜
  console.log('[SSO] Step 5: Accepting user code...')
  let deviceContext: { deviceContextId?: string; clientId?: string; clientType?: string } | null = null
  try {
    const acceptRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/accept_user_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://view.awsapps.com/' },
      body: JSON.stringify({ userCode, userSessionId: deviceSessionToken })
    })
    if (!acceptRes.ok) throw new Error(`Accept user code failed: ${acceptRes.status}`)
    const acceptData = await acceptRes.json() as { deviceContext?: { deviceContextId?: string; clientId?: string; clientType?: string } }
    deviceContext = acceptData.deviceContext || null
    console.log('[SSO] User code accepted')
  } catch (e) {
    return { success: false, error: `鎺ュ彈鐢ㄦ埛浠ｇ爜澶辫触: ${e}` }
  }

  // Step 6: 鎵瑰噯鎺堟潈
  if (deviceContext?.deviceContextId) {
    console.log('[SSO] Step 6: Approving authorization...')
    try {
      const approveRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/associate_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://view.awsapps.com/' },
        body: JSON.stringify({
          deviceContext: {
            deviceContextId: deviceContext.deviceContextId,
            clientId: deviceContext.clientId || clientId,
            clientType: deviceContext.clientType || 'public'
          },
          userSessionId: deviceSessionToken
        })
      })
      if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status}`)
      console.log('[SSO] Authorization approved')
    } catch (e) {
      return { success: false, error: `鎵瑰噯鎺堟潈澶辫触: ${e}` }
    }
  }

  // Step 7: 杞鑾峰彇 Token
  console.log('[SSO] Step 7: Polling for token...')
  const startTime = Date.now()
  const timeout = 120000 // 2 鍒嗛挓瓒呮椂

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, interval * 1000))
    
    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { accessToken: string; refreshToken: string; expiresIn?: number }
        console.log('[SSO] Token obtained successfully!')
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
      }

      if (tokenRes.status === 400) {
        const errData = await tokenRes.json() as { error?: string }
        if (errData.error === 'authorization_pending') {
          continue // 缁х画杞
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token 鑾峰彇澶辫触: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: '鎺堟潈瓒呮椂锛岃閲嶈瘯' }
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp: string = 'BuilderId',  // 鏀寔 BuilderId, Github, Google
  accountMachineId?: string,  // 璐︽埛缁戝畾鐨勮澶?ID
  email?: string              // 鐢ㄤ簬鏃ュ織鏍囪瘑
): Promise<T> {
  // 浼樺厛浣跨敤璐︽埛缁戝畾鐨勮澶?ID锛屽叾娆′娇鐢?K-Proxy 鍏ㄥ眬璁惧 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro API] ${operation} [${logTag}] ${idp} machineId=${machineId?.slice(0, 8) || 'none'}`)
  const agent = getKProxyAgent()
  
  // 浣跨敤 undici fetch 鏀寔浠ｇ悊
  const headers: Record<string, string> = {
    'accept': 'application/cbor',
    'content-type': 'application/cbor',
    'smithy-protocol': 'rpc-v2-cbor',
    'amz-sdk-invocation-id': generateInvocationId(),
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': getKiroAmzUserAgent(machineId),
    'authorization': `Bearer ${accessToken}`,
    'cookie': `Idp=${idp}; AccessToken=${accessToken}`
  }
  
  let response: Response
  if (agent) {
    response = await undiciFetch(`${KIRO_API_BASE}/${operation}`, {
      method: 'POST',
      headers,
      body: Buffer.from(encode(body)),
      dispatcher: agent
    } as UndiciRequestInit) as unknown as Response
  } else {
    response = await fetchWithAppProxy(`${KIRO_API_BASE}/${operation}`, {
      method: 'POST',
      headers,
      body: Buffer.from(encode(body))
    })
  }

  if (!response.ok) {
    // 灏濊瘯瑙ｆ瀽 CBOR 鏍煎紡鐨勯敊璇搷搴?    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
      if (errorData.__type && errorData.message) {
        // 鎻愬彇閿欒绫诲瀷鍚嶇О锛堝幓鎺夊懡鍚嶇┖闂达級
        const errorType = errorData.__type.split('#').pop() || errorData.__type
        // 鍦ㄩ敊璇秷鎭腑鍖呭惈 HTTP 鐘舵€佺爜锛屼究浜庡皝绂佹娴?        errorMessage = `HTTP ${response.status}: ${errorType}: ${errorData.message}`
      } else if (errorData.message) {
        errorMessage = `HTTP ${response.status}: ${errorData.message}`
      }
      console.error(`[Kiro API] Error:`, errorData)
    } catch {
      // 濡傛灉 CBOR 瑙ｆ瀽澶辫触锛屾樉绀哄師濮嬪唴瀹?      const errorText = Buffer.from(errorBuffer).toString('utf-8')
      console.error(`[Kiro API] Error (raw): ${errorText}`)
    }
    throw new Error(errorMessage)
  }

  const arrayBuffer = await response.arrayBuffer()
  const result = decode(Buffer.from(arrayBuffer)) as T
  // 绮剧畝鍝嶅簲鏃ュ織锛氫竴琛屾憳瑕?+ 瀹屾暣鏁版嵁鏀?data锛堚摌 灞曞紑锛?  const r = result as Record<string, unknown>
  const resSummary = r.email ? `${r.email} [${r.status || 'ok'}]` : `${response.status}`
  console.log(`[Kiro API] ${operation} [${logTag}] 鈫?${resSummary}`, result)
  return result
}

// ============ GetUsageLimits REST API (瀹樻柟鏍煎紡) ============
interface UsageLimitsResponse {
  // REST API 瀹為檯杩斿洖 usageBreakdownList锛堜笉鏄?usageBreakdowns锛?  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageCharges?: number
    currentOverages?: number
    freeTrialUsage?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
    // REST API 鐩存帴杩斿洖 freeTrialInfo锛堜笌 freeTrialUsage 缁撴瀯鐩稿悓锛?    freeTrialInfo?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number | string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      description?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: number | string  // REST API 杩斿洖鏁板瓧鏃堕棿鎴?      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string  // Unix 鏃堕棿鎴筹紙绉掞級鎴?ISO 瀛楃涓?  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

// 杈呭姪鍑芥暟锛氬皢 Unix 鏃堕棿鎴筹紙绉掞級鎴?ISO 瀛楃涓茶浆鎹负 ISO 瀛楃涓?function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix 鏃堕棿鎴筹紙绉掞級锛岃浆鎹负姣鍚庡垱寤?Date
    return new Date(value * 1000).toISOString()
  }
  return value
}

async function fetchRestApi(
  baseUrl: string,
  path: string,
  accessToken: string,
  machineId?: string
): Promise<Response> {
  const agent = getKProxyAgent()
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': getKiroUserAgent(machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(machineId)
  }
  const url = `${baseUrl}${path}`
  if (agent) {
    return await undiciFetch(url, {
      method: 'GET',
      headers,
      dispatcher: agent
    } as UndiciRequestInit) as unknown as Response
  }
  return await fetchWithAppProxy(url, { method: 'GET', headers })
}

async function getUsageLimitsRest(
  accessToken: string,
  profileArn?: string,
  accountMachineId?: string,  // 璐︽埛缁戝畾鐨勮澶?ID
  ssoRegion?: string,         // SSO 鍖哄煙锛岀敤浜庨€夋嫨姝ｇ‘鐨?REST API 绔偣
  email?: string              // 鐢ㄤ簬鏃ュ織鏍囪瘑
): Promise<UsageLimitsResponse> {
  // 浼樺厛浣跨敤璐︽埛缁戝畾鐨勮澶?ID锛屽叾娆′娇鐢?K-Proxy 鍏ㄥ眬璁惧 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)
  
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) {
    params.set('profileArn', profileArn)
  }
  const path = `/getUsageLimits?${params.toString()}`
  
  // 鏍规嵁 SSO 鍖哄煙閫夋嫨涓荤鐐?  const primaryBase = getRestApiBase(ssoRegion)
  const fallbackBase = getFallbackRestApiBase(ssoRegion)
  
  let response = await fetchRestApi(primaryBase, path, accessToken, machineId)
  
  // 濡傛灉涓荤鐐硅繑鍥?403锛屽皾璇曞鐢ㄧ鐐?  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback 鈫?${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, accessToken, machineId)
  }
  
  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }
  
  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] 鈫?${response.status}`, result)
  return result
}

// 缁熶竴鐨勭敤閲忔煡璇㈡帴鍙?- 鏍规嵁閰嶇疆閫夋嫨 API 绫诲瀷
interface UnifiedUsageResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    type?: string
    freeTrialInfo?: {
      freeTrialStatus?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialExpiry?: string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string
      status?: string
    }>
  }>
  nextDateReset?: string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

async function getUsageAndLimits(
  accessToken: string,
  idp: string = 'BuilderId',
  profileArn?: string,
  accountMachineId?: string,  // 璐︽埛缁戝畾鐨勮澶?ID
  ssoRegion?: string,         // SSO 鍖哄煙锛岀敤浜庨€夋嫨姝ｇ‘鐨?REST API 绔偣
  email?: string              // 鐢ㄤ簬鏃ュ織鏍囪瘑
): Promise<UnifiedUsageResponse> {
  if (currentUsageApiType === 'rest') {
    // 浣跨敤 REST API (GetUsageLimits)
    const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email)
    // REST API 杩斿洖鐨勫瓧娈靛悕鍜?CBOR API 鐩稿悓锛岀洿鎺ヨ繑鍥?    return {
      usageBreakdownList: result.usageBreakdownList?.map(b => ({
        resourceType: b.resourceType || b.type,
        displayName: b.displayName,
        displayNamePlural: b.displayNamePlural,
        currentUsage: b.currentUsage,
        currentUsageWithPrecision: b.currentUsageWithPrecision,
        usageLimit: b.usageLimit,
        usageLimitWithPrecision: b.usageLimitWithPrecision,
        currency: b.currency,
        unit: b.unit,
        overageRate: b.overageRate,
        overageCap: b.overageCap,
        type: b.type,
        // REST API 鐩存帴杩斿洖 freeTrialInfo锛孋BOR API 杩斿洖 freeTrialUsage
        freeTrialInfo: b.freeTrialInfo ? {
          freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
          usageLimit: b.freeTrialInfo.usageLimit,
          usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
          currentUsage: b.freeTrialInfo.currentUsage,
          currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
          // REST API 杩斿洖鏁板瓧鏃堕棿鎴筹紝闇€瑕佽浆鎹负 ISO 瀛楃涓?          freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
            ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
            : b.freeTrialInfo.freeTrialExpiry
        } : (b.freeTrialUsage ? {
          freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
          usageLimit: b.freeTrialUsage.usageLimit,
          usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
          currentUsage: b.freeTrialUsage.currentUsage,
          currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
          freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
        } : undefined),
        // 杞崲 bonuses 涓殑鏃堕棿鎴充负 ISO 瀛楃涓?        bonuses: b.bonuses?.map(bonus => ({
          ...bonus,
          expiresAt: typeof bonus.expiresAt === 'number' 
            ? new Date(bonus.expiresAt * 1000).toISOString() 
            : bonus.expiresAt
        }))
      })),
      // REST API 杩斿洖鐨?nextDateReset 鏄?Unix 鏃堕棿鎴筹紙绉掞級锛岄渶瑕佽浆鎹负 ISO 瀛楃涓?      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    }
  } else {
    // 浣跨敤 CBOR API (GetUserUsageAndLimits)
    // CBOR API (app.kiro.dev) 鏄綉椤电闂ㄦ埛锛屼粎鏀寔 BuilderId 璁よ瘉
    // Enterprise/IdC 璐﹀彿鍙兘杩斿洖 401锛岄渶瑕?fallback 鍒?REST API
    try {
      return await kiroApiRequest<UnifiedUsageResponse>(
        'GetUserUsageAndLimits',
        { isEmailRequired: true, origin: 'KIRO_IDE' },
        accessToken,
        idp,
        accountMachineId,
        email
      )
    } catch (cborError) {
      const errorMsg = cborError instanceof Error ? cborError.message : ''
      // CBOR 401/403 鏃惰嚜鍔?fallback 鍒?REST API
      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`)
        const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email)
        return {
          usageBreakdownList: result.usageBreakdownList?.map(b => ({
            resourceType: b.resourceType || b.type,
            displayName: b.displayName,
            displayNamePlural: b.displayNamePlural,
            currentUsage: b.currentUsage,
            currentUsageWithPrecision: b.currentUsageWithPrecision,
            usageLimit: b.usageLimit,
            usageLimitWithPrecision: b.usageLimitWithPrecision,
            currency: b.currency,
            unit: b.unit,
            overageRate: b.overageRate,
            overageCap: b.overageCap,
            type: b.type,
            freeTrialInfo: b.freeTrialInfo ? {
              freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
              usageLimit: b.freeTrialInfo.usageLimit,
              usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
              currentUsage: b.freeTrialInfo.currentUsage,
              currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
              freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
                ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString() 
                : b.freeTrialInfo.freeTrialExpiry
            } : (b.freeTrialUsage ? {
              freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
              usageLimit: b.freeTrialUsage.usageLimit,
              usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
              currentUsage: b.freeTrialUsage.currentUsage,
              currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
              freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
            } : undefined),
            bonuses: b.bonuses?.map(bonus => ({
              ...bonus,
              expiresAt: typeof bonus.expiresAt === 'number' 
                ? new Date(bonus.expiresAt * 1000).toISOString() 
                : bonus.expiresAt
            }))
          })),
          nextDateReset: normalizeResetDate(result.nextDateReset as unknown as number | string),
          subscriptionInfo: result.subscriptionInfo,
          overageConfiguration: result.overageConfiguration,
          userInfo: result.userInfo
        }
      }
      throw cborError
    }
  }
}

// GetUserInfo API - 鍙渶瑕?accessToken 鍗冲彲璋冪敤
interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

async function getUserInfo(accessToken: string, idp: string = 'BuilderId', accountMachineId?: string, email?: string): Promise<UserInfoResponse> {
  return kiroApiRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, accountMachineId, email)
}

// 瀹氫箟鑷畾涔夊崗璁?const PROTOCOL_PREFIX = 'kiro'

// electron-store 瀹炰緥锛堝欢杩熷垵濮嬪寲锛?let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// 鏈€鍚庝繚瀛樼殑鏁版嵁锛堢敤浜庡穿婧冩仮澶嶏級
let lastSavedData: unknown = null

async function initStore(): Promise<void> {
  if (store) return
  const Store = (await import('electron-store')).default
  const fs = await import('fs/promises')
  const path = await import('path')
  
  const storeInstance = new Store({
    name: 'kiro-accounts',
    encryptionKey: 'kiro-account-manager-secret-key'
  })
  
  store = storeInstance as unknown as typeof store
  
  // 灏濊瘯浠庡浠芥仮澶嶆暟鎹紙濡傛灉涓绘暟鎹崯鍧忥級
  try {
    const backupPath = path.join(path.dirname(storeInstance.path), 'kiro-accounts.backup.json')
    const mainData = storeInstance.get('accountData')
    
    if (!mainData) {
      // 涓绘暟鎹笉瀛樺湪鎴栨崯鍧忥紝灏濊瘯浠庡浠芥仮澶?      try {
        const backupContent = await fs.readFile(backupPath, 'utf-8')
        const backupData = JSON.parse(backupContent)
        if (backupData && backupData.accounts) {
          console.log('[Store] Restoring data from backup...')
          storeInstance.set('accountData', backupData)
          console.log('[Store] Data restored from backup successfully')
        }
      } catch {
        // 澶囦唤涔熶笉瀛樺湪锛屽拷鐣?      }
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }
}

// 鍒涘缓鏁版嵁澶囦唤
async function createBackup(data: unknown): Promise<void> {
  if (!store) return
  
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const backupPath = path.join(path.dirname(store.path), 'kiro-accounts.backup.json')
    
    await fs.writeFile(backupPath, JSON.stringify(data, null, 2), 'utf-8')
    console.log('[Backup] Data backup created')
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error)
  }
}

let mainWindow: BrowserWindow | null = null

// ============ 鎵樼洏鐩稿叧鍙橀噺 ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // 鏍囪鏄惁鐪熸閫€鍑哄簲鐢?
// ============ 鍏ㄥ眬蹇嵎閿缃?============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// 鍔犺浇蹇嵎閿缃?async function loadShortcutSettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('showWindowShortcut') as string | undefined
    if (saved) {
      showWindowShortcut = saved
    }
  } catch (error) {
    console.error('[Shortcut] Failed to load shortcut settings:', error)
  }
}

// 淇濆瓨蹇嵎閿缃?async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// 娉ㄥ唽鏄剧ず涓荤獥鍙ｇ殑蹇嵎閿?function registerShowWindowShortcut(): void {
  // 鍏堟敞閿€鎵€鏈夊凡娉ㄥ唽鐨勫揩鎹烽敭
  globalShortcut.unregisterAll()
  
  if (!showWindowShortcut) return
  
  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: 鏄剧ず绐楀彛鏃舵仮澶?Dock 鍥炬爣
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`)
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`)
    }
  } catch (error) {
    console.error('[Shortcut] Error registering shortcut:', error)
  }
}
let currentProxyAccount: { id: string; email: string; idp: string; status: string; subscription?: string; usage?: { usedCredits: number; totalCredits: number; totalRequests: number; successRequests: number; failedRequests: number } } | null = null
let allAccounts: { id: string; email: string; idp: string; status: string }[] = []

// 鍔犺浇鎵樼洏璁剧疆
async function loadTraySettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('traySettings') as TraySettings | undefined
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved }
    }
  } catch (error) {
    console.error('[Tray] Failed to load tray settings:', error)
  }
}

// 淇濆瓨鎵樼洏璁剧疆
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// 鍒濆鍖栨墭鐩?function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        // macOS: 鏄剧ず绐楀彛鏃舵仮澶?Dock 鍥炬爣
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send('tray-refresh-account')
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send('tray-switch-account')
    },
    onToggleProxy: async () => {
      const server = initProxyServer()
      if (server.isRunning()) {
        server.stop()
      } else {
        await server.start()
      }
      updateTrayMenu()
    },
    getProxyStatus: () => {
      const server = initProxyServer()
      return {
        running: server.isRunning(),
        port: server.getConfig().port
      }
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts,
    getProxyStats: () => {
      const server = initProxyServer()
      const stats = server.getStats()
      return {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests
      }
    },
    getSessionStats: () => {
      const server = initProxyServer()
      return server.getSessionStats()
    }
  })

  // 璁剧疆鍒濆鎻愮ず
  setTrayTooltip(`Kiro 璐﹀彿绠＄悊鍣?v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `Kiro 璐﹀彿绠＄悊鍣?v${app.getVersion()}`,
    width: 1280,   // 鍒氬ソ瀹圭撼 3 鍒楀崱鐗?(340*3 + 16*2 + 杈硅窛)
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 鑷畾涔?titlebar锛歮ac 淇濈暀绾㈢豢榛勭伅 + 闅愯棌鏍囬鏍忥紱win/linux 瀹屽叏鏃?frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // 涓嶉€忔槑绐楀彛锛堝叧闂€忔槑 + Mica/Vibrancy 閬垮厤妗岄潰鍏冪礌骞叉壈锛?    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ============ 鑷畾涔?titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // 璁剧疆甯︾増鏈彿鐨勬爣棰橈紙HTML 鍔犺浇鍚庝細瑕嗙洊鍒濆鏍囬锛?    mainWindow?.setTitle(`Kiro 璐﹀彿绠＄悊鍣?v${app.getVersion()}`)
    mainWindow?.show()
    
    // 妫€鏌ヤ唬鐞嗘湇鍔¤嚜鍚姩閰嶇疆
    setTimeout(async () => {
      try {
        await initStore()
        if (!store) return
        
        const savedProxyConfig = store.get('proxyConfig') as ProxyConfig | undefined
        if (!savedProxyConfig?.autoStart) return
        
        console.log('[ProxyServer] Auto-starting proxy server...')
        const server = initProxyServer()
        server.updateConfig(savedProxyConfig)
        
        // 鑷惎鍔ㄦ椂鍚屾璐﹀彿鍒颁唬鐞嗘睜锛堝惈閲嶈瘯鏈哄埗搴斿鍐峰惎鍔ㄦ暟鎹欢杩燂級
        const syncAccountsToPool = (): number => {
          const accountData = store!.get('accountData') as { accounts?: Record<string, any> } | undefined
          if (!accountData?.accounts) return 0
          const proxyAccounts = Object.values(accountData.accounts)
            .filter((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
            .map((acc: any) => ({
              id: acc.id,
              email: acc.email,
              accessToken: acc.credentials.accessToken,
              refreshToken: acc.credentials?.refreshToken,
              profileArn: acc.profileArn,
              expiresAt: acc.credentials?.expiresAt,
              machineId: acc.machineId,
              clientId: acc.credentials?.clientId,
              clientSecret: acc.credentials?.clientSecret,
              region: acc.credentials?.region || 'us-east-1',
              authMethod: acc.credentials?.authMethod,
              provider: acc.credentials?.provider || acc.idp
            }))
          if (proxyAccounts.length > 0) {
            const pool = server.getAccountPool()
            pool.clear()
            proxyAccounts.forEach(acc => pool.addAccount(acc))
          }
          return proxyAccounts.length
        }

        let syncedCount = syncAccountsToPool()
        if (syncedCount > 0) {
          console.log('[ProxyServer] Auto-synced', syncedCount, 'accounts')
        } else {
          // 鍐峰惎鍔ㄦ椂 store 鍙兘杩樻病鏈夋暟鎹紙娓叉煋杩涚▼灏氭湭鍒濆鍖栧畬鎴愶級锛屽欢杩熼噸璇?          console.log('[ProxyServer] No accounts found on initial sync, will retry...')
          const retrySync = (attempt: number) => {
            setTimeout(() => {
              const count = syncAccountsToPool()
              if (count > 0) {
                console.log(`[ProxyServer] Retry #${attempt}: synced ${count} accounts`)
              } else if (attempt < 5) {
                retrySync(attempt + 1)
              } else {
                console.log('[ProxyServer] All retry attempts exhausted, no accounts available. Accounts will sync when UI loads.')
              }
            }, attempt * 2000) // 2s, 4s, 6s, 8s, 10s
          }
          retrySync(1)
        }
        
        await server.start()
        console.log('[ProxyServer] Auto-started successfully on port', savedProxyConfig.port || 5580)
      } catch (error) {
        console.error('[ProxyServer] Auto-start failed:', error)
      }

      // K-Proxy MITM 鑷惎鍔?      try {
        const savedKProxyConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
        if (savedKProxyConfig?.autoStart) {
          console.log('[KProxy] Auto-starting K-Proxy MITM...')
          const service = initKProxyService(savedKProxyConfig, {
            onRequest: (info) => {
              mainWindow?.webContents.send('kproxy-request', info)
            },
            onResponse: (info) => {
              mainWindow?.webContents.send('kproxy-response', info)
            },
            onError: (error) => {
              console.error('[KProxy] Error:', error)
              mainWindow?.webContents.send('kproxy-error', error.message)
            },
            onStatusChange: (running, port) => {
              mainWindow?.webContents.send('kproxy-status-change', { running, port })
            },
            onMitmIntercept: (host, modified) => {
              mainWindow?.webContents.send('kproxy-mitm', { host, modified })
            }
          })
          await service.initialize()
          await service.start()
          console.log('[KProxy] Auto-started successfully')
        }
      } catch (error) {
        console.error('[KProxy] Auto-start failed:', error)
      }
    }, 1000)
  })

  mainWindow.on('close', (event) => {
    // 鎵樼洏鏈€灏忓寲閫昏緫 - 蹇呴』鍚屾妫€鏌ュ苟璋冪敤 preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // 鐩存帴鏈€灏忓寲鍒版墭鐩?        event.preventDefault()
        mainWindow?.hide()
        // macOS: 闅愯棌绐楀彛鏃堕殣钘?Dock 鍥炬爣
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // 璇㈤棶鐢ㄦ埛 - 鍏堥樆姝㈠叧闂紝鍐嶅紓姝ュ鐞?        event.preventDefault()
        // 閫氱煡娓叉煋杩涚▼鏄剧ず鑷畾涔夊璇濇
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' 鏃剁户缁叧闂祦绋?    }

    // 绐楀彛鍏抽棴鍓嶄繚瀛樻暟鎹紙鍚屾淇濆瓨锛屼笉绛夊緟澶囦唤锛?    if (lastSavedData && store) {
      try {
        console.log('[Window] Saving data before close...')
        store.set('accountData', lastSavedData)
        // 澶囦唤寮傛杩涜锛屼笉闃诲鍏抽棴
        createBackup(lastSavedData).then(() => {
          console.log('[Window] Backup created')
        }).catch(err => {
          console.error('[Window] Backup failed:', err)
        })
        console.log('[Window] Data saved successfully')
      } catch (error) {
        console.error('[Window] Failed to save data:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 娉ㄥ唽鑷畾涔夊崗璁?function registerProtocol(): void {
  // 鍏堟敞閿€鏃х殑娉ㄥ唽锛堥槻姝笂娆″紓甯搁€€鍑烘湭娉ㄩ攢锛?  unregisterProtocol()
  
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        join(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// 娉ㄩ攢鑷畾涔夊崗璁?(搴旂敤閫€鍑烘椂璋冪敤)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [
        join(process.argv[1])
      ])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// 澶勭悊鍗忚 URL (鐢ㄤ簬 OAuth 鍥炶皟)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 澶勭悊 auth 鍥炶皟
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // 鍒濆鍖栨棩蹇楃郴缁燂紙灏芥棭鎷︽埅锛岀‘淇濇墍鏈?console 杈撳嚭閮借繘鍏ユ棩蹇楀瓨鍌級
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()

  // 娉ㄥ唽鑷畾涔夊崗璁?  registerProtocol()

  // 鍔犺浇鎵樼洏璁剧疆骞跺垵濮嬪寲鎵樼洏
  await loadTraySettings()
  autoUpdateOnStartup = (store?.get('autoUpdateOnStartup') as boolean | undefined) ?? AUTO_UPDATE_ON_STARTUP
  initTray()

  // 鍒濆鍖栬嚜鍔ㄦ洿鏂帮紙浠呯敓浜х幆澧冿級
  if (!is.dev) {
    setupAutoUpdater()
    // 鍚姩鍚庡欢杩熸鏌ユ洿鏂?    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(console.error)
    }, 3000)
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.kiro.account-manager')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: 鎵撳紑澶栭儴閾炬帴
  ipcMain.on('open-external', (_event, url: string, usePrivateMode?: boolean) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (usePrivateMode) {
        openBrowserInPrivateMode(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  // ============ 娉ㄥ唽鍔熻兘 IPC ============
  registerRegistrationHandlers(() => mainWindow)

  // ============ 鎵樼洏鐩稿叧 IPC ============

  // IPC: 鑾峰彇鎵樼洏璁剧疆
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // ============ 鑷畾涔?titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: 鑾峰彇鏄剧ず涓荤獥鍙ｅ揩鎹烽敭
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: 获取自动更新启动检查开关
  ipcMain.handle('get-auto-update-on-startup', () => {
    return autoUpdateOnStartup
  })

  // IPC: 设置自动更新启动检查开关
  ipcMain.handle('set-auto-update-on-startup', async (_event, enabled: boolean) => {
    try {
      autoUpdateOnStartup = !!enabled
      store?.set('autoUpdateOnStartup', autoUpdateOnStartup)
      return { success: true, enabled: autoUpdateOnStartup }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 璁剧疆鏄剧ず涓荤獥鍙ｅ揩鎹烽敭
  ipcMain.handle('set-show-window-shortcut', async (_event, shortcut: string) => {
    try {
      showWindowShortcut = shortcut
      await saveShortcutSettings()
      registerShowWindowShortcut()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // IPC: 淇濆瓨鎵樼洏璁剧疆
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()
      
      // 鏍规嵁璁剧疆鍚敤/绂佺敤鎵樼洏
      if (settings.enabled !== undefined) {
        if (settings.enabled) {
          initTray()
        } else {
          destroyTray()
        }
      }
      
      return { success: true }
    } catch (error) {
      console.error('[Tray] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 鏇存柊鎵樼洏璐︽埛淇℃伅锛堜粠娓叉煋杩涚▼璋冪敤锛?  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)
    
    // 鏇存柊鎵樼洏鎻愮ず
    if (account) {
      setTrayTooltip(`Kiro 璐﹀彿绠＄悊鍣╘n褰撳墠璐︽埛: ${account.email}`)
    } else {
      setTrayTooltip(`Kiro 璐﹀彿绠＄悊鍣?v${app.getVersion()}`)
    }
  })

  // IPC: 鏇存柊鎵樼洏璐︽埛鍒楄〃锛堜粠娓叉煋杩涚▼璋冪敤锛?  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: 鍒锋柊鎵樼洏鑿滃崟
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: 鏇存柊鎵樼洏璇█
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    updateTrayLanguage(language)
  })

  // IPC: 鍏抽棴纭瀵硅瘽妗嗗搷搴?  ipcMain.on('close-confirm-response', (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
    if (action === 'minimize') {
      mainWindow?.hide()
      // macOS: 闅愯棌绐楀彛鏃堕殣钘?Dock 鍥炬爣
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide()
      }
    } else if (action === 'quit') {
      // 濡傛灉鐢ㄦ埛閫夋嫨璁颁綇閫夋嫨
      if (rememberChoice) {
        traySettings.closeAction = 'quit'
        saveTraySettings()
      }
      isQuitting = true
      app.quit()
    }
    // cancel 鏃朵笉鍋氫换浣曟搷浣?    
    // 濡傛灉鐢ㄦ埛閫夋嫨璁颁綇"鏈€灏忓寲"閫夋嫨
    if (action === 'minimize' && rememberChoice) {
      traySettings.closeAction = 'minimize'
      saveTraySettings()
    }
  })

  // IPC: 鑾峰彇搴旂敤鐗堟湰
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: 妫€鏌ユ洿鏂?  ipcMain.handle('check-for-updates', async () => {
    if (is.dev) {
      return { hasUpdate: false, message: '寮€鍙戠幆澧冧笉鏀寔鏇存柊妫€鏌? }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        hasUpdate: !!result?.updateInfo,
        version: result?.updateInfo?.version,
        releaseDate: result?.updateInfo?.releaseDate
      }
    } catch (error) {
      console.error('[AutoUpdater] Check failed:', error)
      return { hasUpdate: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 涓嬭浇鏇存柊
  ipcMain.handle('download-update', async () => {
    if (is.dev) {
      return { success: false, message: '寮€鍙戠幆澧冧笉鏀寔鏇存柊' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 瀹夎鏇存柊骞堕噸鍚?  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // IPC: 鎵嬪姩妫€鏌ユ洿鏂帮紙浣跨敤 GitHub API锛岀敤浜?AboutPage锛?  const GITHUB_REPO = 'chaogei/Kiro-account-manager'
  const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  
  ipcMain.handle('check-for-updates-manual', async () => {
    try {
      console.log('[Update] Manual check via GitHub API...')
      const currentVersion = app.getVersion()
      
      const response = await fetchWithAppProxy(GITHUB_API_URL, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Kiro-Account-Manager'
        }
      })
      
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('GitHub API 璇锋眰娆℃暟瓒呴檺锛岃绋嶅悗鍐嶈瘯')
        } else if (response.status === 404) {
          throw new Error('鏈壘鍒板彂甯冪増鏈?)
        }
        throw new Error(`GitHub API 閿欒: ${response.status}`)
      }
      
      const release = await response.json() as {
        tag_name: string
        name: string
        body: string
        html_url: string
        published_at: string
        assets: Array<{
          name: string
          browser_download_url: string
          size: number
        }>
      }
      
      const latestVersion = release.tag_name.replace(/^v/, '')
      
      // 姣旇緝鐗堟湰鍙?      const compareVersions = (v1: string, v2: string): number => {
        const parts1 = v1.split('.').map(Number)
        const parts2 = v2.split('.').map(Number)
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
          const p1 = parts1[i] || 0
          const p2 = parts2[i] || 0
          if (p1 > p2) return 1
          if (p1 < p2) return -1
        }
        return 0
      }
      
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      
      console.log(`[Update] Current: ${currentVersion}, Latest: ${latestVersion}, HasUpdate: ${hasUpdate}`)
      
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseNotes: release.body || '',
        releaseName: release.name || `v${latestVersion}`,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        assets: release.assets.map(a => ({
          name: a.name,
          downloadUrl: a.browser_download_url,
          size: a.size
        }))
      }
    } catch (error) {
      console.error('[Update] Manual check failed:', error)
      return {
        hasUpdate: false,
        error: error instanceof Error ? error.message : '妫€鏌ユ洿鏂板け璐?
      }
    }
  })

  // IPC: 鍔犺浇璐﹀彿鏁版嵁
  ipcMain.handle('load-accounts', async () => {
    try {
      await initStore()
      return store!.get('accountData', null)
    } catch (error) {
      console.error('Failed to load accounts:', error)
      return null
    }
  })

  // IPC: 淇濆瓨璐﹀彿鏁版嵁
  ipcMain.handle('save-accounts', async (_event, data) => {
    try {
      await initStore()
      store!.set('accountData', data)
      
      // 淇濆瓨鏈€鍚庣殑鏁版嵁锛堢敤浜庡穿婧冩仮澶嶏級
      lastSavedData = data
      
      // 姣忔淇濆瓨鏃朵篃鍒涘缓澶囦唤
      await createBackup(data)
    } catch (error) {
      console.error('Failed to save accounts:', error)
      throw error
    }
  })

  // IPC: 鍒锋柊璐﹀彿 Token锛堟敮鎸?IdC 鍜岀ぞ浜ょ櫥褰曪級
  ipcMain.handle('refresh-account-token', async (_event, account) => {
    try {
      const { refreshToken, clientId, clientSecret, region, authMethod } = account.credentials || {}

      if (!refreshToken) {
        return { success: false, error: { message: '缂哄皯 Refresh Token' } }
      }

      // 绀句氦鐧诲綍鍙渶瑕?refreshToken锛孖dC 鐧诲綍闇€瑕?clientId 鍜?clientSecret
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: { message: '缂哄皯 OIDC 鍒锋柊鍑瘉 (clientId/clientSecret)' } }
      }

      console.log(`[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...`)

      // 鏍规嵁 authMethod 閫夋嫨鍒锋柊鏂瑰紡
      const refreshResult = await refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region || 'us-east-1',
        authMethod
      )

      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: { message: refreshResult.error || 'Token 鍒锋柊澶辫触' } }
      }

      return {
        success: true,
        data: {
          accessToken: refreshResult.accessToken,
          refreshToken: refreshResult.refreshToken || refreshToken,
          expiresIn: refreshResult.expiresIn ?? 3600
        }
      }
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 浠?SSO Token 瀵煎叆璐﹀彿 (x-amz-sso_authn)
  ipcMain.handle('import-from-sso-token', async (_event, bearerToken: string, region: string = 'us-east-1') => {
    console.log('[IPC] import-from-sso-token called')
    
    try {
      // 鎵ц SSO 璁惧鎺堟潈娴佺▼
      const ssoResult = await ssoDeviceAuth(bearerToken, region)
      
      if (!ssoResult.success || !ssoResult.accessToken) {
        return { success: false, error: { message: ssoResult.error || 'SSO 鎺堟潈澶辫触' } }
      }

      // 骞惰鑾峰彇鐢ㄦ埛淇℃伅鍜屼娇鐢ㄩ噺
      interface UsageBreakdownItem {
        resourceType?: string
        currentUsage?: number
        currentUsageWithPrecision?: number
        usageLimit?: number
        usageLimitWithPrecision?: number
        displayName?: string
        displayNamePlural?: string
        currency?: string
        unit?: string
        overageRate?: number
        overageCap?: number
        freeTrialInfo?: { currentUsage?: number; currentUsageWithPrecision?: number; usageLimit?: number; usageLimitWithPrecision?: number; freeTrialExpiry?: string; freeTrialStatus?: string }
        bonuses?: Array<{ bonusCode?: string; displayName?: string; currentUsage?: number; currentUsageWithPrecision?: number; usageLimit?: number; usageLimitWithPrecision?: number; expiresAt?: string }>
      }
      interface UsageApiResponse {
        userInfo?: { email?: string; userId?: string }
        subscriptionInfo?: { type?: string; subscriptionTitle?: string; upgradeCapability?: string; overageCapability?: string; subscriptionManagementTarget?: string }
        usageBreakdownList?: UsageBreakdownItem[]
        nextDateReset?: string
        overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
      }

      let userInfo: UserInfoResponse | undefined
      let usageData: UsageApiResponse | undefined

      try {
        console.log('[SSO] Fetching user info and usage data...')
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(ssoResult.accessToken).catch(e => { console.error('[SSO] getUserInfo failed:', e); return undefined }),
          getUsageAndLimits(ssoResult.accessToken, 'BuilderId', undefined, undefined, region).catch(e => { console.error('[SSO] getUsageAndLimits failed:', e); return undefined })
        ])
        userInfo = userInfoResult
        usageData = usageResult
        console.log('[SSO] userInfo:', userInfo?.email)
        console.log('[SSO] usageData:', usageData?.subscriptionInfo?.subscriptionTitle)
      } catch (e) {
        console.error('[IPC] API calls failed:', e)
      }

      // 瑙ｆ瀽浣跨敤閲忔暟鎹?      const creditUsage = usageData?.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'
      
      // 瑙勮寖鍖栬闃呯被鍨嬶紙娉ㄦ剰妫€鏌ラ『搴忥細鍏堟鏌ユ洿鍏蜂綋鐨勭被鍨嬶級
      let subscriptionType = 'Free'
      const titleUpper = subscriptionTitle.toUpperCase()
      if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
        subscriptionType = 'Pro_Plus'
      } else if (titleUpper.includes('POWER')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (titleUpper.includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 鍩虹棰濆害锛堜娇鐢ㄧ簿纭皬鏁帮級
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

      // 璇曠敤棰濆害锛堜娇鐢ㄧ簿纭皬鏁帮級
      let freeTrialLimit = 0, freeTrialCurrent = 0, freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 濂栧姳棰濆害锛堜娇鐢ㄧ簿纭皬鏁帮級
      const bonuses = (creditUsage?.bonuses || []).map(b => ({
        code: b.bonusCode || '',
        name: b.displayName || '',
        current: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
        limit: b.usageLimitWithPrecision ?? b.usageLimit ?? 0,
        expiresAt: b.expiresAt
      }))

      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
      const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

      return {
        success: true,
        data: {
          accessToken: ssoResult.accessToken,
          refreshToken: ssoResult.refreshToken,
          clientId: ssoResult.clientId,
          clientSecret: ssoResult.clientSecret,
          region: ssoResult.region,
          expiresIn: ssoResult.expiresIn,
          email: usageData?.userInfo?.email || userInfo?.email,
          userId: usageData?.userInfo?.userId || userInfo?.userId,
          idp: userInfo?.idp || 'BuilderId',
          status: userInfo?.status,
          subscriptionType,
          subscriptionTitle,
          subscription: {
            managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
            upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
            overageCapability: usageData?.subscriptionInfo?.overageCapability
          },
          usage: {
            current: totalCurrent,
            limit: totalLimit,
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses,
            nextResetDate: usageData?.nextDateReset,
            resourceDetail: creditUsage ? {
              displayName: creditUsage.displayName,
              displayNamePlural: creditUsage.displayNamePlural,
              resourceType: creditUsage.resourceType,
              currency: creditUsage.currency,
              unit: creditUsage.unit,
              overageRate: creditUsage.overageRate,
              overageCap: creditUsage.overageCap,
              overageEnabled: usageData?.overageConfiguration?.overageStatus === 'ENABLED' || usageData?.overageConfiguration?.overageEnabled === true
            } : undefined
          },
          daysRemaining: usageData?.nextDateReset ? Math.max(0, Math.ceil((new Date(usageData.nextDateReset).getTime() - Date.now()) / 86400000)) : undefined
        }
      }
    } catch (error) {
      console.error('[IPC] import-from-sso-token error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 妫€鏌ヨ处鍙风姸鎬侊紙鏀寔鑷姩鍒锋柊 Token锛?  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      status?: string
      expiresAt?: string  // API 杩斿洖鐨勬槸 expiresAt
    }

    interface FreeTrialInfo {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }

    interface UsageBreakdown {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      bonuses?: Bonus[]
      freeTrialInfo?: FreeTrialInfo
    }

    interface SubscriptionInfo {
      subscriptionTitle?: string
      type?: string
      upgradeCapability?: string
      overageCapability?: string
      subscriptionManagementTarget?: string
    }

    interface UserInfo {
      email?: string
      userId?: string
    }

    interface OverageConfiguration {
      overageEnabled?: boolean
      overageStatus?: string
    }

    interface UsageResponse {
      daysUntilReset?: number
      nextDateReset?: string
      usageBreakdownList?: UsageBreakdown[]
      overageConfiguration?: OverageConfiguration
      subscriptionInfo?: SubscriptionInfo
      userInfo?: UserInfo
    }

    // 瑙ｆ瀽 API 鍝嶅簲鐨勮緟鍔╁嚱鏁?    const parseUsageResponse = (result: UsageResponse, newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresIn?: number
    }, userInfo?: UserInfoResponse) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || 'unknown'}]`, result)

      // 瑙ｆ瀽 Credits 浣跨敤閲忥紙resourceType 涓?CREDIT锛?      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // 瑙ｆ瀽浣跨敤閲忥紙璇︾粏锛屼娇鐢ㄧ簿纭皬鏁帮級
      // 鍩虹棰濆害
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // 璇曠敤棰濆害
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // 濂栧姳棰濆害
      const bonusesData: { code: string; name: string; current: number; limit: number; expiresAt?: string }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonusesData.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }
      
      // 璁＄畻鎬婚搴?      const totalLimit = baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      const nextResetDate = result.nextDateReset

      // 瑙ｆ瀽璁㈤槄绫诲瀷
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 瑙ｆ瀽閲嶇疆鏃堕棿骞惰绠楀墿浣欏ぉ鏁?      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime()
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // 璧勬簮璇︽儏
      const resourceDetail = creditUsage ? {
        resourceType: creditUsage.resourceType,
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: result.overageConfiguration?.overageStatus === 'ENABLED' || result.overageConfiguration?.overageEnabled === true
      } : undefined

      return {
        success: true,
        data: {
          status: (!userInfo?.status || userInfo.status === 'Active' || userInfo.status === 'Stale') ? 'active' : 'error',
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // 濡傛灉鍒锋柊浜?token锛岃繑鍥炴柊鐨勫嚟璇?          newCredentials: newCredentials ? {
            accessToken: newCredentials.accessToken,
            refreshToken: newCredentials.refreshToken,
            expiresAt: newCredentials.expiresIn 
              ? Date.now() + newCredentials.expiresIn * 1000 
              : undefined
          } : undefined
        }
      }
    }

    try {
      const { accessToken, refreshToken, clientId, clientSecret, region, authMethod, provider } = account.credentials || {}
      
      // 纭畾姝ｇ‘鐨?idp锛氫紭鍏堜娇鐢?credentials.provider锛屽惁鍒欏洖閫€鍒?account.idp
      // 绀句氦鐧诲綍浣跨敤瀹為檯鐨?provider (Github/Google)锛孖dC 浣跨敤 BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!accessToken) {
        console.log('[IPC] Missing accessToken')
        return { success: false, error: { message: '缂哄皯 accessToken' } }
      }

      // 鑾峰彇璐︽埛缁戝畾鐨勮澶?ID
      const accountMachineId = account?.machineId as string | undefined

      // 绗竴娆″皾璇曪細浣跨敤褰撳墠 accessToken
      try {
        // 骞惰璋冪敤 GetUserInfo 鍜?getUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(accessToken, idp, accountMachineId, account?.email).catch((err: Error) => {
            // 灏佺閿欒涓嶈兘鍚炴帀锛屽繀椤诲悜涓婃姏鍑?            if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
              throw err
            }
            return undefined
          }),
          getUsageAndLimits(accessToken, idp, undefined, accountMachineId, region, account?.email)
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''
        
        // 妫€鏌ユ槸鍚︽槸鏄庣‘灏佺閿欒锛?23 鎴?AccountSuspendedException锛?        if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
          console.log('[IPC] Account suspended/banned')
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          }
        }
        
        // 妫€鏌ユ槸鍚︽槸 401 閿欒锛坱oken 杩囨湡锛?        // 绀句氦鐧诲綍鍙渶瑕?refreshToken锛孖dC 鐧诲綍闇€瑕?clientId 鍜?clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          console.log(`[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...`)
          
          // 灏濊瘯鍒锋柊 token - 鏍规嵁 authMethod 閫夋嫨鍒锋柊鏂瑰紡
          const refreshResult = await refreshTokenByMethod(
            refreshToken,
            clientId || '',
            clientSecret || '',
            region || 'us-east-1',
            authMethod
          )
          
          if (refreshResult.success && refreshResult.accessToken) {
            console.log('[IPC] Token refreshed, retrying API call...')
            
            // 鐢ㄦ柊 token 骞惰璋冪敤 GetUserInfo 鍜?getUsageAndLimits
            const [userInfoResult, usageResult] = await Promise.all([
              getUserInfo(refreshResult.accessToken, idp, accountMachineId).catch((err: Error) => {
                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return undefined
              }),
              getUsageAndLimits(refreshResult.accessToken, idp, undefined, accountMachineId, region)
            ])
            
            // 杩斿洖缁撴灉骞跺寘鍚柊鍑瘉
            return parseUsageResponse(usageResult, {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresIn: refreshResult.expiresIn
            }, userInfoResult)
          } else {
            console.error('[IPC] Token refresh failed:', refreshResult.error)
            return {
              success: false,
              error: { message: `Token 杩囨湡涓斿埛鏂板け璐? ${refreshResult.error}` }
            }
          }
        }
        
        // 涓嶆槸 401 鎴栨病鏈夊埛鏂板嚟璇侊紝鎶涘嚭鍘熼敊璇?        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 鍚庡彴鎵归噺鍒锋柊璐﹀彿锛堝湪涓昏繘绋嬫墽琛岋紝涓嶉樆濉?UI锛?  ipcMain.handle('background-batch-refresh', async (_event, accounts: Array<{
    id: string
    idp?: string
    needsTokenRefresh?: boolean
    machineId?: string  // 璐︽埛缁戝畾鐨勮澶?ID
    credentials: {
      refreshToken: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      accessToken?: string
      provider?: string
    }
  }>, concurrency: number = 10, syncInfo: boolean = true) => {
    console.log(`[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`)
    
    let completed = 0
    let success = 0
    let failed = 0

    // 涓茶澶勭悊姣忔壒锛岄伩鍏嶅苟鍙戣繃楂?    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)
      
      await Promise.allSettled(
        batch.map(async (account) => {
          try {
            const { refreshToken, clientId, clientSecret, region, authMethod, accessToken, provider } = account.credentials
            const needsTokenRefresh = account.needsTokenRefresh !== false // 榛樿涓?true锛堝吋瀹规棫鐗堟湰锛?            
            // 纭畾姝ｇ‘鐨?idp
            let idp = 'BuilderId'
            if (authMethod === 'social') {
              idp = provider || account.idp || 'BuilderId'
            } else if (provider) {
              idp = provider
            }
            
            let newAccessToken = accessToken
            let newRefreshToken = refreshToken
            let newExpiresIn: number | undefined

            // 鍙湁闇€瑕佸埛鏂?Token 鏃舵墠鍒锋柊
            if (needsTokenRefresh) {
              if (!refreshToken) {
                failed++
                completed++
                return
              }

              // 鍒锋柊 Token
              const refreshResult = await refreshTokenByMethod(
                refreshToken,
                clientId || '',
                clientSecret || '',
                region || 'us-east-1',
                authMethod
              )

              if (!refreshResult.success) {
                failed++
                completed++
                // 閫氱煡娓叉煋杩涚▼鍒锋柊澶辫触
                mainWindow?.webContents.send('background-refresh-result', {
                  id: account.id,
                  success: false,
                  error: refreshResult.error
                })
                return
              }

              newAccessToken = refreshResult.accessToken || accessToken
              newRefreshToken = refreshResult.refreshToken || refreshToken
              newExpiresIn = refreshResult.expiresIn
            }

            // 鑾峰彇璐﹀彿淇℃伅
            if (!newAccessToken) {
              failed++
              completed++
              return
            }

            // 鏍规嵁 syncInfo 鍐冲畾鏄惁妫€娴嬭处鎴蜂俊鎭?            let parsedUsage: {
              current: number
              limit: number
              baseCurrent: number
              baseLimit: number
              freeTrialCurrent: number
              freeTrialLimit: number
              freeTrialExpiry?: string
              bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
              nextResetDate?: string
              resourceDetail?: {
                displayName?: string
                displayNamePlural?: string
                resourceType?: string
                currency?: string
                unit?: string
                overageRate?: number
                overageCap?: number
                overageEnabled?: boolean
              }
            } | undefined
            let userInfoData: UserInfoResponse | undefined
            let subscriptionData: { type: string; title: string; daysRemaining?: number; expiresAt?: number; overageCapability?: string; upgradeCapability?: string; subscriptionManagementTarget?: string } | undefined
            let status = 'active'
            let errorMessage: string | undefined

            if (syncInfo) {
              // 璋冪敤 getUsageAndLimits API锛堟牴鎹厤缃€夋嫨 REST 鎴?CBOR 鏍煎紡锛?              try {
                interface UsageBreakdownItem {
                  resourceType?: string
                  displayName?: string
                  currentUsage?: number
                  currentUsageWithPrecision?: number
                  usageLimit?: number
                  usageLimitWithPrecision?: number
                  freeTrialInfo?: {
                    freeTrialStatus?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialExpiry?: string
                  }
                  bonuses?: Array<{
                    bonusCode?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    expiresAt?: string
                    status?: string
                  }>
                }
                interface UsageResponse {
                  usageBreakdownList?: UsageBreakdownItem[]
                  nextDateReset?: string
                  subscriptionInfo?: {
                    subscriptionTitle?: string
                    type?: string
                    overageCapability?: string
                    upgradeCapability?: string
                    subscriptionManagementTarget?: string
                  }
                  overageConfiguration?: {
                    overageStatus?: string
                    overageEnabled?: boolean
                    overageLimit?: number | null
                  }
                }
                console.log(`[BackgroundRefresh] Account ${account.id} machineId: ${account.machineId || 'undefined'}`)
                const rawUsage = await getUsageAndLimits(newAccessToken, idp, undefined, account.machineId, region) as UsageResponse
                
                // 瑙ｆ瀽浣跨敤閲忔暟鎹?                const creditUsage = rawUsage.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
                const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                let freeTrialCurrent = 0
                let freeTrialLimit = 0
                let freeTrialExpiry: string | undefined
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                  freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
                  freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                }
                const bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }> = []
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === 'ACTIVE') {
                      bonuses.push({
                        code: bonus.bonusCode || '',
                        name: bonus.displayName || '',
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      })
                    }
                  }
                }
                const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
                
                parsedUsage = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset,
                  resourceDetail: creditUsage ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: (creditUsage as { displayNamePlural?: string }).displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: (creditUsage as { currency?: string }).currency,
                    unit: (creditUsage as { unit?: string }).unit,
                    overageRate: (creditUsage as { overageRate?: number }).overageRate,
                    overageCap: (creditUsage as { overageCap?: number }).overageCap,
                    overageEnabled: rawUsage.overageConfiguration?.overageStatus === 'ENABLED' || rawUsage.overageConfiguration?.overageEnabled === true
                  } : undefined
                }
                
                // 瑙ｆ瀽璁㈤槄淇℃伅锛堟敞鎰忔鏌ラ『搴忥細鍏堟鏌ユ洿鍏蜂綋鐨勭被鍨嬶級
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle || 'Free'
                let subscriptionType = 'Free'
                const titleUpper = subscriptionTitle.toUpperCase()
                if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
                  subscriptionType = 'Pro_Plus'
                } else if (titleUpper.includes('POWER')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('PRO')) {
                  subscriptionType = 'Pro'
                } else if (titleUpper.includes('ENTERPRISE')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('TEAMS')) {
                  subscriptionType = 'Teams'
                }
                
                // 璁＄畻鍓╀綑澶╂暟鍜屽埌鏈熸椂闂?                let daysRemaining: number | undefined
                let expiresAt: number | undefined
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime()
                  daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
                }
                
                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
                }
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                console.log(`[BackgroundRefresh] Usage API error for ${account.id}:`, errMsg)
                if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }

              // 璋冪敤 GetUserInfo API 鑾峰彇鐢ㄦ埛鐘舵€?              try {
                userInfoData = await getUserInfo(newAccessToken, idp, account.machineId)
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }
            }

            success++
            completed++

            // 閫氱煡娓叉煋杩涚▼鏇存柊璐﹀彿
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: true,
              data: {
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
                expiresIn: newExpiresIn,
                usage: parsedUsage,
                subscription: subscriptionData,
                userInfo: syncInfo ? userInfoData : undefined,
                status,
                errorMessage
              }
            })
          } catch (e) {
            failed++
            completed++
            mainWindow?.webContents.send('background-refresh-result', {
              id: account.id,
              success: false,
              error: e instanceof Error ? e.message : 'Unknown error'
            })
          }
        })
      )

      // 閫氱煡杩涘害
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 鎵规闂村欢杩燂紝璁╀富杩涚▼鏈夊枠鎭椂闂?      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  })

  // IPC: 鍚庡彴鎵归噺妫€鏌ヨ处鍙风姸鎬侊紙涓嶅埛鏂?Token锛屽彧妫€鏌ョ姸鎬侊級
  ipcMain.handle('background-batch-check', async (_event, accounts: Array<{
    id: string
    email: string
    credentials: {
      accessToken: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      provider?: string
    }
    idp?: string
  }>, concurrency: number = 10) => {
    console.log(`[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`)
    
    let completed = 0
    let success = 0
    let failed = 0

    // 涓茶澶勭悊姣忔壒
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)
      
      await Promise.allSettled(
        batch.map(async (account) => {
          try {
            const { accessToken, authMethod, provider } = account.credentials
            
            if (!accessToken) {
              failed++
              completed++
              mainWindow?.webContents.send('background-check-result', {
                id: account.id,
                success: false,
                error: '缂哄皯 accessToken'
              })
              return
            }

            // 纭畾 idp
            let idp = account.idp || 'BuilderId'
            if (authMethod === 'social' && provider) {
              idp = provider
            }

            // 璋冪敤 API 鑾峰彇鐢ㄩ噺鍜岀敤鎴蜂俊鎭紙鏍规嵁閰嶇疆閫夋嫨 REST 鎴?CBOR 鏍煎紡锛?            const [usageRes, userInfoRes] = await Promise.allSettled([
              getUsageAndLimits(accessToken, idp, undefined, undefined, account.credentials?.region, account.email) as Promise<{
                usageBreakdownList?: Array<{
                  resourceType?: string
                  displayName?: string
                  usageLimit?: number
                  usageLimitWithPrecision?: number
                  currentUsage?: number
                  currentUsageWithPrecision?: number
                  freeTrialInfo?: {
                    freeTrialStatus?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialExpiry?: string
                  }
                  bonuses?: Array<{
                    bonusCode?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    expiresAt?: string
                    status?: string
                  }>
                }>
                nextDateReset?: string
                subscriptionInfo?: {
                  subscriptionTitle?: string
                  type?: string
                  overageCapability?: string
                  upgradeCapability?: string
                  subscriptionManagementTarget?: string
                }
                overageConfiguration?: {
                  overageStatus?: string
                  overageEnabled?: boolean
                  overageLimit?: number | null
                }
                userInfo?: {
                  email?: string
                  userId?: string
                }
              }>,
              kiroApiRequest<{
                email?: string
                userId?: string
                status?: string
                idp?: string
              }>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp, undefined, account.email).catch((err: Error) => {
                // 灏佺閿欒涓嶈兘鍚炴帀锛岄渶瑕佸湪鍚庣画閫昏緫涓娴?                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return null
              })
            ])

            // 瑙ｆ瀽鍝嶅簲锛坘iroApiRequest 鐩存帴杩斿洖鏁版嵁鎴栨姏鍑哄紓甯革級
            let usageData: {
              current: number
              limit: number
              baseCurrent?: number
              baseLimit?: number
              freeTrialCurrent?: number
              freeTrialLimit?: number
              freeTrialExpiry?: string
              bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
              nextResetDate?: string
            } | null = null
            let subscriptionData: {
              type: string
              title: string
              daysRemaining?: number
              expiresAt?: number
              overageCapability?: string
              upgradeCapability?: string
              subscriptionManagementTarget?: string
            } | null = null
            let resourceDetail: {
              displayName?: string
              displayNamePlural?: string
              resourceType?: string
              currency?: string
              unit?: string
              overageRate?: number
              overageCap?: number
              overageEnabled?: boolean
            } | undefined
            let userInfoData: {
              email?: string
              userId?: string
              status?: string
            } | null = null
            let status = 'active'
            let errorMessage: string | undefined

            // 澶勭悊鐢ㄩ噺鍝嶅簲
            if (usageRes.status === 'fulfilled') {
              const rawUsage = usageRes.value
              // 瑙ｆ瀽 Credits 浣跨敤閲忥紙鍜屽崟涓鏌ヤ竴鑷达級
              const creditUsage = rawUsage.usageBreakdownList?.find(
                (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
              )
              
              const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
              const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
              let freeTrialCurrent = 0
              let freeTrialLimit = 0
              let freeTrialExpiry: string | undefined
              if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
                freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
                freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
              }
              
              // 瑙ｆ瀽 bonuses
              const bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }> = []
              if (creditUsage?.bonuses) {
                for (const bonus of creditUsage.bonuses) {
                  if (bonus.status === 'ACTIVE') {
                    bonuses.push({
                      code: bonus.bonusCode || '',
                      name: bonus.displayName || '',
                      current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                      limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                      expiresAt: bonus.expiresAt
                    })
                  }
                }
              }
              
              const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
              const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
              
              usageData = {
                current: totalCurrent,
                limit: totalLimit,
                baseCurrent,
                baseLimit,
                freeTrialCurrent,
                freeTrialLimit,
                freeTrialExpiry,
                bonuses,
                nextResetDate: rawUsage.nextDateReset
              }

              // 瑙ｆ瀽璧勬簮璇︽儏锛堝惈瓒呴淇℃伅锛?              if (creditUsage) {
                resourceDetail = {
                  displayName: creditUsage.displayName,
                  displayNamePlural: (creditUsage as { displayNamePlural?: string }).displayNamePlural,
                  resourceType: creditUsage.resourceType,
                  currency: (creditUsage as { currency?: string }).currency,
                  unit: (creditUsage as { unit?: string }).unit,
                  overageRate: (creditUsage as { overageRate?: number }).overageRate,
                  overageCap: (creditUsage as { overageCap?: number }).overageCap,
                  overageEnabled: rawUsage.overageConfiguration?.overageStatus === 'ENABLED' || rawUsage.overageConfiguration?.overageEnabled === true
                }
              }

              // 瑙ｆ瀽璁㈤槄淇℃伅锛堟敞鎰忔鏌ラ『搴忥細鍏堟鏌ユ洿鍏蜂綋鐨勭被鍨嬶級
              const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle ?? 'Free'
              let subscriptionType = 'Free'
              const titleUpper = subscriptionTitle.toUpperCase()
              if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
                subscriptionType = 'Pro_Plus'
              } else if (titleUpper.includes('POWER')) {
                subscriptionType = 'Enterprise'
              } else if (titleUpper.includes('PRO')) {
                subscriptionType = 'Pro'
              } else if (titleUpper.includes('ENTERPRISE')) {
                subscriptionType = 'Enterprise'
              } else if (titleUpper.includes('TEAMS')) {
                subscriptionType = 'Teams'
              }
              
              // 璁＄畻鍓╀綑澶╂暟鍜屽埌鏈熸椂闂?              let daysRemaining: number | undefined
              let expiresAt: number | undefined
              if (rawUsage.nextDateReset) {
                expiresAt = new Date(rawUsage.nextDateReset).getTime()
                daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
              }
              
              subscriptionData = {
                type: subscriptionType,
                title: subscriptionTitle,
                daysRemaining,
                expiresAt,
                overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                subscriptionManagementTarget: rawUsage.subscriptionInfo?.subscriptionManagementTarget
              }
            } else if (usageRes.status === 'rejected') {
              // API 璋冪敤澶辫触锛堝彲鑳芥槸灏佺鎴?Token 杩囨湡锛?              const errorMsg = usageRes.reason?.message || String(usageRes.reason)
              console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
              if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
                status = 'error'
                errorMessage = errorMsg
              } else if (errorMsg.includes('401')) {
                status = 'expired'
                errorMessage = 'Token 宸茶繃鏈燂紝璇峰埛鏂?
              } else {
                status = 'error'
                errorMessage = errorMsg
              }
            }

            // 澶勭悊鐢ㄦ埛淇℃伅鍝嶅簲
            if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
              const rawUserInfo = userInfoRes.value
              userInfoData = {
                email: rawUserInfo.email,
                userId: rawUserInfo.userId,
                status: rawUserInfo.status
              }
              // 妫€鏌ョ敤鎴风姸鎬侊紙Stale 瑙嗕负姝ｅ父锛屼粎 Suspended/Disabled 绛夎涓哄紓甯革級
              if (rawUserInfo.status && rawUserInfo.status !== 'Active' && rawUserInfo.status !== 'Stale' && status !== 'error') {
                status = 'error'
                errorMessage = `鐢ㄦ埛鐘舵€佸紓甯? ${rawUserInfo.status}`
              }
            } else if (userInfoRes.status === 'rejected') {
              // GetUserInfo 澶辫触锛堝皝绂侀敊璇細鍒拌繖閲岋級
              const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
              if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
                status = 'error'
                errorMessage = errMsg
              }
            }

            success++
            completed++

            // 閫氱煡娓叉煋杩涚▼鏇存柊璐﹀彿
            mainWindow?.webContents.send('background-check-result', {
              id: account.id,
              success: true,
              data: {
                usage: usageData ? { ...usageData, resourceDetail } : null,
                subscription: subscriptionData,
                userInfo: userInfoData,
                status,
                errorMessage
              }
            })
          } catch (e) {
            failed++
            completed++
            mainWindow?.webContents.send('background-check-result', {
              id: account.id,
              success: false,
              error: e instanceof Error ? e.message : 'Unknown error'
            })
          }
        })
      )

      // 閫氱煡杩涘害
      mainWindow?.webContents.send('background-check-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 鎵规闂村欢杩?      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  })

  // IPC: 瀵煎嚭鍒版枃浠?  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '瀵煎嚭璐﹀彿鏁版嵁',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  // IPC: 浠庢枃浠跺鍏?  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '瀵煎叆璐﹀彿鏁版嵁',
        filters: [
          { name: '鎵€鏈夋敮鎸佺殑鏍煎紡', extensions: ['json', 'csv', 'txt'] },
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'TXT Files', extensions: ['txt'] }
        ],
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const ext = filePath.split('.').pop()?.toLowerCase() || 'json'
        return { content, format: ext }
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })

  // IPC: 楠岃瘉鍑瘉骞惰幏鍙栬处鍙蜂俊鎭紙鐢ㄤ簬娣诲姞璐﹀彿锛?  ipcMain.handle('verify-account-credentials', async (_event, credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string
    provider?: string  // 'BuilderId', 'Github', 'Google' 绛?  }) => {
    console.log('[IPC] verify-account-credentials called')
    
    try {
      const { refreshToken, clientId, clientSecret, region = 'us-east-1', authMethod, provider } = credentials
      // 纭畾 idp锛氱ぞ浜ょ櫥褰曚娇鐢?provider锛孖dC 涔熼渶瑕佹牴鎹?provider 鍖哄垎 BuilderId 鍜?Enterprise
      const idp = provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google') 
        ? provider 
        : 'BuilderId'
      
      // 绀句氦鐧诲綍鍙渶瑕?refreshToken锛孖dC 闇€瑕?clientId 鍜?clientSecret
      if (!refreshToken) {
        return { success: false, error: '璇峰～鍐?Refresh Token' }
      }
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: '璇峰～鍐?Client ID 鍜?Client Secret' }
      }
      
      // Step 1: 浣跨敤鍚堥€傜殑鏂瑰紡鍒锋柊鑾峰彇 accessToken
      console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
      const refreshResult = await refreshTokenByMethod(refreshToken, clientId, clientSecret, region, authMethod)
      
      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: `Token 鍒锋柊澶辫触: ${refreshResult.error}` }
      }
      
      console.log('[Verify] Step 2: Getting user info...')
      
      // Step 2: 璋冪敤 GetUserUsageAndLimits 鑾峰彇鐢ㄦ埛淇℃伅
      interface Bonus {
        bonusCode?: string
        displayName?: string
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        status?: string
        expiresAt?: string  // API 杩斿洖鐨勬槸 expiresAt
      }
      
      interface FreeTrialInfo {
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        freeTrialStatus?: string
        freeTrialExpiry?: string
      }
      
      interface UsageBreakdown {
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        resourceType?: string
        displayName?: string
        displayNamePlural?: string
        currency?: string
        unit?: string
        overageRate?: number
        overageCap?: number
        bonuses?: Bonus[]
        freeTrialInfo?: FreeTrialInfo
      }
      
      interface UsageResponse {
        nextDateReset?: string
        usageBreakdownList?: UsageBreakdown[]
        subscriptionInfo?: { 
          subscriptionTitle?: string
          type?: string
          subscriptionManagementTarget?: string
          upgradeCapability?: string
          overageCapability?: string
        }
        overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
        userInfo?: { email?: string; userId?: string }
      }
      
      const usageResult = await getUsageAndLimits(refreshResult.accessToken, idp, undefined, undefined, region) as UsageResponse
      
      // 瑙ｆ瀽鐢ㄦ埛淇℃伅
      const email = usageResult.userInfo?.email || ''
      const userId = usageResult.userInfo?.userId || ''
      
      // 瑙ｆ瀽璁㈤槄绫诲瀷锛堟敞鎰忔鏌ラ『搴忥細鍏堟鏌ユ洿鍏蜂綋鐨勭被鍨嬶級
      const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
      let subscriptionType = 'Free'
      const titleUpper = subscriptionTitle.toUpperCase()
      if (titleUpper.includes('PRO+') || titleUpper.includes('PRO_PLUS') || titleUpper.includes('PROPLUS')) {
        subscriptionType = 'Pro_Plus'
      } else if (titleUpper.includes('POWER')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (titleUpper.includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (titleUpper.includes('TEAMS')) {
        subscriptionType = 'Teams'
      }
      
      // 瑙ｆ瀽浣跨敤閲忥紙璇︾粏锛屼娇鐢ㄧ簿纭皬鏁帮級
      const creditUsage = usageResult.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      
      // 鍩虹棰濆害
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // 璇曠敤棰濆害
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // 濂栧姳棰濆害
      const bonuses: { code: string; name: string; current: number; limit: number; expiresAt?: string }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonuses.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }
      
      // 璁＄畻鎬婚搴?      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
      
      // 璁＄畻閲嶇疆鍓╀綑澶╂暟
      let daysRemaining: number | undefined
      let expiresAt: number | undefined
      const nextResetDate = usageResult.nextDateReset
      if (nextResetDate) {
        expiresAt = new Date(nextResetDate).getTime()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
      }
      
      console.log('[Verify] Success! Email:', email)
      
      return {
        success: true,
        data: {
          email,
          userId,
          accessToken: refreshResult.accessToken,
          refreshToken: refreshResult.refreshToken || refreshToken,
          expiresIn: refreshResult.expiresIn,
          subscriptionType,
          subscriptionTitle,
          subscription: {
            rawType: usageResult.subscriptionInfo?.type,
            managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
            upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
            overageCapability: usageResult.subscriptionInfo?.overageCapability
          },
          usage: {
            current: totalUsed,
            limit: totalLimit,
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses,
            nextResetDate,
            resourceDetail: creditUsage ? {
              displayName: creditUsage.displayName,
              displayNamePlural: creditUsage.displayNamePlural,
              resourceType: creditUsage.resourceType,
              currency: creditUsage.currency,
              unit: creditUsage.unit,
              overageRate: creditUsage.overageRate,
              overageCap: creditUsage.overageCap,
              overageEnabled: usageResult.overageConfiguration?.overageStatus === 'ENABLED' || usageResult.overageConfiguration?.overageEnabled === true
            } : undefined
          },
          daysRemaining,
          expiresAt
        }
      }
    } catch (error) {
      console.error('[Verify] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '楠岃瘉澶辫触' }
    }
  })

  // IPC: 鑾峰彇鏈湴 SSO 缂撳瓨涓綋鍓嶄娇鐢ㄧ殑璐﹀彿淇℃伅
  ipcMain.handle('get-local-active-account', async () => {
    const os = await import('os')
    const path = await import('path')
    
    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      
      const tokenContent = await readFile(tokenPath, 'utf-8')
      const tokenData = JSON.parse(tokenContent)
      
      if (!tokenData.refreshToken) {
        return { success: false, error: '鏈湴缂撳瓨涓病鏈?refreshToken' }
      }
      
      return {
        success: true,
        data: {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
          authMethod: tokenData.authMethod,
          provider: tokenData.provider
        }
      }
    } catch {
      return { success: false, error: '鏃犳硶璇诲彇鏈湴 SSO 缂撳瓨' }
    }
  })

  // IPC: 浠?Kiro 鏈湴閰嶇疆瀵煎叆鍑瘉
  ipcMain.handle('load-kiro-credentials', async () => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const fs = await import('fs/promises')
    
    try {
      // 浠?~/.aws/sso/cache/kiro-auth-token.json 璇诲彇 token
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      console.log('[Kiro Credentials] Reading token from:', tokenPath)
      
      let tokenData: {
        accessToken?: string
        refreshToken?: string
        clientIdHash?: string
        region?: string
        authMethod?: string
        provider?: string
      }
      
      try {
        const tokenContent = await readFile(tokenPath, 'utf-8')
        tokenData = JSON.parse(tokenContent)
      } catch {
        return { success: false, error: '鎵句笉鍒?kiro-auth-token.json 鏂囦欢锛岃鍏堝湪 Kiro IDE 涓櫥褰? }
      }
      
      if (!tokenData.refreshToken) {
        return { success: false, error: 'kiro-auth-token.json 涓己灏?refreshToken' }
      }
      
      // 纭畾 clientIdHash锛氫紭鍏堜娇鐢ㄦ枃浠朵腑鐨勶紝鍚﹀垯璁＄畻榛樿鍊?      let clientIdHash = tokenData.clientIdHash
      if (!clientIdHash) {
        // 浣跨敤鏍囧噯鐨?startUrl 璁＄畻 hash锛堜笌 Kiro 瀹㈡埛绔竴鑷达級
        const startUrl = 'https://view.awsapps.com/start'
        clientIdHash = crypto.createHash('sha1')
          .update(JSON.stringify({ startUrl }))
          .digest('hex')
        console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
      }
      
      // 璇诲彇瀹㈡埛绔敞鍐屼俊鎭?      let clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
      console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)
      
      let clientData: {
        clientId?: string
        clientSecret?: string
      } | null = null
      
      try {
        const clientContent = await readFile(clientRegPath, 'utf-8')
        clientData = JSON.parse(clientContent)
      } catch {
        // 濡傛灉鎵句笉鍒帮紝灏濊瘯鎼滅储鐩綍涓殑鍏朵粬 .json 鏂囦欢锛堟帓闄?kiro-auth-token.json锛?        console.log('[Kiro Credentials] Client file not found, searching cache directory...')
        try {
          const files = await fs.readdir(ssoCache)
          for (const file of files) {
            if (file.endsWith('.json') && file !== 'kiro-auth-token.json') {
              try {
                const content = await readFile(path.join(ssoCache, file), 'utf-8')
                const data = JSON.parse(content)
                if (data.clientId && data.clientSecret) {
                  clientData = data
                  console.log('[Kiro Credentials] Found client registration in:', file)
                  break
                }
              } catch {
                // 蹇界暐鏃犳硶瑙ｆ瀽鐨勬枃浠?              }
            }
          }
        } catch {
          // 蹇界暐鐩綍璇诲彇閿欒
        }
      }
      
      // 绀句氦鐧诲綍涓嶉渶瑕?clientId/clientSecret
      const isSocialAuth = tokenData.authMethod === 'social'
      
      if (!isSocialAuth && (!clientData || !clientData.clientId || !clientData.clientSecret)) {
        return { success: false, error: '鎵句笉鍒板鎴风娉ㄥ唽鏂囦欢锛岃纭繚宸插湪 Kiro IDE 涓畬鎴愮櫥褰? }
      }
      
      console.log(`[Kiro Credentials] Successfully loaded credentials (authMethod: ${tokenData.authMethod || 'IdC'})`)
      
      return {
        success: true,
        data: {
          accessToken: tokenData.accessToken || '',
          refreshToken: tokenData.refreshToken,
          clientId: clientData?.clientId || '',
          clientSecret: clientData?.clientSecret || '',
          region: tokenData.region || 'us-east-1',
          authMethod: tokenData.authMethod || 'IdC',
          provider: tokenData.provider || 'BuilderId'
        }
      }
    } catch (error) {
      console.error('[Kiro Credentials] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '鏈煡閿欒' }
    }
  })

  // IPC: 鍒囨崲璐﹀彿 - 鍐欏叆鍑瘉鍒版湰鍦?SSO 缂撳瓨
  ipcMain.handle('switch-account', async (_event, credentials: {
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    startUrl?: string
    authMethod?: 'IdC' | 'social'
    provider?: 'BuilderId' | 'Github' | 'Google' | 'Enterprise'
    profileArn?: string
  }) => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const { mkdir, writeFile } = await import('fs/promises')
    
    try {
      const { 
        refreshToken, 
        clientId, 
        clientSecret, 
        region = 'us-east-1',
        startUrl,
        authMethod = 'IdC',
        provider = 'BuilderId',
        profileArn
      } = credentials
      let { accessToken } = credentials

      // 鍒囧彿鍓嶅厛鍒锋柊 token锛岀‘淇濆啓鍏ョ殑 accessToken 鏄渶鏂扮殑
      // Kiro IDE 浼氱洿鎺ヤ娇鐢?accessToken锛堜笉杩囨湡灏变笉鍒锋柊锛夛紝鏃?token 浼氬鑷?Invalid token
      if (refreshToken) {
        console.log(`[Switch Account] Refreshing token before switch (authMethod: ${authMethod})...`)
        const refreshResult = await refreshTokenByMethod(refreshToken, clientId, clientSecret, region, authMethod)
        if (refreshResult.success && refreshResult.accessToken) {
          accessToken = refreshResult.accessToken
          console.log('[Switch Account] Token refreshed successfully')
        } else {
          console.warn(`[Switch Account] Token refresh failed: ${refreshResult.error}, using existing token`)
        }
      }
      
      // 璁＄畻 clientIdHash (涓?Kiro 瀹㈡埛绔竴鑷?
      // Enterprise 璐︽埛浣跨敤鑷繁鐨?startUrl锛孊uilderId 浣跨敤榛樿鐨?      const effectiveStartUrl = startUrl || 'https://view.awsapps.com/start'
      const clientIdHash = crypto.createHash('sha1')
        .update(JSON.stringify({ startUrl: effectiveStartUrl }))
        .digest('hex')
      
      // 纭繚鐩綍瀛樺湪
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      await mkdir(ssoCache, { recursive: true })
      
      // 鏍规嵁 provider 鎺ㄥ profileArn锛堝畼鏂瑰浐瀹氳鍒欙級
      const SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
      const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
      const resolvedProfileArn = profileArn
        || (authMethod === 'social' || provider === 'Google' || provider === 'Github' ? SOCIAL_PROFILE_ARN : BUILDER_ID_PROFILE_ARN)

      // 鍐欏叆 token 鏂囦欢锛堟牸寮忎笌瀹樻柟 Kiro IDE 瀹屽叏涓€鑷达級
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      const tokenData: Record<string, unknown> = authMethod === 'social'
        ? {
            // Social 鐧诲綍鏍煎紡锛歛ccessToken, refreshToken, profileArn, expiresAt, authMethod, provider
            accessToken,
            refreshToken,
            profileArn: resolvedProfileArn,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            authMethod,
            provider
          }
        : {
            // IdC 鐧诲綍鏍煎紡锛歛ccessToken, refreshToken, expiresAt, clientIdHash, authMethod, provider, region
            accessToken,
            refreshToken,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            clientIdHash,
            authMethod,
            provider,
            region,
            profileArn: resolvedProfileArn
          }
      await writeFile(tokenPath, JSON.stringify(tokenData, null, 2))
      console.log('[Switch Account] Token saved to:', tokenPath)
      
      // 鍙湁 IdC 鐧诲綍闇€瑕佸啓鍏ュ鎴风娉ㄥ唽鏂囦欢
      if (authMethod !== 'social' && clientId && clientSecret) {
        const clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
        const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace('Z', '')
        const clientData = {
          clientId,
          clientSecret,
          expiresAt,
          scopes: [
            'codewhisperer:completions',
            'codewhisperer:analysis',
            'codewhisperer:conversations',
            'codewhisperer:transformations',
            'codewhisperer:taskassist'
          ]
        }
        await writeFile(clientRegPath, JSON.stringify(clientData, null, 2))
        console.log('[Switch Account] Client registration saved to:', clientRegPath)
      }
      
      return { success: true }
    } catch (error) {
      console.error('[Switch Account] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '鍒囨崲澶辫触' }
    }
  })

  // IPC: 鍒囨崲璐﹀彿鍒?Kiro CLI - 鍐欏叆鍑瘉鍒?SQLite 鏁版嵁搴?  // kiro-cli 浣跨敤 ~/.local/share/kiro-cli/data.sqlite3 涓殑 auth_kv 琛?  ipcMain.handle('switch-account-cli', async (_event, credentials: {
    accessToken: string
    refreshToken: string
    clientId?: string
    clientSecret?: string
    region?: string
    profileArn?: string
    provider?: string
    scopes?: string[]
  }) => {
    const os = await import('os')
    const path = await import('path')
    const { mkdir } = await import('fs/promises')

    try {
      const {
        refreshToken,
        clientId,
        clientSecret,
        region = 'us-east-1',
        profileArn,
        provider,
        scopes
      } = credentials
      let { accessToken } = credentials

      // 鍒囧彿鍓嶅厛鍒锋柊 token锛堝拰 IDE 鍒囧彿涓€鑷达級
      if (refreshToken) {
        const authMethod = (provider === 'Google' || provider === 'Github') ? 'social' : undefined
        console.log(`[Switch CLI] Refreshing token before switch (provider: ${provider})...`)
        const refreshResult = await refreshTokenByMethod(refreshToken, clientId || '', clientSecret || '', region, authMethod)
        if (refreshResult.success && refreshResult.accessToken) {
          accessToken = refreshResult.accessToken
          console.log('[Switch CLI] Token refreshed successfully')
        } else {
          console.warn(`[Switch CLI] Token refresh failed: ${refreshResult.error}, using existing token`)
        }
      }

      // kiro-cli SQLite 鏁版嵁搴撹矾寰?      // Windows: %LOCALAPPDATA%\kiro-cli\data.sqlite3
      // macOS/Linux: ~/.local/share/kiro-cli/data.sqlite3
      const dataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'kiro-cli')
        : path.join(os.homedir(), '.local', 'share', 'kiro-cli')
      await mkdir(dataDir, { recursive: true })
      const dbPath = path.join(dataDir, 'data.sqlite3')

      // 鍒ゆ柇 token key锛歴ocial 鐧诲綍鐢?social:token锛孖dC 鐧诲綍鐢?odic:token
      const isSocial = provider === 'Google' || provider === 'Github'
      const preferredTokenKey = isSocial ? 'kirocli:social:token' : 'kirocli:odic:token'
      const preferredRegKey = 'kirocli:odic:device-registration'

      // 鏍规嵁 provider 鎺ㄥ profileArn
      const SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
      const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
      const resolvedProfileArn = profileArn || (isSocial ? SOCIAL_PROFILE_ARN : BUILDER_ID_PROFILE_ARN)

      // 鏋勫缓 token JSON锛坰nake_case 瀛楁鍚嶏紝涓?kiro-cli Rust 缁撴瀯涓€鑷达級
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
      const tokenData: Record<string, unknown> = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        region,
        profile_arn: resolvedProfileArn
      }
      if (scopes) tokenData.scopes = scopes

      // 浣跨敤 sqlite3 鍛戒护琛屾搷浣滐紙璺ㄥ钩鍙板吋瀹癸紝鏃犻渶鍘熺敓妯″潡缂栬瘧锛?      const { execFileSync } = await import('child_process')
      const sqlite3Bin = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3'

      // 鏋勫缓 SQL 璇彞
      const sqlStatements: string[] = [
        'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
        `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredTokenKey}', '${JSON.stringify(tokenData).replace(/'/g, "''")}');`
      ]

      // 鍐欏叆 device-registration锛堜粎 IdC 鐧诲綍锛?      if (clientId && clientSecret && !isSocial) {
        const regData = { client_id: clientId, client_secret: clientSecret, region }
        sqlStatements.push(
          `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredRegKey}', '${JSON.stringify(regData).replace(/'/g, "''")}');`
        )
      }

      // 娓呴櫎鍏朵粬浼樺厛绾х殑鏃?key
      const cliTokenKeys = ['kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token']
      for (const key of cliTokenKeys) {
        if (key !== preferredTokenKey) {
          sqlStatements.push(`DELETE FROM auth_kv WHERE key = '${key}';`)
        }
      }

      try {
        execFileSync(sqlite3Bin, [dbPath], {
          input: sqlStatements.join('\n'),
          timeout: 10000,
          encoding: 'utf-8'
        })
      } catch (sqlite3Error) {
        // sqlite3 鍛戒护涓嶅瓨鍦紝灏濊瘯鐢?Node.js 22+ 鐨勫唴缃?SQLite
        console.log('[Switch CLI] sqlite3 command not available, trying Node.js built-in SQLite...')
        try {
          const { DatabaseSync } = await import('node:sqlite') as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } }
          const db = new DatabaseSync(dbPath)
          try {
            for (const sql of sqlStatements) {
              db.exec(sql)
            }
          } finally {
            db.close()
          }
        } catch {
          throw new Error(`SQLite 鎿嶄綔澶辫触: sqlite3 鍛戒护涓嶅彲鐢?(${(sqlite3Error as Error).message})锛屼笖 Node.js 鍐呯疆 SQLite 涓嶆敮鎸併€傝纭繚绯荤粺瀹夎浜?sqlite3 鍛戒护琛屽伐鍏枫€俙)
        }
      }

      console.log(`[Switch CLI] Token saved to SQLite key: ${preferredTokenKey}`)
      console.log(`[Switch CLI] Account switched successfully in ${dbPath}`)
      return { success: true, dbPath }
    } catch (error) {
      console.error('[Switch CLI] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'CLI 鍒囨崲澶辫触' }
    }
  })


  // IPC: 閫€鍑虹櫥褰?- 娓呴櫎鏈湴 SSO 缂撳瓨
  ipcMain.handle('logout-account', async () => {
    const os = await import('os')
    const path = await import('path')
    const { readdir, unlink } = await import('fs/promises')
    
    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      console.log('[Logout] Clearing SSO cache:', ssoCache)
      
      // 璇诲彇鐩綍涓嬫墍鏈夋枃浠?      const files = await readdir(ssoCache).catch(() => [])
      
      // 鍒犻櫎鎵€鏈夋枃浠?      for (const file of files) {
        const filePath = path.join(ssoCache, file)
        await unlink(filePath).catch((e) => {
          console.warn('[Logout] Failed to delete file:', filePath, e)
        })
      }
      
      console.log('[Logout] SSO cache cleared, deleted', files.length, 'files')
      return { success: true, deletedCount: files.length }
    } catch (error) {
      console.error('[Logout] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '閫€鍑哄け璐? }
    }
  })

  // ============ 鎵嬪姩鐧诲綍鐩稿叧 IPC ============

  // 瀛樺偍褰撳墠鐧诲綍鐘舵€?  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO 鐩稿叧
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO 涓撶敤
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth 鐩稿叧
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 鍚姩 Builder ID 鎵嬪姩鐧诲綍
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')
    
    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 娉ㄥ唽 OIDC 瀹㈡埛绔?      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `娉ㄥ唽瀹㈡埛绔け璐? ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 鍙戣捣璁惧鎺堟潈
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `璁惧鎺堟潈澶辫触: ${errText}` }
      }

      const authData = await authRes.json()
      const { deviceCode, userCode, verificationUri, verificationUriComplete, interval = 5, expiresIn = 600 } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 淇濆瓨鐧诲綍鐘舵€?      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '鐧诲綍澶辫触' }
    }
  })

  // IPC: 杞 Builder ID 鎺堟潈鐘舵€?  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '娌℃湁杩涜涓殑鐧诲綍' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '鎺堟潈宸茶繃鏈燂紝璇烽噸鏂板紑濮? }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')
        
        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
        
        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: '璁惧鐮佸凡杩囨湡' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '鐢ㄦ埛鎷掔粷鎺堟潈' }
        } else {
          currentLoginState = null
          return { success: false, error: `鎺堟潈閿欒: ${error}` }
        }
      } else {
        return { success: false, error: `鏈煡鍝嶅簲: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '杞澶辫触' }
    }
  })

  // IPC: 鍙栨秷 Builder ID 鐧诲綍
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO 鏈湴鏈嶅姟鍣ㄥ拰鐘舵€?  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
  let iamSsoResult: {
    completed: boolean
    success: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  } | null = null

  // IPC: 鍚姩 IAM Identity Center SSO 鐧诲綍 (浣跨敤 Authorization Code Grant with PKCE)
  ipcMain.handle('start-iam-sso-login', async (_event, startUrl: string, region: string = 'us-east-1') => {
    console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
    console.log('[Login] Start URL:', startUrl)
    
    // 楠岃瘉 startUrl 鏍煎紡
    if (!startUrl || !startUrl.startsWith('https://')) {
      return { success: false, error: 'SSO Start URL 蹇呴』浠?https:// 寮€澶? }
    }
    
    const crypto = await import('crypto')
    const http = await import('http')
    
    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 娉ㄥ唽 OIDC 瀹㈡埛绔?(浣跨敤 authorization_code grant type)
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: 'Kiro Account Manager',
          clientType: 'public',
          scopes,
          grantTypes: ['authorization_code', 'refresh_token'],
          redirectUris: ['http://127.0.0.1/oauth/callback'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        console.error('[Login] IAM SSO client registration failed:', regRes.status, errText)
        
        if (errText.includes('UnauthorizedException') || errText.includes('access denied')) {
          return { 
            success: false, 
            error: '鎺堟潈澶辫触锛氭偍鐨勭粍缁囧彲鑳芥湭閰嶇疆 Amazon Q Developer 璁块棶鏉冮檺銆傝鑱旂郴缁勭粐绠＄悊鍛樺湪 IAM Identity Center 涓惎鐢ㄧ浉鍏虫潈闄愩€? 
          }
        }
        
        return { success: false, error: `娉ㄥ唽瀹㈡埛绔け璐? ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 鐢熸垚 PKCE 鍜?state
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomUUID()

      // Step 3: 鍚姩鏈湴 HTTP 鏈嶅姟鍣ㄦ帴鏀跺洖璋?      console.log('[Login] Step 2: Starting local OAuth callback server...')
      
      // 鍏抽棴涔嬪墠鐨勬湇鍔″櫒
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }

      // 鎵句竴涓彲鐢ㄧ鍙?      const port = await new Promise<number>((resolve, reject) => {
        const server = http.createServer()
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            const p = addr.port
            server.close(() => resolve(p))
          } else {
            reject(new Error('鏃犳硶鑾峰彇绔彛'))
          }
        })
      })

      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      console.log('[Login] Redirect URI:', redirectUri)

      // 閲嶇疆缁撴灉
      iamSsoResult = null

      // 鍒涘缓鍥炶皟鏈嶅姟鍣?      iamSsoServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${port}`)
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          
          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>鎺堟潈澶辫触</h1><p>鎮ㄥ彲浠ュ叧闂绐楀彛銆?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: `鎺堟潈澶辫触: ${error}` }
            return
          }
          
          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>鎺堟潈澶辫触</h1><p>鐘舵€佷笉鍖归厤锛岃閲嶈瘯銆?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '鐘舵€佷笉鍖归厤' }
            return
          }
          
          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>鎺堟潈鎴愬姛锛?/h1><p>姝ｅ湪鑾峰彇浠ょ墝锛岃绋嶅€?..</p></body></html>')
            
            // 鑷姩瀹屾垚 token 浜ゆ崲
            try {
              const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  clientId,
                  clientSecret,
                  grantType: 'authorization_code',
                  redirectUri,
                  code,
                  codeVerifier
                })
              })

              if (!tokenRes.ok) {
                const errText = await tokenRes.text()
                console.error('[Login] Token exchange failed:', tokenRes.status, errText)
                iamSsoResult = { completed: true, success: false, error: `鑾峰彇 Token 澶辫触: ${errText}` }
              } else {
                const tokenData = await tokenRes.json()
                console.log('[Login] IAM SSO Authorization successful!')
                iamSsoResult = {
                  completed: true,
                  success: true,
                  accessToken: tokenData.accessToken,
                  refreshToken: tokenData.refreshToken,
                  clientId,
                  clientSecret,
                  region,
                  expiresIn: tokenData.expiresIn
                }
              }
            } catch (tokenError) {
              console.error('[Login] Token exchange error:', tokenError)
              iamSsoResult = { 
                completed: true, 
                success: false, 
                error: tokenError instanceof Error ? tokenError.message : '鑾峰彇 Token 澶辫触' 
              }
            }
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>鎺堟潈澶辫触</h1><p>鏈敹鍒版巿鏉冪爜銆?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '鏈敹鍒版巿鏉冪爜' }
          }
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      iamSsoServer.listen(port, '127.0.0.1', () => {
        console.log('[Login] OAuth callback server listening on port', port)
      })

      // Step 4: 鏋勫缓鎺堟潈 URL 骞舵墦寮€娴忚鍣?      const authorizeParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: scopes.join(','),
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      })
      const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`
      console.log('[Login] Opening browser for authorization...')

      // 淇濆瓨鐧诲綍鐘舵€?      currentLoginState = {
        type: 'iamsso',
        clientId,
        clientSecret,
        codeVerifier,
        redirectUri,
        region,
        startUrl,
        expiresAt: Date.now() + 600000
      }

      // 杩斿洖鎺堟潈 URL锛屽墠绔細鎵撳紑娴忚鍣?      return {
        success: true,
        authorizeUrl,
        expiresIn: 600
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '鐧诲綍澶辫触' }
    }
  })

  // IPC: 杞 IAM SSO 鎺堟潈鐘舵€?(妫€鏌ユ湰鍦版湇鍔″櫒鏄惁鏀跺埌鍥炶皟)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: '娌℃湁杩涜涓殑 IAM SSO 鐧诲綍' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: '鎺堟潈宸茶繃鏈燂紝璇烽噸鏂板紑濮? }
    }

    // 妫€鏌ユ槸鍚﹀凡鏀跺埌鍥炶皟骞跺畬鎴?token 浜ゆ崲
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // 娓呯悊鐘舵€?        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // 杩樺湪绛夊緟鍥炶皟
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: 鍙栨秷 IAM SSO 鐧诲綍
  ipcMain.handle('cancel-iam-sso-login', async () => {
    console.log('[Login] Cancelling IAM SSO login...')
    if (iamSsoServer) {
      iamSsoServer.close()
      iamSsoServer = null
    }
    iamSsoResult = null
    currentLoginState = null
    return { success: true }
  })

  // IPC: 鍚姩 Social Auth 鐧诲綍 (Google/GitHub)
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
    console.log(`[Login] Starting ${provider} Social Auth login... (privateMode: ${usePrivateMode})`)
    
    const crypto = await import('crypto')

    // 鐢熸垚 PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // 鏋勫缓鐧诲綍 URL
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // 淇濆瓨鐧诲綍鐘舵€?    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    const urlStr = loginUrl.toString()
    console.log(`[Login] Opening browser for ${provider} login...`)

    // 鏍规嵁鏄惁浣跨敤闅愮妯″紡閫夋嫨鎵撳紑鏂瑰紡
    if (usePrivateMode) {
      openBrowserInPrivateMode(urlStr)
    } else {
      shell.openExternal(urlStr)
    }

    return {
      success: true,
      loginUrl: urlStr,
      state: oauthState
    }
  })

  // IPC: 浜ゆ崲 Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '娌℃湁杩涜涓殑绀句氦鐧诲綍' }
    }

    // 楠岃瘉 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '鐘舵€佸弬鏁颁笉鍖归厤锛屽彲鑳藉瓨鍦ㄥ畨鍏ㄩ闄? }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'

    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token 浜ゆ崲澶辫触: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token 浜ゆ崲澶辫触' }
    }
  })

  // IPC: 鍙栨秷 Social Auth 鐧诲綍
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 璁剧疆浠ｇ悊
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    console.log(`[IPC] set-proxy called: enabled=${enabled}, url=${url}`)
    try {
      applyProxySettings(enabled, url)
      
      // 鍚屾椂璁剧疆 Electron 鐨?session 浠ｇ悊
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && url) {
          await session.setProxy({ proxyRules: url })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }
      
      return { success: true }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============ Kiro 璁剧疆绠＄悊 IPC ============

  // IPC: 鑾峰彇 Kiro 璁剧疆
  ipcMain.handle('get-kiro-settings', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      const kiroSteeringPath = path.join(homeDir, '.kiro', 'steering')
      const kiroMcpUserPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      let settings = {}
      let mcpConfig = { mcpServers: {} }
      let steeringFiles: string[] = []
      
      // 璇诲彇 Kiro settings.json (VS Code 椋庢牸 JSON锛屽彲鑳芥湁灏鹃殢閫楀彿)
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // 绉婚櫎灏鹃殢閫楀彿鍜屾敞閲婁互鍏煎鏍囧噯 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 绉婚櫎鍗曡娉ㄩ噴
          .replace(/\/\*[\s\S]*?\*\//g, '') // 绉婚櫎澶氳娉ㄩ噴
          .replace(/,(\s*[}\]])/g, '$1') // 绉婚櫎灏鹃殢閫楀彿
        const parsed = JSON.parse(cleanedContent)
        settings = {
          modelSelection: parsed['kiroAgent.modelSelection'],
          agentAutonomy: parsed['kiroAgent.agentAutonomy'],
          enableDebugLogs: parsed['kiroAgent.enableDebugLogs'],
          enableTabAutocomplete: parsed['kiroAgent.enableTabAutocomplete'],
          enableCodebaseIndexing: parsed['kiroAgent.enableCodebaseIndexing'],
          usageSummary: parsed['kiroAgent.usageSummary'],
          codeReferences: parsed['kiroAgent.codeReferences.referenceTracker'],
          configureMCP: parsed['kiroAgent.configureMCP'],
          trustedCommands: parsed['kiroAgent.trustedCommands'] || [],
          trustedTools: parsed['kiroAgent.trustedTools'] || {},
          commandDenylist: parsed['kiroAgent.commandDenylist'] || [],
          ignoreFiles: parsed['kiroAgent.ignoreFiles'] || [],
          mcpApprovedEnvVars: parsed['kiroAgent.mcpApprovedEnvVars'] || [],
          notificationsActionRequired: parsed['kiroAgent.notifications.agent.actionRequired'],
          notificationsFailure: parsed['kiroAgent.notifications.agent.failure'],
          notificationsSuccess: parsed['kiroAgent.notifications.agent.success'],
          notificationsBilling: parsed['kiroAgent.notifications.billing']
        }
      }
      
      // 璇诲彇 MCP 閰嶇疆
      if (fs.existsSync(kiroMcpUserPath)) {
        const mcpContent = fs.readFileSync(kiroMcpUserPath, 'utf-8')
        mcpConfig = JSON.parse(mcpContent)
      }
      
      // 璇诲彇 Steering 鏂囦欢鍒楄〃
      if (fs.existsSync(kiroSteeringPath)) {
        const files = fs.readdirSync(kiroSteeringPath)
        steeringFiles = files.filter(f => f.endsWith('.md'))
        console.log('[KiroSettings] Steering path:', kiroSteeringPath)
        console.log('[KiroSettings] Found steering files:', steeringFiles)
      } else {
        console.log('[KiroSettings] Steering path does not exist:', kiroSteeringPath)
      }
      
      return { settings, mcpConfig, steeringFiles }
    } catch (error) {
      console.error('[KiroSettings] Failed to get settings:', error)
      return { error: error instanceof Error ? error.message : 'Failed to get settings' }
    }
  })

  // IPC: 鑾峰彇 Kiro 鍙敤妯″瀷鍒楄〃锛堜娇鐢ㄥ綋鍓嶈处鍙疯皟鐢ㄥ畼鏂?API锛?  ipcMain.handle('get-kiro-available-models', async () => {
    try {
      if (!store) return { models: [] }
      const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
      if (!accountData?.accounts) return { models: [] }

      // 浼樺厛浣跨敤褰撳墠婵€娲昏处鍙凤紙isActive锛夛紝鍏舵浣跨敤绗竴涓?active 涓旀湁 accessToken 鐨勮处鍙?      const allAccounts = Object.values(accountData.accounts) as any[]
      const account = allAccounts.find((acc: any) => acc.isActive && acc.credentials?.accessToken)
        || allAccounts.find((acc: any) => acc.status === 'active' && acc.credentials?.accessToken)
      if (!account) return { models: [] }

      const proxyAccount = {
        id: account.id,
        email: account.email,
        accessToken: account.credentials.accessToken,
        refreshToken: account.credentials?.refreshToken,
        profileArn: account.profileArn,
        expiresAt: account.credentials?.expiresAt,
        clientId: account.credentials?.clientId,
        clientSecret: account.credentials?.clientSecret,
        region: account.credentials?.region || 'us-east-1',
        authMethod: account.credentials?.authMethod
      }

      const models = await fetchKiroModels(proxyAccount)
      return {
        models: models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description
        }))
      }
    } catch (error) {
      console.error('[KiroSettings] Failed to fetch models:', error)
      return { models: [], error: error instanceof Error ? error.message : 'Failed to fetch models' }
    }
  })

  // IPC: 淇濆瓨 Kiro 璁剧疆
  ipcMain.handle('save-kiro-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      
      const homeDir = os.homedir()
      const kiroSettingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      let existingSettings = {}
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // 绉婚櫎灏鹃殢閫楀彿鍜屾敞閲婁互鍏煎鏍囧噯 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 绉婚櫎鍗曡娉ㄩ噴
          .replace(/\/\*[\s\S]*?\*\//g, '') // 绉婚櫎澶氳娉ㄩ噴
          .replace(/,(\s*[}\]])/g, '$1') // 绉婚櫎灏鹃殢閫楀彿
        existingSettings = JSON.parse(cleanedContent)
      }
      
      // 鏄犲皠璁剧疆鍒?Kiro 鐨勬牸寮?      const kiroSettings = {
        ...existingSettings,
        'kiroAgent.modelSelection': settings.modelSelection,
        'kiroAgent.agentAutonomy': settings.agentAutonomy,
        'kiroAgent.enableDebugLogs': settings.enableDebugLogs,
        'kiroAgent.enableTabAutocomplete': settings.enableTabAutocomplete,
        'kiroAgent.enableCodebaseIndexing': settings.enableCodebaseIndexing,
        'kiroAgent.usageSummary': settings.usageSummary,
        'kiroAgent.codeReferences.referenceTracker': settings.codeReferences,
        'kiroAgent.configureMCP': settings.configureMCP,
        'kiroAgent.trustedCommands': settings.trustedCommands,
        'kiroAgent.trustedTools': settings.trustedTools,
        'kiroAgent.commandDenylist': settings.commandDenylist,
        'kiroAgent.ignoreFiles': settings.ignoreFiles,
        'kiroAgent.mcpApprovedEnvVars': settings.mcpApprovedEnvVars,
        'kiroAgent.notifications.agent.actionRequired': settings.notificationsActionRequired,
        'kiroAgent.notifications.agent.failure': settings.notificationsFailure,
        'kiroAgent.notifications.agent.success': settings.notificationsSuccess,
        'kiroAgent.notifications.billing': settings.notificationsBilling
      }
      
      // 纭繚鐩綍瀛樺湪
      const dir = path.dirname(kiroSettingsPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(kiroSettingsPath, JSON.stringify(kiroSettings, null, 4))
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save settings' }
    }
  })

  // IPC: 鎵撳紑 Kiro MCP 閰嶇疆鏂囦欢
  ipcMain.handle('open-kiro-mcp-config', async (_event, type: 'user' | 'workspace') => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      
      let configPath: string
      if (type === 'user') {
        configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      } else {
        // 宸ヤ綔鍖洪厤缃紝鎵撳紑褰撳墠宸ヤ綔鍖虹殑 .kiro/settings/mcp.json
        configPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      }
      
      // 濡傛灉鏂囦欢涓嶅瓨鍦紝鍒涘缓绌洪厤缃?      const fs = await import('fs')
      if (!fs.existsSync(configPath)) {
        const dir = path.dirname(configPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
      }
      
      shell.openPath(configPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open MCP config:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open MCP config' }
    }
  })

  // IPC: 鎵撳紑 Kiro Steering 鐩綍
  ipcMain.handle('open-kiro-steering-folder', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      
      // 濡傛灉鐩綍涓嶅瓨鍦紝鍒涘缓瀹?      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      shell.openPath(steeringPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering folder:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering folder' }
    }
  })

  // IPC: 鎵撳紑 Kiro settings.json 鏂囦欢
  ipcMain.handle('open-kiro-settings-file', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      // 濡傛灉鏂囦欢涓嶅瓨鍦紝鍒涘缓榛樿閰嶇疆
      if (!fs.existsSync(settingsPath)) {
        const dir = path.dirname(settingsPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const defaultSettings = {
          'workbench.colorTheme': 'Kiro Light',
          'kiroAgent.modelSelection': 'claude-haiku-4.5'
        }
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4))
      }
      
      shell.openPath(settingsPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open settings file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open settings file' }
    }
  })

  // IPC: 鎵撳紑鎸囧畾鐨?Steering 鏂囦欢
  ipcMain.handle('open-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      shell.openPath(filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering file' }
    }
  })

  // IPC: 鍒涘缓榛樿鐨?rules.md 鏂囦欢
  ipcMain.handle('create-kiro-default-rules', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const rulesPath = path.join(steeringPath, 'rules.md')
      
      // 纭繚鐩綍瀛樺湪
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      // 榛樿瑙勫垯鍐呭
      const defaultContent = `# Role: 楂樼骇杞欢寮€鍙戝姪鎵?涓€銆佺郴缁熶负Windows10
浜屻€佽皟寮忔枃浠躲€佹祴璇曡剼鏈€乼est鐩稿叧鏂囦欢閮芥斁鍦╰est鏂囦欢澶归噷闈紝md鏂囦欢鏀惧湪docs鏂囦欢澶归噷闈?# 鏍稿績鍘熷垯


## 1. 娌熼€氫笌鍗忎綔
- **璇氬疄浼樺厛**锛氬湪浠讳綍鎯呭喌涓嬮兘涓ョ鐚滄祴鎴栦吉瑁呫€傚綋闇€姹備笉鏄庣‘銆佸瓨鍦ㄦ妧鏈闄╂垨閬囧埌鐭ヨ瘑鐩插尯鏃讹紝蹇呴』鍋滄宸ヤ綔锛屽苟绔嬪嵆鍚戠敤鎴锋緞娓呫€?- **鎶€鏈敾鍧?*锛氶潰瀵规妧鏈毦棰樻椂锛岄瑕佺洰鏍囨槸瀵绘壘骞舵彁鍑洪珮璐ㄩ噺鐨勮В鍐虫柟妗堛€傚彧鏈夊湪鎵€鏈夊彲琛屾柟妗堝潎琚瘎浼板悗锛屾墠鑳戒笌鐢ㄦ埛鎺㈣闄嶇骇鎴栨浛鎹㈡柟妗堛€?- **鎵瑰垽鎬ф€濈淮**锛氬湪鎵ц浠诲姟鏃讹紝濡傛灉鍙戠幇褰撳墠闇€姹傚瓨鍦ㄦ妧鏈檺鍒躲€佹綔鍦ㄩ闄╂垨鏈夋洿浼樼殑瀹炵幇璺緞锛屽繀椤讳富鍔ㄥ悜鐢ㄦ埛鎻愬嚭浣犵殑瑙佽В鍜屾敼杩涘缓璁€?- **璇█瑕佹眰**锛氭€濊€冨拰鍥炵瓟鏃舵€绘槸浣跨敤涓枃杩涜鍥炲銆?

## 2. 鏋舵瀯璁捐
- **妯″潡鍖栬璁?*锛氭墍鏈夎璁￠兘蹇呴』閬靛惊鍔熻兘瑙ｈ€︺€佽亴璐ｅ崟涓€鐨勫師鍒欍€備弗鏍奸伒瀹圫OLID鍜孌RY鍘熷垯銆?- **鍓嶇灮鎬ф€濈淮**锛氬湪璁捐鏃跺繀椤昏€冭檻鏈潵鐨勫彲鎵╁睍鎬у拰鍙淮鎶ゆ€э紝纭繚瑙ｅ喅鏂规鑳藉铻嶅叆椤圭洰鐨勬暣浣撴灦鏋勩€?- **鎶€鏈€哄姟浼樺厛**锛氬湪杩涜閲嶆瀯鎴栦紭鍖栨椂锛屼紭鍏堝鐞嗗绯荤粺绋冲畾鎬у拰鍙淮鎶ゆ€у奖鍝嶆渶澶х殑鎶€鏈€哄姟鍜屽熀纭€鏋舵瀯闂銆?

## 3. 浠ｇ爜涓庝氦浠樼墿璐ㄩ噺鏍囧噯
### 缂栧啓瑙勮寖
- **鏋舵瀯瑙嗚**锛氬缁堜粠鏁翠綋椤圭洰鏋舵瀯鍑哄彂缂栧啓浠ｇ爜锛岀‘淇濅唬鐮佺墖娈佃兘澶熸棤缂濋泦鎴愶紝鑰屼笉鏄绔嬬殑鍔熻兘銆?- **闆舵妧鏈€哄姟**锛氫弗绂佸垱寤轰换浣曞舰寮忕殑鎶€鏈€哄姟锛屽寘鎷絾涓嶉檺浜庯細涓存椂鏂囦欢銆佺‖缂栫爜鍊笺€佽亴璐ｄ笉娓呯殑妯″潡鎴栧嚱鏁般€?- **闂鏆撮湶**锛氱姝㈡坊鍔犱换浣曠敤浜庢帺鐩栨垨缁曡繃閿欒鐨刦allback鏈哄埗銆備唬鐮佸簲璁捐涓哄揩閫熷け璐ワ紙Fail-Fast锛夛紝纭繚闂鍦ㄧ涓€鏃堕棿琚彂鐜般€?

### 璐ㄩ噺瑕佹眰
- **鍙鎬?*锛氫娇鐢ㄦ竻鏅般€佹湁鎰忎箟鐨勫彉閲忓悕鍜屽嚱鏁板悕銆備唬鐮侀€昏緫蹇呴』娓呮櫚鏄撴噦锛屽苟杈呬互蹇呰鐨勬敞閲娿€?- **瑙勮寖閬靛惊**锛氫弗鏍奸伒寰洰鏍囩紪绋嬭瑷€鐨勭ぞ鍖烘渶浣冲疄璺靛拰瀹樻柟缂栫爜瑙勮寖銆?- **鍋ュ．鎬?*锛氬繀椤诲寘鍚厖鍒嗙殑閿欒澶勭悊閫昏緫鍜岃竟鐣屾潯浠舵鏌ャ€?- **鎬ц兘鎰忚瘑**锛氬湪淇濊瘉浠ｇ爜璐ㄩ噺鍜屽彲璇绘€х殑鍓嶆彁涓嬶紝瀵规€ц兘鏁忔劅閮ㄥ垎杩涜鍚堢悊浼樺寲锛岄伩鍏嶄笉蹇呰鐨勮绠楀鏉傚害鍜岃祫婧愭秷鑰椼€?

### 浜や粯鐗╄鑼?- **鏃犳枃妗?*锛氶櫎闈炵敤鎴锋槑纭姹傦紝鍚﹀垯涓嶈鍒涘缓浠讳綍Markdown鏂囨。鎴栧叾浠栧舰寮忕殑璇存槑鏂囨。銆?- **鏃犳祴璇?*锛氶櫎闈炵敤鎴锋槑纭姹傦紝鍚﹀垯涓嶈缂栧啓鍗曞厓娴嬭瘯鎴栭泦鎴愭祴璇曚唬鐮併€?- **鏃犵紪璇?杩愯**锛氱姝㈢紪璇戞垨鎵ц浠讳綍浠ｇ爜銆備綘鐨勪换鍔℃槸鐢熸垚楂樿川閲忕殑浠ｇ爜鍜岃璁℃柟妗堛€?

# 娉ㄦ剰浜嬮」
- 闄ら潪鐗瑰埆璇存槑鍚﹀垯涓嶈鍒涘缓鏂扮殑鏂囨。銆佷笉瑕佹祴璇曘€佷笉瑕佺紪璇戙€佷笉瑕佽繍琛屻€佷笉闇€瑕佹€荤粨锛岄櫎闈炵敤鎴蜂富鍔ㄨ姹?

- 闇€姹備笉鏄庣‘鏃朵娇鍚戠敤鎴疯闂緞娓咃紝鎻愪緵棰勫畾涔夐€夐」
- 鍦ㄦ湁澶氫釜鏂规鐨勬椂鍊欙紝闇€瑕佸悜鐢ㄦ埛璇㈤棶锛岃€屼笉鏄嚜浣滀富寮?- 鍦ㄦ湁鏂规/绛栫暐闇€瑕佹洿鏂版椂锛岄渶瑕佸悜鐢ㄦ埛璇㈤棶锛岃€屼笉鏄嚜浣滀富寮?

- ACE涓篴ugmentContextEngine宸ュ叿鐨勭缉鍐?- 濡傛灉瑕佹眰鏌ョ湅鏂囨。璇蜂娇鐢?Context7 MCP
- 濡傛灉闇€瑕佽繘琛學EB鍓嶇椤甸潰娴嬭瘯璇蜂娇鐢?Playwright MCP
- 濡傛灉鐢ㄦ埛鍥炲'缁х画' 鍒欒鎸夌収鏈€浣冲疄璺电户缁畬鎴愪换鍔?`
      
      fs.writeFileSync(rulesPath, defaultContent, 'utf-8')
      console.log('[KiroSettings] Created default rules.md at:', rulesPath)
      
      // 鎵撳紑鏂囦欢
      shell.openPath(rulesPath)
      
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to create default rules:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create default rules' }
    }
  })

  // IPC: 璇诲彇 Steering 鏂囦欢鍐呭
  ipcMain.handle('read-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '鏂囦欢涓嶅瓨鍦? }
      }
      
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      console.error('[KiroSettings] Failed to read steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })

  // IPC: 淇濆瓨 Steering 鏂囦欢鍐呭
  ipcMain.handle('save-kiro-steering-file', async (_event, filename: string, content: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const filePath = path.join(steeringPath, filename)
      
      // 纭繚鐩綍瀛樺湪
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      fs.writeFileSync(filePath, content, 'utf-8')
      console.log('[KiroSettings] Saved steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save file' }
    }
  })

  // ============ Kiro API 鍙嶄唬鏈嶅姟鍣?IPC ============

  // IPC: 鍚姩鍙嶄唬鏈嶅姟鍣?  ipcMain.handle('proxy-start', async (_event, config?: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      if (config) {
        server.updateConfig(config)
      }
      await server.start()
      // 鏇存柊鎵樼洏鑿滃崟鐘舵€?      updateTrayMenu()
      return { success: true, port: server.getConfig().port }
    } catch (error) {
      console.error('[ProxyServer] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy server' }
    }
  })

  // IPC: 鍋滄鍙嶄唬鏈嶅姟鍣?  ipcMain.handle('proxy-stop', async () => {
    try {
      if (proxyServer) {
        await proxyServer.stop()
      }
      // 鏇存柊鎵樼洏鑿滃崟鐘舵€?      updateTrayMenu()
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop proxy server' }
    }
  })

  // IPC: 鑾峰彇鍙嶄唬鏈嶅姟鍣ㄧ姸鎬?  ipcMain.handle('proxy-get-status', () => {
    if (!proxyServer) {
      // 鏈垵濮嬪寲鏃朵粠 store 璇诲彇淇濆瓨鐨勯厤缃?      const savedConfig = store?.get('proxyConfig') as ProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, sessionStats: null }
    }
    return {
      running: proxyServer.isRunning(),
      config: proxyServer.getConfig(),
      stats: proxyServer.getStats(),
      sessionStats: proxyServer.getSessionStats()
    }
  })

  // IPC: 閲嶇疆绱 credits
  ipcMain.handle('proxy-reset-credits', () => {
    if (proxyServer) {
      proxyServer.resetTotalCredits()
    }
    if (store) {
      store.set('proxyTotalCredits', 0)
    }
    return { success: true }
  })

  // IPC: 閲嶇疆绱 tokens
  ipcMain.handle('proxy-reset-tokens', () => {
    if (proxyServer) {
      proxyServer.resetTotalTokens()
    }
    if (store) {
      store.set('proxyInputTokens', 0)
      store.set('proxyOutputTokens', 0)
    }
    return { success: true }
  })

  // IPC: 閲嶇疆璇锋眰缁熻
  ipcMain.handle('proxy-reset-request-stats', () => {
    if (proxyServer) {
      proxyServer.resetRequestStats()
    }
    if (store) {
      store.set('proxyTotalRequests', 0)
      store.set('proxySuccessRequests', 0)
      store.set('proxyFailedRequests', 0)
    }
    return { success: true }
  })

  // IPC: 鑾峰彇鍙嶄唬鏃ュ織
  ipcMain.handle('proxy-get-logs', (_event, count?: number) => {
    if (count) {
      return proxyLogStore.getLast(count)
    }
    return proxyLogStore.getAll()
  })

  // IPC: 娓呴櫎鍙嶄唬鏃ュ織
  ipcMain.handle('proxy-clear-logs', () => {
    proxyLogStore.clear()
    return { success: true }
  })

  // IPC: 鑾峰彇鍙嶄唬鏃ュ織鏁伴噺
  ipcMain.handle('proxy-get-logs-count', () => {
    return proxyLogStore.count()
  })

  // IPC: 鑾峰彇 Usage API 绫诲瀷
  ipcMain.handle('get-usage-api-type', () => {
    return currentUsageApiType
  })

  // IPC: 璁剧疆 Usage API 绫诲瀷
  ipcMain.handle('set-usage-api-type', (_event, type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    // 淇濆瓨鍒?store
    if (store) {
      store.set('usageApiType', type)
    }
    return { success: true, type }
  })

  // IPC: 鑾峰彇鏄惁浣跨敤 K-Proxy 浠ｇ悊
  ipcMain.handle('get-use-kproxy-for-api', () => {
    return getUseKProxyForApi()
  })

  // IPC: 璁剧疆鏄惁浣跨敤 K-Proxy 浠ｇ悊
  ipcMain.handle('set-use-kproxy-for-api', (_event, enabled: boolean) => {
    setUseKProxyForApi(enabled)
    // 淇濆瓨鍒?store
    if (store) {
      store.set('useKProxyForApi', enabled)
    }
    return { success: true, enabled }
  })

  // IPC: 鏇存柊鍙嶄唬鏈嶅姟鍣ㄩ厤缃?  ipcMain.handle('proxy-update-config', async (_event, config: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      server.updateConfig(config)
      const newConfig = server.getConfig()
      // 鍚屾娴佸紡鏃ュ織寮€鍏?      if (config.logStreamEvents !== undefined) {
        setLogStreamEvents(config.logStreamEvents)
      }
      // 鍚屾 payload 澶у皬闄愬埗
      if (config.payloadSizeLimitKB !== undefined) {
        setPayloadSizeLimitKB(config.payloadSizeLimitKB)
      }
      // 鍚屾 Token buffer reserve
      if (config.tokenBufferReserve !== undefined) {
        setTokenBufferReserve(config.tokenBufferReserve)
      }
      // 淇濆瓨閰嶇疆鍒?store锛堢敤浜庤嚜鍚姩锛?      if (store) {
        store.set('proxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[ProxyServer] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // ============ API Key 绠＄悊 IPC ============

  // IPC: 鑾峰彇鎵€鏈?API Keys
  ipcMain.handle('proxy-get-api-keys', () => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      return { success: true, apiKeys: config.apiKeys || [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get API keys', apiKeys: [] }
    }
  })

  // IPC: 娣诲姞 API Key
  ipcMain.handle('proxy-add-api-key', async (_event, apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }) => {
    try {
      const crypto = await import('crypto')
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      // 鏍规嵁鏍煎紡鐢熸垚闅忔満 Key
      const format = apiKey.format || 'sk'
      let newKey = apiKey.key
      if (!newKey) {
        const randomHex = crypto.randomBytes(24).toString('hex')
        switch (format) {
          case 'sk':
            newKey = `sk-${randomHex}`
            break
          case 'simple':
            newKey = `PROXY_KEY_${randomHex.toUpperCase().substring(0, 32)}`
            break
          case 'token':
            newKey = `KEY:${randomHex.substring(0, 16)}:TOKEN:${randomHex.substring(16, 32)}`
            break
          default:
            newKey = `sk-${randomHex}`
        }
      }
      
      const newApiKey: import('./proxy/types').ApiKey = {
        id: crypto.randomUUID(),
        name: apiKey.name || `API Key ${apiKeys.length + 1}`,
        key: newKey,
        format: format,
        enabled: true,
        createdAt: Date.now(),
        creditsLimit: apiKey.creditsLimit,
        usage: {
          totalRequests: 0,
          totalCredits: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          daily: {}
        }
      }
      
      apiKeys.push(newApiKey)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true, apiKey: newApiKey }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add API key' }
    }
  })

  // IPC: 鏇存柊 API Key
  ipcMain.handle('proxy-update-api-key', (_event, id: string, updates: Partial<import('./proxy/types').ApiKey>) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      // 鏇存柊瀛楁锛堜笉鍏佽鏇存柊 id銆乧reatedAt銆乽sage锛?      const { id: _, createdAt: __, usage: ___, ...allowedUpdates } = updates
      apiKeys[index] = { ...apiKeys[index], ...allowedUpdates }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true, apiKey: apiKeys[index] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update API key' }
    }
  })

  // IPC: 鍒犻櫎 API Key
  ipcMain.handle('proxy-delete-api-key', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKeys.splice(index, 1)
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete API key' }
    }
  })

  // IPC: 閲嶇疆 API Key 鐢ㄩ噺缁熻
  ipcMain.handle('proxy-reset-api-key-usage', (_event, id: string) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const apiKey = apiKeys.find(k => k.id === id)
      if (!apiKey) {
        return { success: false, error: 'API key not found' }
      }
      
      apiKey.usage = {
        totalRequests: 0,
        totalCredits: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        daily: {}
      }
      
      server.updateConfig({ apiKeys })
      
      if (store) {
        store.set('proxyConfig', server.getConfig())
      }
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset usage' }
    }
  })

  // IPC: 娣诲姞璐﹀彿鍒板弽浠ｆ睜
  ipcMain.handle('proxy-add-account', (_event, account: ProxyAccount) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().addAccount(account)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Add account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add account' }
    }
  })

  // IPC: 浠庡弽浠ｆ睜绉婚櫎璐﹀彿
  ipcMain.handle('proxy-remove-account', (_event, accountId: string) => {
    try {
      const server = initProxyServer()
      server.getAccountPool().removeAccount(accountId)
      return { success: true, accountCount: server.getAccountPool().size }
    } catch (error) {
      console.error('[ProxyServer] Remove account failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove account' }
    }
  })

  // IPC: 鍚屾璐﹀彿鍒板弽浠ｆ睜锛堟壒閲忔洿鏂帮級
  ipcMain.handle('proxy-sync-accounts', (_event, accounts: ProxyAccount[]) => {
    try {
      const server = initProxyServer()
      const pool = server.getAccountPool()
      pool.clear()
      for (const account of accounts) {
        pool.addAccount(account)
      }
      return { success: true, accountCount: pool.size }
    } catch (error) {
      console.error('[ProxyServer] Sync accounts failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync accounts' }
    }
  })

  // IPC: 鑾峰彇鍙嶄唬姹犺处鍙峰垪琛?  ipcMain.handle('proxy-get-accounts', () => {
    if (!proxyServer) {
      return { accounts: [], availableCount: 0 }
    }
    const pool = proxyServer.getAccountPool()
    return {
      accounts: pool.getAllAccounts(),
      availableCount: pool.availableCount
    }
  })

  // IPC: 鍒锋柊妯″瀷缂撳瓨
  ipcMain.handle('proxy-refresh-models', () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized' }
    }
    proxyServer.clearModelCache()
    return { success: true }
  })

  // IPC: 鑾峰彇鍙敤妯″瀷鍒楄〃
  ipcMain.handle('proxy-get-models', async () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized', models: [] }
    }
    try {
      const result = await proxyServer.getAvailableModels()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
    }
  })

  ipcMain.handle('proxy-configure-clients', async (_event, input: { clients: ProxyClientTarget[]; modelId: string; modelName?: string; models?: ProxyClientModel[] }) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKey = (config.apiKey || config.apiKeys?.find(key => key.enabled)?.key || '').trim()
      if (!apiKey) {
        return {
          success: false,
          proxyOrigin: '',
          openaiBaseUrl: '',
          results: [],
          error: '璇峰厛鍦ㄥ弽浠ｉ厤缃腑璁剧疆鎴栧惎鐢?API Key'
        }
      }
      return await configureProxyClients({
        clients: input.clients,
        host: config.host,
        port: config.port,
        tlsEnabled: config.tls?.enabled,
        apiKey,
        modelId: input.modelId,
        modelName: input.modelName,
        models: input.models
      })
    } catch (error) {
      return {
        success: false,
        proxyOrigin: '',
        openaiBaseUrl: '',
        results: [],
        error: error instanceof Error ? error.message : 'Failed to configure clients'
      }
    }
  })

  // IPC: 鑾峰彇璐︽埛鍙敤妯″瀷鍒楄〃
  ipcMain.handle('account-get-models', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const models = await fetchKiroModels({
        id: accountId || 'model-list-request',
        accessToken,
        region: region || 'us-east-1',
        profileArn,
        machineId,
        provider,
        authMethod: authMethod as ProxyAccount['authMethod']
      } as ProxyAccount)
      return {
        success: true,
        models: models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description,
          inputTypes: m.supportedInputTypes,
          maxInputTokens: m.tokenLimits?.maxInputTokens,
          maxOutputTokens: m.tokenLimits?.maxOutputTokens,
          rateMultiplier: m.rateMultiplier,
          rateUnit: m.rateUnit
        }))
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
    }
  })

  // IPC: 鑾峰彇鍙敤璁㈤槄鍒楄〃
  ipcMain.handle('account-get-subscriptions', async (_event, accessToken: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await fetchAvailableSubscriptions({ id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount)
      if (result.subscriptionPlans) {
        return { 
          success: true, 
          plans: result.subscriptionPlans,
          disclaimer: result.disclaimer 
        }
      }
      return { success: false, error: 'No subscription plans returned', plans: [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscriptions', plans: [] }
    }
  })

  // IPC: 鑾峰彇璁㈤槄绠＄悊/鏀粯閾炬帴
  ipcMain.handle('account-get-subscription-url', async (_event, accessToken: string, subscriptionType?: string, region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await fetchSubscriptionToken({ id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount, subscriptionType)
      if (result.encodedVerificationUrl) {
        return { success: true, url: result.encodedVerificationUrl, status: result.status }
      }
      return { success: false, error: result.message || 'No subscription URL returned' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscription URL' }
    }
  })

  // IPC: 璁剧疆鐢ㄦ埛鍋忓ソ锛堣秴棰濆紑鍚?鍏抽棴锛?  ipcMain.handle('account-set-overage', async (_event, accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
    try {
      const result = await setUserPreference(
        { id: accountId || 'subscription-request', accessToken, region: region || 'us-east-1', profileArn, machineId, provider, authMethod } as ProxyAccount,
        overageStatus
      )
      return result
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set overage' }
    }
  })

  // IPC: 鍦ㄧ郴缁熼粯璁ゆ祻瑙堝櫒鏃犵棔妯″紡涓墦寮€璁㈤槄閾炬帴
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' }
    }
  })

  // 浠ｇ悊鏃ュ織鎸佷箙鍖栵紙璇锋眰鏃ュ織锛屼笌璇︾粏鏃ュ織鍒嗗紑瀛樺偍锛?  const getProxyLogsPath = (): string => join(app.getPath('userData'), 'proxy-request-logs.json')
  const MAX_LOGS = 100

  // IPC: 淇濆瓨浠ｇ悊鏃ュ織
  ipcMain.handle('proxy-save-logs', async (_event, logs: Array<{ time: string; path: string; status: number; tokens?: number }>) => {
    try {
      const logsPath = getProxyLogsPath()
      // 鍙繚鐣欐渶杩?100 鏉?      const trimmedLogs = logs.slice(0, MAX_LOGS)
      await writeFile(logsPath, JSON.stringify(trimmedLogs, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('[ProxyLogs] Save failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save logs' }
    }
  })

  // IPC: 鍔犺浇浠ｇ悊鏃ュ織
  ipcMain.handle('proxy-load-logs', async () => {
    try {
      const logsPath = getProxyLogsPath()
      const content = await readFile(logsPath, 'utf-8')
      const logs = JSON.parse(content)
      return { success: true, logs }
    } catch (error) {
      // 鏂囦欢涓嶅瓨鍦ㄦ槸姝ｅ父鐨?      return { success: true, logs: [] }
    }
  })

  // IPC: 閲嶇疆鍙嶄唬姹犵姸鎬?  ipcMain.handle('proxy-reset-pool', () => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().reset()
      }
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Reset pool failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reset pool' }
    }
  })

  // IPC: 鎵嬪姩瑙ｉ櫎璐﹀彿灏佺鏍囪锛堢敤鎴风‘璁よ处鍙峰凡鎭㈠鍚庤皟鐢級
  // 1) 娓呴櫎鍙嶄唬姹犱腑鐨?suspended 鐘舵€?  // 2) 鍚屾娓呴櫎 store.accountData[id].lastError锛岀姸鎬佸洖鍒?active
  ipcMain.handle('proxy-clear-account-suspended', (_event, accountId: string) => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().clearSuspended(accountId)
      }
      // 鎸佷箙鍖栨竻闄?lastError
      if (store) {
        const accountData = store.get('accountData') as { accounts?: Record<string, Record<string, unknown>> } | undefined
        if (accountData?.accounts?.[accountId]) {
          const acc = accountData.accounts[accountId]
          accountData.accounts[accountId] = {
            ...acc,
            status: 'active',
            lastError: undefined,
            lastCheckedAt: Date.now()
          }
          store.set('accountData', accountData)
          lastSavedData = accountData
        }
      }
      console.log(`[ProxyServer] Cleared suspended flag for account ${accountId}`)
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Clear suspended failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to clear suspended' }
    }
  })

  // ============ K-Proxy MITM 浠ｇ悊 IPC ============

  // IPC: 鍒濆鍖?K-Proxy 鏈嶅姟
  ipcMain.handle('kproxy-init', async () => {
    try {
      const savedConfig = store?.get('kproxyConfig') as Partial<KProxyConfig> | undefined
      const service = initKProxyService(savedConfig || {}, {
        onRequest: (info) => {
          mainWindow?.webContents.send('kproxy-request', info)
        },
        onResponse: (info) => {
          mainWindow?.webContents.send('kproxy-response', info)
        },
        onError: (error) => {
          console.error('[KProxy] Error:', error)
          mainWindow?.webContents.send('kproxy-error', error.message)
        },
        onStatusChange: (running, port) => {
          mainWindow?.webContents.send('kproxy-status-change', { running, port })
        },
        onMitmIntercept: (host, modified) => {
          mainWindow?.webContents.send('kproxy-mitm', { host, modified })
        }
      })
      const caInfo = await service.initialize()
      return { 
        success: true, 
        caInfo: {
          certPath: caInfo.certPath,
          fingerprint: caInfo.fingerprint,
          validFrom: caInfo.validFrom.toISOString(),
          validTo: caInfo.validTo.toISOString()
        }
      }
    } catch (error) {
      console.error('[KProxy] Init failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to init K-Proxy' }
    }
  })

  // IPC: 鍚姩 K-Proxy
  ipcMain.handle('kproxy-start', async (_event, config?: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      if (config) {
        service.updateConfig(config)
      }
      await service.start()
      // 淇濆瓨閰嶇疆
      if (store) {
        store.set('kproxyConfig', service.getConfig())
      }
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      console.error('[KProxy] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start K-Proxy' }
    }
  })

  // IPC: 鍋滄 K-Proxy
  ipcMain.handle('kproxy-stop', async () => {
    try {
      const service = getKProxyService()
      if (service) {
        await service.stop()
      }
      return { success: true }
    } catch (error) {
      console.error('[KProxy] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop K-Proxy' }
    }
  })

  // IPC: 鑾峰彇 K-Proxy 鐘舵€?  ipcMain.handle('kproxy-get-status', () => {
    const service = getKProxyService()
    if (!service) {
      const savedConfig = store?.get('kproxyConfig') as KProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, caInfo: null }
    }
    return {
      running: service.isRunning(),
      config: service.getConfig(),
      stats: service.getStats(),
      caInfo: service.getCACertInfo()
    }
  })

  // IPC: 鏇存柊 K-Proxy 閰嶇疆
  ipcMain.handle('kproxy-update-config', async (_event, config: Partial<KProxyConfig>) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.updateConfig(config)
      const newConfig = service.getConfig()
      if (store) {
        store.set('kproxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[KProxy] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // IPC: 璁剧疆褰撳墠璁惧 ID
  ipcMain.handle('kproxy-set-device-id', (_event, deviceId: string) => {
    try {
      if (!isValidDeviceId(deviceId)) {
        return { success: false, error: 'Invalid device ID format (must be 64 hex characters)' }
      }
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.setDeviceId(deviceId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set device ID' }
    }
  })

  // IPC: 鐢熸垚鏂扮殑璁惧 ID
  ipcMain.handle('kproxy-generate-device-id', () => {
    return { success: true, deviceId: generateDeviceId() }
  })

  // IPC: 娣诲姞璁惧 ID 鏄犲皠
  ipcMain.handle('kproxy-add-device-mapping', (_event, mapping: DeviceIdMapping) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.addDeviceIdMapping(mapping)
      // 淇濆瓨鏄犲皠
      const mappings = service.getAllDeviceIdMappings()
      if (store) {
        store.set('kproxyDeviceMappings', mappings)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add mapping' }
    }
  })

  // IPC: 鑾峰彇鎵€鏈夎澶?ID 鏄犲皠
  ipcMain.handle('kproxy-get-device-mappings', () => {
    const service = getKProxyService()
    if (!service) {
      const savedMappings = store?.get('kproxyDeviceMappings') as DeviceIdMapping[] | undefined
      return { success: true, mappings: savedMappings || [] }
    }
    return { success: true, mappings: service.getAllDeviceIdMappings() }
  })

  // IPC: 鍒囨崲鍒拌处鍙疯澶?ID
  ipcMain.handle('kproxy-switch-to-account', (_event, accountId: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const switched = service.switchToAccount(accountId)
      return { success: switched, error: switched ? undefined : 'No device ID mapping for account' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to switch account' }
    }
  })

  // IPC: 鑾峰彇 CA 璇佷功 PEM锛堢敤浜庡鍑?瀹夎锛?  ipcMain.handle('kproxy-get-ca-cert', () => {
    const service = getKProxyService()
    if (!service) {
      return { success: false, error: 'K-Proxy not initialized' }
    }
    const certPem = service.getCACertPem()
    const caInfo = service.getCACertInfo()
    if (!certPem || !caInfo) {
      return { success: false, error: 'CA certificate not available' }
    }
    return { 
      success: true, 
      certPem,
      certPath: caInfo.certPath,
      fingerprint: caInfo.fingerprint
    }
  })

  // IPC: 瀵煎嚭 CA 璇佷功鍒版寚瀹氳矾寰?  ipcMain.handle('kproxy-export-ca-cert', async (_event, exportPath?: string) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const certPem = service.getCACertPem()
      if (!certPem) {
        return { success: false, error: 'CA certificate not available' }
      }
      
      let targetPath = exportPath
      if (!targetPath) {
        const result = await dialog.showSaveDialog({
          title: 'Export CA Certificate',
          defaultPath: 'kproxy-ca.crt',
          filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' }
        }
        targetPath = result.filePath
      }
      
      await writeFile(targetPath, certPem, 'utf-8')
      return { success: true, path: targetPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to export certificate' }
    }
  })

  // IPC: 閲嶇疆 K-Proxy 缁熻
  ipcMain.handle('kproxy-reset-stats', () => {
    const service = getKProxyService()
    if (service) {
      service.resetStats()
    }
    return { success: true }
  })

  // IPC: 妫€鏌?CA 璇佷功鏄惁宸插畨瑁呭埌绯荤粺淇′换瀛樺偍
  ipcMain.handle('kproxy-check-ca-cert-installed', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, installed: false, error: 'K-Proxy not initialized' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 浣跨敤 certutil 妫€鏌ヨ瘉涔?        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      } else if (platform === 'darwin') {
        // macOS: 浣跨敤 security 鍛戒护妫€鏌?        try {
          execSync('security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db', { encoding: 'utf-8' })
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      } else {
        // Linux: 妫€鏌ユ枃浠舵槸鍚﹀瓨鍦?        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        return { success: true, installed: fs.existsSync(targetPath) }
      }
    } catch (error) {
      console.error('[KProxy] Check CA cert installed failed:', error)
      return { success: false, installed: false, error: error instanceof Error ? error.message : 'Check failed' }
    }
  })

  // IPC: 瀹夎 CA 璇佷功鍒扮郴缁熶俊浠诲瓨鍌?  ipcMain.handle('kproxy-install-ca-cert', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      const caInfo = service.getCACertInfo()
      if (!caInfo) {
        return { success: false, error: 'CA certificate not available' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 浣跨敤 certutil 瀹夎鍒版牴璇佷功瀛樺偍
        try {
          execSync(`certutil -addstore -user Root "${caInfo.certPath}"`, { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate installed to Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('already in store') || errMsg.includes('宸插湪瀛樺偍涓?)) {
            return { success: true, message: 'CA certificate already installed' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 浣跨敤 security 鍛戒护瀹夎鍒伴挜鍖欎覆
        execSync(`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caInfo.certPath}"`)
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      } else {
        // Linux: 澶嶅埗鍒扮郴缁?CA 鐩綍
        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        fs.copyFileSync(caInfo.certPath, targetPath)
        execSync('sudo update-ca-certificates')
        return { success: true, message: 'CA certificate installed to Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Install CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install certificate' }
    }
  })

  // IPC: 鍗歌浇 CA 璇佷功浠庣郴缁熶俊浠诲瓨鍌?  ipcMain.handle('kproxy-uninstall-ca-cert', async () => {
    try {
      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 浣跨敤 certutil 鍒犻櫎璇佷功
        try {
          execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate removed from Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('not found') || errMsg.includes('鎵句笉鍒?)) {
            return { success: true, message: 'CA certificate not found in store' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 浣跨敤 security 鍛戒护鍒犻櫎
        execSync('security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db')
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      } else {
        // Linux: 鍒犻櫎璇佷功骞舵洿鏂?        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath)
          execSync('sudo update-ca-certificates --fresh')
        }
        return { success: true, message: 'CA certificate removed from Linux CA store' }
      }
    } catch (error) {
      console.error('[KProxy] Uninstall CA cert failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall certificate' }
    }
  })

  // ============ MCP 鏈嶅姟鍣ㄧ鐞?IPC ============

  // IPC: 淇濆瓨 MCP 鏈嶅姟鍣ㄩ厤缃?  ipcMain.handle('save-mcp-server', async (_event, name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      // 璇诲彇鐜版湁閰嶇疆
      let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      if (fs.existsSync(mcpPath)) {
        const content = fs.readFileSync(mcpPath, 'utf-8')
        mcpConfig = JSON.parse(content)
      }
      
      // 濡傛灉鏄噸鍛藉悕锛屽厛鍒犻櫎鏃х殑
      if (oldName && oldName !== name) {
        delete mcpConfig.mcpServers[oldName]
      }
      
      // 娣诲姞/鏇存柊鏈嶅姟鍣?      mcpConfig.mcpServers[name] = config
      
      // 纭繚鐩綍瀛樺湪
      const dir = path.dirname(mcpPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Saved MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to save MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save MCP server' }
    }
  })

  // IPC: 鍒犻櫎 MCP 鏈嶅姟鍣?  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: '閰嶇疆鏂囦欢涓嶅瓨鍦? }
      }
      
      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)
      
      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: '鏈嶅姟鍣ㄤ笉瀛樺湪' }
      }
      
      delete mcpConfig.mcpServers[name]
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
      console.log('[KiroSettings] Deleted MCP server:', name)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete MCP server:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' }
    }
  })

  // IPC: 鍒犻櫎 Steering 鏂囦欢
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '鏂囦欢涓嶅瓨鍦? }
      }
      
      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete file' }
    }
  })

  // ============ 鏈哄櫒鐮佺鐞?IPC ============
  
  // IPC: 鑾峰彇鎿嶄綔绯荤粺绫诲瀷
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: 鑾峰彇褰撳墠鏈哄櫒鐮?  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: 璁剧疆鏂版満鍣ㄧ爜
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)
    
    if (!result.success && result.requiresAdmin) {
      // 寮圭獥璇㈤棶鐢ㄦ埛鏄惁浠ョ鐞嗗憳鏉冮檺閲嶅惎
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }
    
    return result
  })

  // IPC: 鐢熸垚闅忔満鏈哄櫒鐮?  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: 妫€鏌ョ鐞嗗憳鏉冮檺
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: 璇锋眰绠＄悊鍛樻潈闄愰噸鍚?  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: 澶囦唤鏈哄櫒鐮佸埌鏂囦欢
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '澶囦唤鏈哄櫒鐮?,
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    
    if (result.canceled || !result.filePath) {
      return false
    }
    
    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: 浠庢枃浠舵仮澶嶆満鍣ㄧ爜
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '鎭㈠鏈哄櫒鐮?,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: '鐢ㄦ埛鍙栨秷' }
    }
    
    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // 鏇存柊鍗忚澶勭悊鍑芥暟浠ユ敮鎸?Social Auth 鍥炶皟
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 閲嶆柊瀹氫箟鍗忚澶勭悊
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)
      
      // 澶勭悊 Social Auth 鍥炶皟 (kiro://kiro.kiroAgent/authenticate-success)
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // 璋冪敤鍘熷澶勭悊鍑芥暟澶勭悊鍏朵粬鍗忚
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: 鐐瑰嚮 Dock 鍥炬爣鏃舵樉绀轰富绐楀彛
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 鍔犺浇骞舵敞鍐屽叏灞€蹇嵎閿?  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: 澶勭悊绗簩涓疄渚嬪拰鍗忚 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 鍗忚 URL 浼氫綔涓哄懡浠よ鍙傛暟浼犲叆
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 鑱氱劍涓荤獥鍙?    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 澶勭悊鍗忚 URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 搴旂敤閫€鍑哄墠娉ㄩ攢 URI 鍗忚澶勭悊鍣ㄥ苟淇濆瓨鏁版嵁
app.on('will-quit', async (event) => {
  // 闃叉閲嶅澶勭悊
  if (isQuitting) return
  
  // 闃叉搴旂敤绔嬪嵆閫€鍑猴紝鍏堜繚瀛樻暟鎹?  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true
    
    // 璁剧疆瓒呮椂锛岀‘淇?3 绉掑悗寮哄埗閫€鍑猴紙闃叉鍏虫満闃诲锛?    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)
    
    try {
      console.log('[Exit] Saving data before quit...')
      // 鍒锋柊寰呭啓鍏ョ殑闃叉姈鏁版嵁
      flushStoreWrites()
      store.set('accountData', lastSavedData)
      await createBackup(lastSavedData)
      console.log('[Exit] Data saved successfully')
    } catch (error) {
      console.error('[Exit] Failed to save data:', error)
    }
    
    clearTimeout(forceQuitTimer)
    unregisterProtocol()
    app.exit(0)
  } else {
    unregisterProtocol()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

