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

// ============ 自动更新配置 ============
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function setupAutoUpdater(): void {
  // 检查更新出�?  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error)
    mainWindow?.webContents.send('update-error', error.message)
  })

  // 检查更新中
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...')
    mainWindow?.webContents.send('update-checking')
  })

  // 有可用更�?  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version)
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // 没有可用更新
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available, current:', info.version)
    mainWindow?.webContents.send('update-not-available', { version: info.version })
  })

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`)
    mainWindow?.webContents.send('update-download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  // 下载完成
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version)
    mainWindow?.webContents.send('update-downloaded', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })
}

// ============ Kiro API 调用 ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API 端点配置 - 官方 Kiro 插件仅支�?us-east-1 �?eu-central-1
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// 根据 SSO 区域映射到最近的 REST API 端点
function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  // 如果是支持的端点区域，直接使�?  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  // EU 区域映射�?eu-central-1
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  // 其他区域默认 us-east-1
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// 获取备用 REST API 端点（用�?fallback�?function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  // 返回另一个端点作�?fallback
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

// API 类型配置
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // 默认使用 REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// 是否使用 K-Proxy 代理发�?API 请求
let useKProxyForApi: boolean = false

export function setUseKProxyForApi(enabled: boolean): void {
  useKProxyForApi = enabled
  // 同步设置�?kiroApi.ts
  setUseKProxyForApiInProxy(enabled)
  console.log(`[API] Use K-Proxy for API requests: ${enabled}`)
}

export function getUseKProxyForApi(): boolean {
  return useKProxyForApi
}

// 获取网络代理 agent（优�?K-Proxy，其次用户设置代理，其次系统代理�?function getNetworkAgent(): ProxyAgent | undefined {
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

// 通用 fetch 函数，使�?getNetworkAgent 获取代理
async function fetchWithAppProxy(url: string, options: RequestInit): Promise<Response> {
  const agent = getNetworkAgent()
  if (agent) {
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// 兼容函数，指�?getNetworkAgent
function getKProxyAgent(): ProxyAgent | undefined {
  return getNetworkAgent()
}

// ============ OIDC Token 刷新 ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

// 社交登录 (GitHub/Google) �?Token 刷新端点
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ 代理设置 ============

// 设置代理环境变量
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

// ============ 防抖 store 写入（减少磁�?I/O�?============
const pendingStoreWrites: Map<string, unknown> = new Map()
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null
const STORE_FLUSH_INTERVAL = 5000 // 5 秒批量写入一�?
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

// ============ Kiro API 反代服务�?============
let proxyServer: ProxyServer | null = null

function initProxyServer(): ProxyServer {
  if (proxyServer) return proxyServer

  // 确保日志存储已初始化（app.whenReady 中已调用，此处兜底）
  proxyLogStore.initialize(app.getPath('userData'))

  // �?store 加载保存的配置，如果没有则使用默认配�?  const savedConfig = store?.get('proxyConfig') as Partial<ProxyConfig> | undefined
  // �?store 加载保存�?Usage API 类型
  const savedUsageApiType = store?.get('usageApiType') as 'rest' | 'cbor' | undefined
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType)
  }
  // �?store 加载保存�?K-Proxy 代理设置
  const savedUseKProxyForApi = store?.get('useKProxyForApi') as boolean | undefined
  if (savedUseKProxyForApi !== undefined) {
    setUseKProxyForApi(savedUseKProxyForApi)
  }
  // �?store 加载保存的累�?credits �?tokens
  const savedTotalCredits = (store?.get('proxyTotalCredits') as number) || 0
  const savedInputTokens = (store?.get('proxyInputTokens') as number) || 0
  const savedOutputTokens = (store?.get('proxyOutputTokens') as number) || 0
  // �?store 加载保存的请求统�?  const savedTotalRequests = (store?.get('proxyTotalRequests') as number) || 0
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
    tokenRefreshBeforeExpiry: 300, // 5分钟提前刷新
    enableServerSideToolAutoContinue: false,
    clientDrivenToolExecution: true
  }
  
  // 合并保存的配置和默认配置
  const config: ProxyConfig = savedConfig ? { ...defaultConfig, ...savedConfig } : defaultConfig

  // 恢复 payload 大小限制
  if (config.payloadSizeLimitKB) {
    setPayloadSizeLimitKB(config.payloadSizeLimitKB)
  }
  // 恢复 Token buffer reserve
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
      // Token 刷新回调 - 复用已有的刷新逻辑
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
          return { success: false, error: refreshResult.error || 'Token 刷新失败' }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
        }
      },
      // 账号更新回调 - 通知渲染进程更新账号数据
      onAccountUpdate: (account) => {
        mainWindow?.webContents.send('proxy-account-update', {
          id: account.id,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt
        })
      },
      // 账号�?Kiro 后端长期封禁 - 通知渲染进程标记 lastError + 持久化到 store
      // 不同�?token 失效，需要人工解封；账号池已自动跳过该账�?      onAccountSuspended: (info) => {
        console.warn(`[ProxyServer] Account suspended: ${info.email || info.accountId} (${info.reason})`)
        // 推�?IPC 事件给前�?store
        mainWindow?.webContents.send('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
        // 同步写入 store accountData[id].lastError, 保证下次启动�?UI 仍然能看到封禁状�?        if (store) {
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
      // Credits 更新回调 - 使用防抖持久�?      onCreditsUpdate: (totalCredits) => {
        debouncedStoreSet('proxyTotalCredits', totalCredits)
      },
      // Tokens 更新回调 - 使用防抖持久�?      onTokensUpdate: (inputTokens, outputTokens) => {
        debouncedStoreSet('proxyInputTokens', inputTokens)
        debouncedStoreSet('proxyOutputTokens', outputTokens)
      },
      // 请求统计更新回调 - 使用防抖持久�?      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        debouncedStoreSet('proxyTotalRequests', totalRequests)
        debouncedStoreSet('proxySuccessRequests', successRequests)
        debouncedStoreSet('proxyFailedRequests', failedRequests)
        // 更新托盘菜单（也防抖，避免频繁重建菜单）
        debouncedUpdateTrayMenu()
      },
      // 账号池为空时懒加�?- �?store 读取账号数据同步�?pool
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

  // 恢复保存的累�?credits
  if (savedTotalCredits > 0) {
    proxyServer.setTotalCredits(savedTotalCredits)
  }

  // 恢复保存的累�?tokens
  if (savedInputTokens > 0 || savedOutputTokens > 0) {
    proxyServer.setTotalTokens(savedInputTokens, savedOutputTokens)
  }

  // 恢复保存的请求统�?  if (savedTotalRequests > 0 || savedSuccessRequests > 0 || savedFailedRequests > 0) {
    proxyServer.setRequestStats(savedTotalRequests, savedSuccessRequests, savedFailedRequests)
  }

  return proxyServer
}

// ============ 隐私模式打开浏览�?============
import { exec, execSync } from 'child_process'

// 获取 Windows 默认浏览�?function getWindowsDefaultBrowser(): string {
  try {
    // 从注册表读取默认浏览�?    const progId = execSync(
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

// 使用隐私模式打开浏览�?function openBrowserInPrivateMode(url: string): void {
  const platform = process.platform
  console.log(`[Browser] Opening in private mode on ${platform}: ${url}`)

  try {
    if (platform === 'win32') {
      // Windows: 检测默认浏览器并使用对应的隐私模式参数
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
          // 未知浏览器，尝试常见浏览�?          console.log('[Browser] Unknown default browser, trying common browsers...')
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
      // macOS: 尝试 Chrome -> Firefox -> 默认浏览�?      exec(`open -na "Google Chrome" --args --incognito "${url}"`, (err) => {
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
      // Linux: 尝试 Chrome -> Chromium -> Firefox
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

// IdC (BuilderId) �?OIDC Token 刷新
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
      refreshToken: data.refreshToken || refreshToken, // 可能不返回新�?refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 社交登录 (GitHub/Google) �?Token 刷新
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

// 通用 Token 刷新 - 根据 authMethod 选择刷新方式
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string
): Promise<OidcRefreshResult> {
  // 如果是社交登录，使用 Kiro Auth Service 刷新
  if (authMethod === 'social') {
    return refreshSocialToken(token)
  }
  // 否则使用 OIDC 刷新 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Kiro 版本�?User-Agent 生成
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

// ============ AWS SSO 设备授权流程 ============
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

  // Step 1: 注册 OIDC 客户�?  console.log('[SSO] Step 1: Registering OIDC client...')
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
    return { success: false, error: `注册客户端失�? ${e}` }
  }

  // Step 2: 发起设备授权
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
    return { success: false, error: `设备授权失败: ${e}` }
  }

  // Step 3: 验证 Bearer Token (whoAmI)
  console.log('[SSO] Step 3: Verifying bearer token...')
  try {
    const whoRes = await fetchWithAppProxy(`${portalBase}/token/whoAmI`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Accept': 'application/json' }
    })
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`)
    console.log('[SSO] Bearer token verified')
  } catch (e) {
    return { success: false, error: `Token 验证失败: ${e}` }
  }

  // Step 4: 获取设备会话令牌
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
    return { success: false, error: `获取设备会话失败: ${e}` }
  }

  // Step 5: 接受用户代码
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
    return { success: false, error: `接受用户代码失败: ${e}` }
  }

  // Step 6: 批准授权
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
      return { success: false, error: `批准授权失败: ${e}` }
    }
  }

  // Step 7: 轮询获取 Token
  console.log('[SSO] Step 7: Polling for token...')
  const startTime = Date.now()
  const timeout = 120000 // 2 分钟超时

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
          continue // 继续轮询
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token 获取失败: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: '授权超时，请重试' }
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp: string = 'BuilderId',  // 支持 BuilderId, Github, Google
  accountMachineId?: string,  // 账户绑定的设�?ID
  email?: string              // 用于日志标识
): Promise<T> {
  // 优先使用账户绑定的设�?ID，其次使�?K-Proxy 全局设备 ID
  const machineId = accountMachineId || getCurrentMachineId()
  const logTag = email || `token:${accessToken?.slice(-6) || '?'}`
  console.log(`[Kiro API] ${operation} [${logTag}] ${idp} machineId=${machineId?.slice(0, 8) || 'none'}`)
  const agent = getKProxyAgent()
  
  // 使用 undici fetch 支持代理
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
    // 尝试解析 CBOR 格式的错误响�?    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as { __type?: string; message?: string }
      if (errorData.__type && errorData.message) {
        // 提取错误类型名称（去掉命名空间）
        const errorType = errorData.__type.split('#').pop() || errorData.__type
        // 在错误消息中包含 HTTP 状态码，便于封禁检�?        errorMessage = `HTTP ${response.status}: ${errorType}: ${errorData.message}`
      } else if (errorData.message) {
        errorMessage = `HTTP ${response.status}: ${errorData.message}`
      }
      console.error(`[Kiro API] Error:`, errorData)
    } catch {
      // 如果 CBOR 解析失败，显示原始内�?      const errorText = Buffer.from(errorBuffer).toString('utf-8')
      console.error(`[Kiro API] Error (raw): ${errorText}`)
    }
    throw new Error(errorMessage)
  }

  const arrayBuffer = await response.arrayBuffer()
  const result = decode(Buffer.from(arrayBuffer)) as T
  // 精简响应日志：一行摘�?+ 完整数据�?data（ⓘ 展开�?  const r = result as Record<string, unknown>
  const resSummary = r.email ? `${r.email} [${r.status || 'ok'}]` : `${response.status}`
  console.log(`[Kiro API] ${operation} [${logTag}] �?${resSummary}`, result)
  return result
}

// ============ GetUsageLimits REST API (官方格式) ============
interface UsageLimitsResponse {
  // REST API 实际返回 usageBreakdownList（不�?usageBreakdowns�?  usageBreakdownList?: Array<{
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
    // REST API 直接返回 freeTrialInfo（与 freeTrialUsage 结构相同�?    freeTrialInfo?: {
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
      expiresAt?: number | string  // REST API 返回数字时间�?      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string  // Unix 时间戳（秒）�?ISO 字符�?  subscriptionInfo?: {
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

// 辅助函数：将 Unix 时间戳（秒）�?ISO 字符串转换为 ISO 字符�?function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix 时间戳（秒），转换为毫秒后创�?Date
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
  accountMachineId?: string,  // 账户绑定的设�?ID
  ssoRegion?: string,         // SSO 区域，用于选择正确�?REST API 端点
  email?: string              // 用于日志标识
): Promise<UsageLimitsResponse> {
  // 优先使用账户绑定的设�?ID，其次使�?K-Proxy 全局设备 ID
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
  
  // 根据 SSO 区域选择主端�?  const primaryBase = getRestApiBase(ssoRegion)
  const fallbackBase = getFallbackRestApiBase(ssoRegion)
  
  let response = await fetchRestApi(primaryBase, path, accessToken, machineId)
  
  // 如果主端点返�?403，尝试备用端�?  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback �?${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, accessToken, machineId)
  }
  
  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`, errorText)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }
  
  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] �?${response.status}`, result)
  return result
}

// 统一的用量查询接�?- 根据配置选择 API 类型
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
  accountMachineId?: string,  // 账户绑定的设�?ID
  ssoRegion?: string,         // SSO 区域，用于选择正确�?REST API 端点
  email?: string              // 用于日志标识
): Promise<UnifiedUsageResponse> {
  if (currentUsageApiType === 'rest') {
    // 使用 REST API (GetUsageLimits)
    const result = await getUsageLimitsRest(accessToken, profileArn, accountMachineId, ssoRegion, email)
    // REST API 返回的字段名�?CBOR API 相同，直接返�?    return {
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
        // REST API 直接返回 freeTrialInfo，CBOR API 返回 freeTrialUsage
        freeTrialInfo: b.freeTrialInfo ? {
          freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
          usageLimit: b.freeTrialInfo.usageLimit,
          usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
          currentUsage: b.freeTrialInfo.currentUsage,
          currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
          // REST API 返回数字时间戳，需要转换为 ISO 字符�?          freeTrialExpiry: typeof b.freeTrialInfo.freeTrialExpiry === 'number' 
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
        // 转换 bonuses 中的时间戳为 ISO 字符�?        bonuses: b.bonuses?.map(bonus => ({
          ...bonus,
          expiresAt: typeof bonus.expiresAt === 'number' 
            ? new Date(bonus.expiresAt * 1000).toISOString() 
            : bonus.expiresAt
        }))
      })),
      // REST API 返回�?nextDateReset �?Unix 时间戳（秒），需要转换为 ISO 字符�?      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    }
  } else {
    // 使用 CBOR API (GetUserUsageAndLimits)
    // CBOR API (app.kiro.dev) 是网页端门户，仅支持 BuilderId 认证
    // Enterprise/IdC 账号可能返回 401，需�?fallback �?REST API
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
      // CBOR 401/403 时自�?fallback �?REST API
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

// GetUserInfo API - 只需�?accessToken 即可调用
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

// 定义自定义协�?const PROTOCOL_PREFIX = 'kiro'

// electron-store 实例（延迟初始化�?let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// 最后保存的数据（用于崩溃恢复）
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
  
  // 尝试从备份恢复数据（如果主数据损坏）
  try {
    const backupPath = path.join(path.dirname(storeInstance.path), 'kiro-accounts.backup.json')
    const mainData = storeInstance.get('accountData')
    
    if (!mainData) {
      // 主数据不存在或损坏，尝试从备份恢�?      try {
        const backupContent = await fs.readFile(backupPath, 'utf-8')
        const backupData = JSON.parse(backupContent)
        if (backupData && backupData.accounts) {
          console.log('[Store] Restoring data from backup...')
          storeInstance.set('accountData', backupData)
          console.log('[Store] Data restored from backup successfully')
        }
      } catch {
        // 备份也不存在，忽�?      }
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }
}

// 创建数据备份
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

// ============ 托盘相关变量 ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // 标记是否真正退出应�?
// ============ 全局快捷键设�?============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// 加载快捷键设�?async function loadShortcutSettings(): Promise<void> {
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

// 保存快捷键设�?async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// 注册显示主窗口的快捷�?function registerShowWindowShortcut(): void {
  // 先注销所有已注册的快捷键
  globalShortcut.unregisterAll()
  
  if (!showWindowShortcut) return
  
  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢�?Dock 图标
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

// 加载托盘设置
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

// 保存托盘设置
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// 初始化托�?function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢�?Dock 图标
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

  // 设置初始提示
  setTrayTooltip(`Kiro 账号管理�?v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `Kiro 账号管理�?v${app.getVersion()}`,
    width: 1280,   // 刚好容纳 3 列卡�?(340*3 + 16*2 + 边距)
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 自定�?titlebar：mac 保留红绿黄灯 + 隐藏标题栏；win/linux 完全�?frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // 不透明窗口（关闭透明 + Mica/Vibrancy 避免桌面元素干扰�?    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ============ 自定�?titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // 设置带版本号的标题（HTML 加载后会覆盖初始标题�?    mainWindow?.setTitle(`Kiro 账号管理�?v${app.getVersion()}`)
    mainWindow?.show()
    
    // 检查代理服务自启动配置
    setTimeout(async () => {
      try {
        await initStore()
        if (!store) return
        
        const savedProxyConfig = store.get('proxyConfig') as ProxyConfig | undefined
        if (!savedProxyConfig?.autoStart) return
        
        console.log('[ProxyServer] Auto-starting proxy server...')
        const server = initProxyServer()
        server.updateConfig(savedProxyConfig)
        
        // 自启动时同步账号到代理池（含重试机制应对冷启动数据延迟）
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
          // 冷启动时 store 可能还没有数据（渲染进程尚未初始化完成），延迟重�?          console.log('[ProxyServer] No accounts found on initial sync, will retry...')
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

      // K-Proxy MITM 自启�?      try {
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
    // 托盘最小化逻辑 - 必须同步检查并调用 preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // 直接最小化到托�?        event.preventDefault()
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐�?Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // 询问用户 - 先阻止关闭，再异步处�?        event.preventDefault()
        // 通知渲染进程显示自定义对话框
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' 时继续关闭流�?    }

    // 窗口关闭前保存数据（同步保存，不等待备份�?    if (lastSavedData && store) {
      try {
        console.log('[Window] Saving data before close...')
        store.set('accountData', lastSavedData)
        // 备份异步进行，不阻塞关闭
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

// 注册自定义协�?function registerProtocol(): void {
  // 先注销旧的注册（防止上次异常退出未注销�?  unregisterProtocol()
  
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

// 注销自定义协�?(应用退出时调用)
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

// 处理协议 URL (用于 OAuth 回调)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 处理 auth 回调
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
  // 初始化日志系统（尽早拦截，确保所�?console 输出都进入日志存储）
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()

  // 注册自定义协�?  registerProtocol()

  // 加载托盘设置并初始化托盘
  await loadTraySettings()
  initTray()

  // 初始化自动更新（仅生产环境）
  if (!is.dev) {
    setupAutoUpdater()
    // 启动后延迟检查更�?    setTimeout(() => {
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

  // IPC: 打开外部链接
  ipcMain.on('open-external', (_event, url: string, usePrivateMode?: boolean) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (usePrivateMode) {
        openBrowserInPrivateMode(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  // ============ 注册功能 IPC ============
  registerRegistrationHandlers(() => mainWindow)

  // ============ 托盘相关 IPC ============

  // IPC: 获取托盘设置
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // ============ 自定�?titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: 获取显示主窗口快捷键
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: 设置显示主窗口快捷键
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

  // IPC: 保存托盘设置
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()
      
      // 根据设置启用/禁用托盘
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

  // IPC: 更新托盘账户信息（从渲染进程调用�?  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)
    
    // 更新托盘提示
    if (account) {
      setTrayTooltip(`Kiro 账号管理器\n当前账户: ${account.email}`)
    } else {
      setTrayTooltip(`Kiro 账号管理�?v${app.getVersion()}`)
    }
  })

  // IPC: 更新托盘账户列表（从渲染进程调用�?  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: 刷新托盘菜单
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: 更新托盘语言
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    updateTrayLanguage(language)
  })

  // IPC: 关闭确认对话框响�?  ipcMain.on('close-confirm-response', (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
    if (action === 'minimize') {
      mainWindow?.hide()
      // macOS: 隐藏窗口时隐�?Dock 图标
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide()
      }
    } else if (action === 'quit') {
      // 如果用户选择记住选择
      if (rememberChoice) {
        traySettings.closeAction = 'quit'
        saveTraySettings()
      }
      isQuitting = true
      app.quit()
    }
    // cancel 时不做任何操�?    
    // 如果用户选择记住"最小化"选择
    if (action === 'minimize' && rememberChoice) {
      traySettings.closeAction = 'minimize'
      saveTraySettings()
    }
  })

  // IPC: 获取应用版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // IPC: 检查更�?  ipcMain.handle('check-for-updates', async () => {
    if (is.dev) {
      return { hasUpdate: false, message: '开发环境不支持更新检�? }
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

  // IPC: 下载更新
  ipcMain.handle('download-update', async () => {
    if (is.dev) {
      return { success: false, message: '开发环境不支持更新' }
    }
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      console.error('[AutoUpdater] Download failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 安装更新并重�?  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // IPC: 手动检查更新（使用 GitHub API，用�?AboutPage�?  const GITHUB_REPO = 'chaogei/Kiro-account-manager'
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
          throw new Error('GitHub API 请求次数超限，请稍后再试')
        } else if (response.status === 404) {
          throw new Error('未找到发布版�?)
        }
        throw new Error(`GitHub API 错误: ${response.status}`)
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
      
      // 比较版本�?      const compareVersions = (v1: string, v2: string): number => {
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
        error: error instanceof Error ? error.message : '检查更新失�?
      }
    }
  })

  // IPC: 加载账号数据
  ipcMain.handle('load-accounts', async () => {
    try {
      await initStore()
      return store!.get('accountData', null)
    } catch (error) {
      console.error('Failed to load accounts:', error)
      return null
    }
  })

  // IPC: 保存账号数据
  ipcMain.handle('save-accounts', async (_event, data) => {
    try {
      await initStore()
      store!.set('accountData', data)
      
      // 保存最后的数据（用于崩溃恢复）
      lastSavedData = data
      
      // 每次保存时也创建备份
      await createBackup(data)
    } catch (error) {
      console.error('Failed to save accounts:', error)
      throw error
    }
  })

  // IPC: 刷新账号 Token（支�?IdC 和社交登录）
  ipcMain.handle('refresh-account-token', async (_event, account) => {
    try {
      const { refreshToken, clientId, clientSecret, region, authMethod } = account.credentials || {}

      if (!refreshToken) {
        return { success: false, error: { message: '缺少 Refresh Token' } }
      }

      // 社交登录只需�?refreshToken，IdC 登录需�?clientId �?clientSecret
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: { message: '缺少 OIDC 刷新凭证 (clientId/clientSecret)' } }
      }

      console.log(`[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...`)

      // 根据 authMethod 选择刷新方式
      const refreshResult = await refreshTokenByMethod(
        refreshToken,
        clientId || '',
        clientSecret || '',
        region || 'us-east-1',
        authMethod
      )

      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: { message: refreshResult.error || 'Token 刷新失败' } }
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

  // IPC: �?SSO Token 导入账号 (x-amz-sso_authn)
  ipcMain.handle('import-from-sso-token', async (_event, bearerToken: string, region: string = 'us-east-1') => {
    console.log('[IPC] import-from-sso-token called')
    
    try {
      // 执行 SSO 设备授权流程
      const ssoResult = await ssoDeviceAuth(bearerToken, region)
      
      if (!ssoResult.success || !ssoResult.accessToken) {
        return { success: false, error: { message: ssoResult.error || 'SSO 授权失败' } }
      }

      // 并行获取用户信息和使用量
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

      // 解析使用量数�?      const creditUsage = usageData?.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'
      
      // 规范化订阅类型（注意检查顺序：先检查更具体的类型）
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

      // 基础额度（使用精确小数）
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

      // 试用额度（使用精确小数）
      let freeTrialLimit = 0, freeTrialCurrent = 0, freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 奖励额度（使用精确小数）
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

  // IPC: 检查账号状态（支持自动刷新 Token�?  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      status?: string
      expiresAt?: string  // API 返回的是 expiresAt
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

    // 解析 API 响应的辅助函�?    const parseUsageResponse = (result: UsageResponse, newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresIn?: number
    }, userInfo?: UserInfoResponse) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || 'unknown'}]`, result)

      // 解析 Credits 使用量（resourceType �?CREDIT�?      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // 解析使用量（详细，使用精确小数）
      // 基础额度
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // 试用额度
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // 奖励额度
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
      
      // 计算总额�?      const totalLimit = baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      const nextResetDate = result.nextDateReset

      // 解析订阅类型
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 解析重置时间并计算剩余天�?      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime()
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // 资源详情
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
          // 如果刷新�?token，返回新的凭�?          newCredentials: newCredentials ? {
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
      
      // 确定正确�?idp：优先使�?credentials.provider，否则回退�?account.idp
      // 社交登录使用实际�?provider (Github/Google)，IdC 使用 BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!accessToken) {
        console.log('[IPC] Missing accessToken')
        return { success: false, error: { message: '缺少 accessToken' } }
      }

      // 获取账户绑定的设�?ID
      const accountMachineId = account?.machineId as string | undefined

      // 第一次尝试：使用当前 accessToken
      try {
        // 并行调用 GetUserInfo �?getUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          getUserInfo(accessToken, idp, accountMachineId, account?.email).catch((err: Error) => {
            // 封禁错误不能吞掉，必须向上抛�?            if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
              throw err
            }
            return undefined
          }),
          getUsageAndLimits(accessToken, idp, undefined, accountMachineId, region, account?.email)
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''
        
        // 检查是否是明确封禁错误�?23 �?AccountSuspendedException�?        if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
          console.log('[IPC] Account suspended/banned')
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          }
        }
        
        // 检查是否是 401 错误（token 过期�?        // 社交登录只需�?refreshToken，IdC 登录需�?clientId �?clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          console.log(`[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...`)
          
          // 尝试刷新 token - 根据 authMethod 选择刷新方式
          const refreshResult = await refreshTokenByMethod(
            refreshToken,
            clientId || '',
            clientSecret || '',
            region || 'us-east-1',
            authMethod
          )
          
          if (refreshResult.success && refreshResult.accessToken) {
            console.log('[IPC] Token refreshed, retrying API call...')
            
            // 用新 token 并行调用 GetUserInfo �?getUsageAndLimits
            const [userInfoResult, usageResult] = await Promise.all([
              getUserInfo(refreshResult.accessToken, idp, accountMachineId).catch((err: Error) => {
                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return undefined
              }),
              getUsageAndLimits(refreshResult.accessToken, idp, undefined, accountMachineId, region)
            ])
            
            // 返回结果并包含新凭证
            return parseUsageResponse(usageResult, {
              accessToken: refreshResult.accessToken,
              refreshToken: refreshResult.refreshToken,
              expiresIn: refreshResult.expiresIn
            }, userInfoResult)
          } else {
            console.error('[IPC] Token refresh failed:', refreshResult.error)
            return {
              success: false,
              error: { message: `Token 过期且刷新失�? ${refreshResult.error}` }
            }
          }
        }
        
        // 不是 401 或没有刷新凭证，抛出原错�?        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 后台批量刷新账号（在主进程执行，不阻�?UI�?  ipcMain.handle('background-batch-refresh', async (_event, accounts: Array<{
    id: string
    idp?: string
    needsTokenRefresh?: boolean
    machineId?: string  // 账户绑定的设�?ID
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

    // 串行处理每批，避免并发过�?    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)
      
      await Promise.allSettled(
        batch.map(async (account) => {
          try {
            const { refreshToken, clientId, clientSecret, region, authMethod, accessToken, provider } = account.credentials
            const needsTokenRefresh = account.needsTokenRefresh !== false // 默认�?true（兼容旧版本�?            
            // 确定正确�?idp
            let idp = 'BuilderId'
            if (authMethod === 'social') {
              idp = provider || account.idp || 'BuilderId'
            } else if (provider) {
              idp = provider
            }
            
            let newAccessToken = accessToken
            let newRefreshToken = refreshToken
            let newExpiresIn: number | undefined

            // 只有需要刷�?Token 时才刷新
            if (needsTokenRefresh) {
              if (!refreshToken) {
                failed++
                completed++
                return
              }

              // 刷新 Token
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
                // 通知渲染进程刷新失败
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

            // 获取账号信息
            if (!newAccessToken) {
              failed++
              completed++
              return
            }

            // 根据 syncInfo 决定是否检测账户信�?            let parsedUsage: {
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
              // 调用 getUsageAndLimits API（根据配置选择 REST �?CBOR 格式�?              try {
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
                
                // 解析使用量数�?                const creditUsage = rawUsage.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
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
                
                // 解析订阅信息（注意检查顺序：先检查更具体的类型）
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
                
                // 计算剩余天数和到期时�?                let daysRemaining: number | undefined
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

              // 调用 GetUserInfo API 获取用户状�?              try {
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

            // 通知渲染进程更新账号
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

      // 通知进度
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 批次间延迟，让主进程有喘息时�?      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  })

  // IPC: 后台批量检查账号状态（不刷�?Token，只检查状态）
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

    // 串行处理每批
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
                error: '缺少 accessToken'
              })
              return
            }

            // 确定 idp
            let idp = account.idp || 'BuilderId'
            if (authMethod === 'social' && provider) {
              idp = provider
            }

            // 调用 API 获取用量和用户信息（根据配置选择 REST �?CBOR 格式�?            const [usageRes, userInfoRes] = await Promise.allSettled([
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
                // 封禁错误不能吞掉，需要在后续逻辑中检�?                if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                  throw err
                }
                return null
              })
            ])

            // 解析响应（kiroApiRequest 直接返回数据或抛出异常）
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

            // 处理用量响应
            if (usageRes.status === 'fulfilled') {
              const rawUsage = usageRes.value
              // 解析 Credits 使用量（和单个检查一致）
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
              
              // 解析 bonuses
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

              // 解析资源详情（含超额信息�?              if (creditUsage) {
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

              // 解析订阅信息（注意检查顺序：先检查更具体的类型）
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
              
              // 计算剩余天数和到期时�?              let daysRemaining: number | undefined
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
              // API 调用失败（可能是封禁�?Token 过期�?              const errorMsg = usageRes.reason?.message || String(usageRes.reason)
              console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
              if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
                status = 'error'
                errorMessage = errorMsg
              } else if (errorMsg.includes('401')) {
                status = 'expired'
                errorMessage = 'Token 已过期，请刷�?
              } else {
                status = 'error'
                errorMessage = errorMsg
              }
            }

            // 处理用户信息响应
            if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
              const rawUserInfo = userInfoRes.value
              userInfoData = {
                email: rawUserInfo.email,
                userId: rawUserInfo.userId,
                status: rawUserInfo.status
              }
              // 检查用户状态（Stale 视为正常，仅 Suspended/Disabled 等视为异常）
              if (rawUserInfo.status && rawUserInfo.status !== 'Active' && rawUserInfo.status !== 'Stale' && status !== 'error') {
                status = 'error'
                errorMessage = `用户状态异�? ${rawUserInfo.status}`
              }
            } else if (userInfoRes.status === 'rejected') {
              // GetUserInfo 失败（封禁错误会到这里）
              const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
              if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
                status = 'error'
                errorMessage = errMsg
              }
            }

            success++
            completed++

            // 通知渲染进程更新账号
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

      // 通知进度
      mainWindow?.webContents.send('background-check-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 批次间延�?      if (i + concurrency < accounts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  })

  // IPC: 导出到文�?  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出账号数据',
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

  // IPC: 从文件导�?  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '导入账号数据',
        filters: [
          { name: '所有支持的格式', extensions: ['json', 'csv', 'txt'] },
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

  // IPC: 验证凭证并获取账号信息（用于添加账号�?  ipcMain.handle('verify-account-credentials', async (_event, credentials: {
    refreshToken: string
    clientId: string
    clientSecret: string
    region?: string
    authMethod?: string
    provider?: string  // 'BuilderId', 'Github', 'Google' �?  }) => {
    console.log('[IPC] verify-account-credentials called')
    
    try {
      const { refreshToken, clientId, clientSecret, region = 'us-east-1', authMethod, provider } = credentials
      // 确定 idp：社交登录使�?provider，IdC 也需要根�?provider 区分 BuilderId �?Enterprise
      const idp = provider && (provider === 'Enterprise' || provider === 'Github' || provider === 'Google') 
        ? provider 
        : 'BuilderId'
      
      // 社交登录只需�?refreshToken，IdC 需�?clientId �?clientSecret
      if (!refreshToken) {
        return { success: false, error: '请填�?Refresh Token' }
      }
      if (authMethod !== 'social' && (!clientId || !clientSecret)) {
        return { success: false, error: '请填�?Client ID �?Client Secret' }
      }
      
      // Step 1: 使用合适的方式刷新获取 accessToken
      console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
      const refreshResult = await refreshTokenByMethod(refreshToken, clientId, clientSecret, region, authMethod)
      
      if (!refreshResult.success || !refreshResult.accessToken) {
        return { success: false, error: `Token 刷新失败: ${refreshResult.error}` }
      }
      
      console.log('[Verify] Step 2: Getting user info...')
      
      // Step 2: 调用 GetUserUsageAndLimits 获取用户信息
      interface Bonus {
        bonusCode?: string
        displayName?: string
        usageLimit?: number
        usageLimitWithPrecision?: number
        currentUsage?: number
        currentUsageWithPrecision?: number
        status?: string
        expiresAt?: string  // API 返回的是 expiresAt
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
      
      // 解析用户信息
      const email = usageResult.userInfo?.email || ''
      const userId = usageResult.userInfo?.userId || ''
      
      // 解析订阅类型（注意检查顺序：先检查更具体的类型）
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
      
      // 解析使用量（详细，使用精确小数）
      const creditUsage = usageResult.usageBreakdownList?.find(b => b.resourceType === 'CREDIT')
      
      // 基础额度
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
      
      // 试用额度
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit = creditUsage.freeTrialInfo.usageLimitWithPrecision ?? creditUsage.freeTrialInfo.usageLimit ?? 0
        freeTrialCurrent = creditUsage.freeTrialInfo.currentUsageWithPrecision ?? creditUsage.freeTrialInfo.currentUsage ?? 0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }
      
      // 奖励额度
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
      
      // 计算总额�?      const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)
      
      // 计算重置剩余天数
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
      return { success: false, error: error instanceof Error ? error.message : '验证失败' }
    }
  })

  // IPC: 获取本地 SSO 缓存中当前使用的账号信息
  ipcMain.handle('get-local-active-account', async () => {
    const os = await import('os')
    const path = await import('path')
    
    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      
      const tokenContent = await readFile(tokenPath, 'utf-8')
      const tokenData = JSON.parse(tokenContent)
      
      if (!tokenData.refreshToken) {
        return { success: false, error: '本地缓存中没�?refreshToken' }
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
      return { success: false, error: '无法读取本地 SSO 缓存' }
    }
  })

  // IPC: �?Kiro 本地配置导入凭证
  ipcMain.handle('load-kiro-credentials', async () => {
    const os = await import('os')
    const path = await import('path')
    const crypto = await import('crypto')
    const fs = await import('fs/promises')
    
    try {
      // �?~/.aws/sso/cache/kiro-auth-token.json 读取 token
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
        return { success: false, error: '找不�?kiro-auth-token.json 文件，请先在 Kiro IDE 中登�? }
      }
      
      if (!tokenData.refreshToken) {
        return { success: false, error: 'kiro-auth-token.json 中缺�?refreshToken' }
      }
      
      // 确定 clientIdHash：优先使用文件中的，否则计算默认�?      let clientIdHash = tokenData.clientIdHash
      if (!clientIdHash) {
        // 使用标准�?startUrl 计算 hash（与 Kiro 客户端一致）
        const startUrl = 'https://view.awsapps.com/start'
        clientIdHash = crypto.createHash('sha1')
          .update(JSON.stringify({ startUrl }))
          .digest('hex')
        console.log('[Kiro Credentials] Calculated clientIdHash:', clientIdHash)
      }
      
      // 读取客户端注册信�?      let clientRegPath = path.join(ssoCache, `${clientIdHash}.json`)
      console.log('[Kiro Credentials] Trying client registration from:', clientRegPath)
      
      let clientData: {
        clientId?: string
        clientSecret?: string
      } | null = null
      
      try {
        const clientContent = await readFile(clientRegPath, 'utf-8')
        clientData = JSON.parse(clientContent)
      } catch {
        // 如果找不到，尝试搜索目录中的其他 .json 文件（排�?kiro-auth-token.json�?        console.log('[Kiro Credentials] Client file not found, searching cache directory...')
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
                // 忽略无法解析的文�?              }
            }
          }
        } catch {
          // 忽略目录读取错误
        }
      }
      
      // 社交登录不需�?clientId/clientSecret
      const isSocialAuth = tokenData.authMethod === 'social'
      
      if (!isSocialAuth && (!clientData || !clientData.clientId || !clientData.clientSecret)) {
        return { success: false, error: '找不到客户端注册文件，请确保已在 Kiro IDE 中完成登�? }
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
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  })

  // IPC: 切换账号 - 写入凭证到本�?SSO 缓存
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

      // 切号前先刷新 token，确保写入的 accessToken 是最新的
      // Kiro IDE 会直接使�?accessToken（不过期就不刷新），�?token 会导�?Invalid token
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
      
      // 计算 clientIdHash (�?Kiro 客户端一�?
      // Enterprise 账户使用自己�?startUrl，BuilderId 使用默认�?      const effectiveStartUrl = startUrl || 'https://view.awsapps.com/start'
      const clientIdHash = crypto.createHash('sha1')
        .update(JSON.stringify({ startUrl: effectiveStartUrl }))
        .digest('hex')
      
      // 确保目录存在
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      await mkdir(ssoCache, { recursive: true })
      
      // 根据 provider 推导 profileArn（官方固定规则）
      const SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
      const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
      const resolvedProfileArn = profileArn
        || (authMethod === 'social' || provider === 'Google' || provider === 'Github' ? SOCIAL_PROFILE_ARN : BUILDER_ID_PROFILE_ARN)

      // 写入 token 文件（格式与官方 Kiro IDE 完全一致）
      const tokenPath = path.join(ssoCache, 'kiro-auth-token.json')
      const tokenData: Record<string, unknown> = authMethod === 'social'
        ? {
            // Social 登录格式：accessToken, refreshToken, profileArn, expiresAt, authMethod, provider
            accessToken,
            refreshToken,
            profileArn: resolvedProfileArn,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            authMethod,
            provider
          }
        : {
            // IdC 登录格式：accessToken, refreshToken, expiresAt, clientIdHash, authMethod, provider, region
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
      
      // 只有 IdC 登录需要写入客户端注册文件
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
      return { success: false, error: error instanceof Error ? error.message : '切换失败' }
    }
  })

  // IPC: 切换账号�?Kiro CLI - 写入凭证�?SQLite 数据�?  // kiro-cli 使用 ~/.local/share/kiro-cli/data.sqlite3 中的 auth_kv �?  ipcMain.handle('switch-account-cli', async (_event, credentials: {
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

      // 切号前先刷新 token（和 IDE 切号一致）
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

      // kiro-cli SQLite 数据库路�?      // Windows: %LOCALAPPDATA%\kiro-cli\data.sqlite3
      // macOS/Linux: ~/.local/share/kiro-cli/data.sqlite3
      const dataDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'kiro-cli')
        : path.join(os.homedir(), '.local', 'share', 'kiro-cli')
      await mkdir(dataDir, { recursive: true })
      const dbPath = path.join(dataDir, 'data.sqlite3')

      // 判断 token key：social 登录�?social:token，IdC 登录�?odic:token
      const isSocial = provider === 'Google' || provider === 'Github'
      const preferredTokenKey = isSocial ? 'kirocli:social:token' : 'kirocli:odic:token'
      const preferredRegKey = 'kirocli:odic:device-registration'

      // 根据 provider 推导 profileArn
      const SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
      const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
      const resolvedProfileArn = profileArn || (isSocial ? SOCIAL_PROFILE_ARN : BUILDER_ID_PROFILE_ARN)

      // 构建 token JSON（snake_case 字段名，�?kiro-cli Rust 结构一致）
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString()
      const tokenData: Record<string, unknown> = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        region,
        profile_arn: resolvedProfileArn
      }
      if (scopes) tokenData.scopes = scopes

      // 使用 sqlite3 命令行操作（跨平台兼容，无需原生模块编译�?      const { execFileSync } = await import('child_process')
      const sqlite3Bin = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3'

      // 构建 SQL 语句
      const sqlStatements: string[] = [
        'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
        `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredTokenKey}', '${JSON.stringify(tokenData).replace(/'/g, "''")}');`
      ]

      // 写入 device-registration（仅 IdC 登录�?      if (clientId && clientSecret && !isSocial) {
        const regData = { client_id: clientId, client_secret: clientSecret, region }
        sqlStatements.push(
          `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${preferredRegKey}', '${JSON.stringify(regData).replace(/'/g, "''")}');`
        )
      }

      // 清除其他优先级的�?key
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
        // sqlite3 命令不存在，尝试�?Node.js 22+ 的内�?SQLite
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
          throw new Error(`SQLite 操作失败: sqlite3 命令不可�?(${(sqlite3Error as Error).message})，且 Node.js 内置 SQLite 不支持。请确保系统安装�?sqlite3 命令行工具。`)
        }
      }

      console.log(`[Switch CLI] Token saved to SQLite key: ${preferredTokenKey}`)
      console.log(`[Switch CLI] Account switched successfully in ${dbPath}`)
      return { success: true, dbPath }
    } catch (error) {
      console.error('[Switch CLI] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'CLI 切换失败' }
    }
  })


  // IPC: 退出登�?- 清除本地 SSO 缓存
  ipcMain.handle('logout-account', async () => {
    const os = await import('os')
    const path = await import('path')
    const { readdir, unlink } = await import('fs/promises')
    
    try {
      const ssoCache = path.join(os.homedir(), '.aws', 'sso', 'cache')
      console.log('[Logout] Clearing SSO cache:', ssoCache)
      
      // 读取目录下所有文�?      const files = await readdir(ssoCache).catch(() => [])
      
      // 删除所有文�?      for (const file of files) {
        const filePath = path.join(ssoCache, file)
        await unlink(filePath).catch((e) => {
          console.warn('[Logout] Failed to delete file:', filePath, e)
        })
      }
      
      console.log('[Logout] SSO cache cleared, deleted', files.length, 'files')
      return { success: true, deletedCount: files.length }
    } catch (error) {
      console.error('[Logout] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '退出失�? }
    }
  })

  // ============ 手动登录相关 IPC ============

  // 存储当前登录状�?  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO 相关
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO 专用
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth 相关
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 启动 Builder ID 手动登录
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
      // Step 1: 注册 OIDC 客户�?      console.log('[Login] Step 1: Registering OIDC client...')
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
        return { success: false, error: `注册客户端失�? ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 发起设备授权
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `设备授权失败: ${errText}` }
      }

      const authData = await authRes.json()
      const { deviceCode, userCode, verificationUri, verificationUriComplete, interval = 5, expiresIn = 600 } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 保存登录状�?      currentLoginState = {
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
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 Builder ID 授权状�?  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '没有进行中的登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开�? }
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
          return { success: false, error: '设备码已过期' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '用户拒绝授权' }
        } else {
          currentLoginState = null
          return { success: false, error: `授权错误: ${error}` }
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '轮询失败' }
    }
  })

  // IPC: 取消 Builder ID 登录
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO 本地服务器和状�?  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
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

  // IPC: 启动 IAM Identity Center SSO 登录 (使用 Authorization Code Grant with PKCE)
  ipcMain.handle('start-iam-sso-login', async (_event, startUrl: string, region: string = 'us-east-1') => {
    console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
    console.log('[Login] Start URL:', startUrl)
    
    // 验证 startUrl 格式
    if (!startUrl || !startUrl.startsWith('https://')) {
      return { success: false, error: 'SSO Start URL 必须�?https:// 开�? }
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
      // Step 1: 注册 OIDC 客户�?(使用 authorization_code grant type)
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
            error: '授权失败：您的组织可能未配置 Amazon Q Developer 访问权限。请联系组织管理员在 IAM Identity Center 中启用相关权限�? 
          }
        }
        
        return { success: false, error: `注册客户端失�? ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 生成 PKCE �?state
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomUUID()

      // Step 3: 启动本地 HTTP 服务器接收回�?      console.log('[Login] Step 2: Starting local OAuth callback server...')
      
      // 关闭之前的服务器
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }

      // 找一个可用端�?      const port = await new Promise<number>((resolve, reject) => {
        const server = http.createServer()
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            const p = addr.port
            server.close(() => resolve(p))
          } else {
            reject(new Error('无法获取端口'))
          }
        })
      })

      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      console.log('[Login] Redirect URI:', redirectUri)

      // 重置结果
      iamSsoResult = null

      // 创建回调服务�?      iamSsoServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${port}`)
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          
          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>您可以关闭此窗口�?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: `授权失败: ${error}` }
            return
          }
          
          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>状态不匹配，请重试�?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '状态不匹配' }
            return
          }
          
          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权成功�?/h1><p>正在获取令牌，请稍�?..</p></body></html>')
            
            // 自动完成 token 交换
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
                iamSsoResult = { completed: true, success: false, error: `获取 Token 失败: ${errText}` }
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
                error: tokenError instanceof Error ? tokenError.message : '获取 Token 失败' 
              }
            }
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<html><body><h1>授权失败</h1><p>未收到授权码�?/p></body></html>')
            iamSsoResult = { completed: true, success: false, error: '未收到授权码' }
          }
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      iamSsoServer.listen(port, '127.0.0.1', () => {
        console.log('[Login] OAuth callback server listening on port', port)
      })

      // Step 4: 构建授权 URL 并打开浏览�?      const authorizeParams = new URLSearchParams({
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

      // 保存登录状�?      currentLoginState = {
        type: 'iamsso',
        clientId,
        clientSecret,
        codeVerifier,
        redirectUri,
        region,
        startUrl,
        expiresAt: Date.now() + 600000
      }

      // 返回授权 URL，前端会打开浏览�?      return {
        success: true,
        authorizeUrl,
        expiresIn: 600
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 IAM SSO 授权状�?(检查本地服务器是否收到回调)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: '没有进行中的 IAM SSO 登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开�? }
    }

    // 检查是否已收到回调并完�?token 交换
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // 清理状�?        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // 还在等待回调
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: 取消 IAM SSO 登录
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

  // IPC: 启动 Social Auth 登录 (Google/GitHub)
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
    console.log(`[Login] Starting ${provider} Social Auth login... (privateMode: ${usePrivateMode})`)
    
    const crypto = await import('crypto')

    // 生成 PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // 构建登录 URL
    const redirectUri = 'kiro://kiro.kiroAgent/authenticate-success'
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // 保存登录状�?    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    const urlStr = loginUrl.toString()
    console.log(`[Login] Opening browser for ${provider} login...`)

    // 根据是否使用隐私模式选择打开方式
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

  // IPC: 交换 Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '没有进行中的社交登录' }
    }

    // 验证 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '状态参数不匹配，可能存在安全风�? }
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
        return { success: false, error: `Token 交换失败: ${errText}` }
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
      return { success: false, error: error instanceof Error ? error.message : 'Token 交换失败' }
    }
  })

  // IPC: 取消 Social Auth 登录
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 设置代理
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    console.log(`[IPC] set-proxy called: enabled=${enabled}, url=${url}`)
    try {
      applyProxySettings(enabled, url)
      
      // 同时设置 Electron �?session 代理
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

  // ============ Kiro 设置管理 IPC ============

  // IPC: 获取 Kiro 设置
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
      
      // 读取 Kiro settings.json (VS Code 风格 JSON，可能有尾随逗号)
      if (fs.existsSync(kiroSettingsPath)) {
        const content = fs.readFileSync(kiroSettingsPath, 'utf-8')
        // 移除尾随逗号和注释以兼容标准 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 移除单行注释
          .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
          .replace(/,(\s*[}\]])/g, '$1') // 移除尾随逗号
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
      
      // 读取 MCP 配置
      if (fs.existsSync(kiroMcpUserPath)) {
        const mcpContent = fs.readFileSync(kiroMcpUserPath, 'utf-8')
        mcpConfig = JSON.parse(mcpContent)
      }
      
      // 读取 Steering 文件列表
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

  // IPC: 获取 Kiro 可用模型列表（使用当前账号调用官�?API�?  ipcMain.handle('get-kiro-available-models', async () => {
    try {
      if (!store) return { models: [] }
      const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
      if (!accountData?.accounts) return { models: [] }

      // 优先使用当前激活账号（isActive），其次使用第一�?active 且有 accessToken 的账�?      const allAccounts = Object.values(accountData.accounts) as any[]
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

  // IPC: 保存 Kiro 设置
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
        // 移除尾随逗号和注释以兼容标准 JSON
        const cleanedContent = content
          .replace(/\/\/.*$/gm, '') // 移除单行注释
          .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
          .replace(/,(\s*[}\]])/g, '$1') // 移除尾随逗号
        existingSettings = JSON.parse(cleanedContent)
      }
      
      // 映射设置�?Kiro 的格�?      const kiroSettings = {
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
      
      // 确保目录存在
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

  // IPC: 打开 Kiro MCP 配置文件
  ipcMain.handle('open-kiro-mcp-config', async (_event, type: 'user' | 'workspace') => {
    try {
      const os = await import('os')
      const path = await import('path')
      const homeDir = os.homedir()
      
      let configPath: string
      if (type === 'user') {
        configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      } else {
        // 工作区配置，打开当前工作区的 .kiro/settings/mcp.json
        configPath = path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
      }
      
      // 如果文件不存在，创建空配�?      const fs = await import('fs')
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

  // IPC: 打开 Kiro Steering 目录
  ipcMain.handle('open-kiro-steering-folder', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      
      // 如果目录不存在，创建�?      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      shell.openPath(steeringPath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to open steering folder:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open steering folder' }
    }
  })

  // IPC: 打开 Kiro settings.json 文件
  ipcMain.handle('open-kiro-settings-file', async () => {
    try {
      const os = await import('os')
      const path = await import('path')
      const fs = await import('fs')
      const homeDir = os.homedir()
      const settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
      
      // 如果文件不存在，创建默认配置
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

  // IPC: 打开指定�?Steering 文件
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

  // IPC: 创建默认�?rules.md 文件
  ipcMain.handle('create-kiro-default-rules', async () => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const rulesPath = path.join(steeringPath, 'rules.md')
      
      // 确保目录存在
      if (!fs.existsSync(steeringPath)) {
        fs.mkdirSync(steeringPath, { recursive: true })
      }
      
      // 默认规则内容
      const defaultContent = `# Role: 高级软件开发助�?一、系统为Windows10
二、调式文件、测试脚本、test相关文件都放在test文件夹里面，md文件放在docs文件夹里�?# 核心原则


## 1. 沟通与协作
- **诚实优先**：在任何情况下都严禁猜测或伪装。当需求不明确、存在技术风险或遇到知识盲区时，必须停止工作，并立即向用户澄清�?- **技术攻�?*：面对技术难题时，首要目标是寻找并提出高质量的解决方案。只有在所有可行方案均被评估后，才能与用户探讨降级或替换方案�?- **批判性思维**：在执行任务时，如果发现当前需求存在技术限制、潜在风险或有更优的实现路径，必须主动向用户提出你的见解和改进建议�?- **语言要求**：思考和回答时总是使用中文进行回复�?

## 2. 架构设计
- **模块化设�?*：所有设计都必须遵循功能解耦、职责单一的原则。严格遵守SOLID和DRY原则�?- **前瞻性思维**：在设计时必须考虑未来的可扩展性和可维护性，确保解决方案能够融入项目的整体架构�?- **技术债务优先**：在进行重构或优化时，优先处理对系统稳定性和可维护性影响最大的技术债务和基础架构问题�?

## 3. 代码与交付物质量标准
### 编写规范
- **架构视角**：始终从整体项目架构出发编写代码，确保代码片段能够无缝集成，而不是孤立的功能�?- **零技术债务**：严禁创建任何形式的技术债务，包括但不限于：临时文件、硬编码值、职责不清的模块或函数�?- **问题暴露**：禁止添加任何用于掩盖或绕过错误的fallback机制。代码应设计为快速失败（Fail-Fast），确保问题在第一时间被发现�?

### 质量要求
- **可读�?*：使用清晰、有意义的变量名和函数名。代码逻辑必须清晰易懂，并辅以必要的注释�?- **规范遵循**：严格遵循目标编程语言的社区最佳实践和官方编码规范�?- **健壮�?*：必须包含充分的错误处理逻辑和边界条件检查�?- **性能意识**：在保证代码质量和可读性的前提下，对性能敏感部分进行合理优化，避免不必要的计算复杂度和资源消耗�?

### 交付物规�?- **无文�?*：除非用户明确要求，否则不要创建任何Markdown文档或其他形式的说明文档�?- **无测�?*：除非用户明确要求，否则不要编写单元测试或集成测试代码�?- **无编�?运行**：禁止编译或执行任何代码。你的任务是生成高质量的代码和设计方案�?

# 注意事项
- 除非特别说明否则不要创建新的文档、不要测试、不要编译、不要运行、不需要总结，除非用户主动要�?

- 需求不明确时使向用户询问澄清，提供预定义选项
- 在有多个方案的时候，需要向用户询问，而不是自作主�?- 在有方案/策略需要更新时，需要向用户询问，而不是自作主�?

- ACE为augmentContextEngine工具的缩�?- 如果要求查看文档请使�?Context7 MCP
- 如果需要进行WEB前端页面测试请使�?Playwright MCP
- 如果用户回复'继续' 则请按照最佳实践继续完成任�?`
      
      fs.writeFileSync(rulesPath, defaultContent, 'utf-8')
      console.log('[KiroSettings] Created default rules.md at:', rulesPath)
      
      // 打开文件
      shell.openPath(rulesPath)
      
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to create default rules:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create default rules' }
    }
  })

  // IPC: 读取 Steering 文件内容
  ipcMain.handle('read-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存�? }
      }
      
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      console.error('[KiroSettings] Failed to read steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' }
    }
  })

  // IPC: 保存 Steering 文件内容
  ipcMain.handle('save-kiro-steering-file', async (_event, filename: string, content: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const steeringPath = path.join(homeDir, '.kiro', 'steering')
      const filePath = path.join(steeringPath, filename)
      
      // 确保目录存在
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

  // ============ Kiro API 反代服务�?IPC ============

  // IPC: 启动反代服务�?  ipcMain.handle('proxy-start', async (_event, config?: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      if (config) {
        server.updateConfig(config)
      }
      await server.start()
      // 更新托盘菜单状�?      updateTrayMenu()
      return { success: true, port: server.getConfig().port }
    } catch (error) {
      console.error('[ProxyServer] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy server' }
    }
  })

  // IPC: 停止反代服务�?  ipcMain.handle('proxy-stop', async () => {
    try {
      if (proxyServer) {
        await proxyServer.stop()
      }
      // 更新托盘菜单状�?      updateTrayMenu()
      return { success: true }
    } catch (error) {
      console.error('[ProxyServer] Stop failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop proxy server' }
    }
  })

  // IPC: 获取反代服务器状�?  ipcMain.handle('proxy-get-status', () => {
    if (!proxyServer) {
      // 未初始化时从 store 读取保存的配�?      const savedConfig = store?.get('proxyConfig') as ProxyConfig | undefined
      return { running: false, config: savedConfig || null, stats: null, sessionStats: null }
    }
    return {
      running: proxyServer.isRunning(),
      config: proxyServer.getConfig(),
      stats: proxyServer.getStats(),
      sessionStats: proxyServer.getSessionStats()
    }
  })

  // IPC: 重置累计 credits
  ipcMain.handle('proxy-reset-credits', () => {
    if (proxyServer) {
      proxyServer.resetTotalCredits()
    }
    if (store) {
      store.set('proxyTotalCredits', 0)
    }
    return { success: true }
  })

  // IPC: 重置累计 tokens
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

  // IPC: 重置请求统计
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

  // IPC: 获取反代日志
  ipcMain.handle('proxy-get-logs', (_event, count?: number) => {
    if (count) {
      return proxyLogStore.getLast(count)
    }
    return proxyLogStore.getAll()
  })

  // IPC: 清除反代日志
  ipcMain.handle('proxy-clear-logs', () => {
    proxyLogStore.clear()
    return { success: true }
  })

  // IPC: 获取反代日志数量
  ipcMain.handle('proxy-get-logs-count', () => {
    return proxyLogStore.count()
  })

  // IPC: 获取 Usage API 类型
  ipcMain.handle('get-usage-api-type', () => {
    return currentUsageApiType
  })

  // IPC: 设置 Usage API 类型
  ipcMain.handle('set-usage-api-type', (_event, type: 'rest' | 'cbor') => {
    setUsageApiType(type)
    // 保存�?store
    if (store) {
      store.set('usageApiType', type)
    }
    return { success: true, type }
  })

  // IPC: 获取是否使用 K-Proxy 代理
  ipcMain.handle('get-use-kproxy-for-api', () => {
    return getUseKProxyForApi()
  })

  // IPC: 设置是否使用 K-Proxy 代理
  ipcMain.handle('set-use-kproxy-for-api', (_event, enabled: boolean) => {
    setUseKProxyForApi(enabled)
    // 保存�?store
    if (store) {
      store.set('useKProxyForApi', enabled)
    }
    return { success: true, enabled }
  })

  // IPC: 更新反代服务器配�?  ipcMain.handle('proxy-update-config', async (_event, config: Partial<ProxyConfig>) => {
    try {
      const server = initProxyServer()
      server.updateConfig(config)
      const newConfig = server.getConfig()
      // 同步流式日志开�?      if (config.logStreamEvents !== undefined) {
        setLogStreamEvents(config.logStreamEvents)
      }
      // 同步 payload 大小限制
      if (config.payloadSizeLimitKB !== undefined) {
        setPayloadSizeLimitKB(config.payloadSizeLimitKB)
      }
      // 同步 Token buffer reserve
      if (config.tokenBufferReserve !== undefined) {
        setTokenBufferReserve(config.tokenBufferReserve)
      }
      // 保存配置�?store（用于自启动�?      if (store) {
        store.set('proxyConfig', newConfig)
      }
      return { success: true, config: newConfig }
    } catch (error) {
      console.error('[ProxyServer] Update config failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update config' }
    }
  })

  // ============ API Key 管理 IPC ============

  // IPC: 获取所�?API Keys
  ipcMain.handle('proxy-get-api-keys', () => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      return { success: true, apiKeys: config.apiKeys || [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get API keys', apiKeys: [] }
    }
  })

  // IPC: 添加 API Key
  ipcMain.handle('proxy-add-api-key', async (_event, apiKey: { name: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }) => {
    try {
      const crypto = await import('crypto')
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      // 根据格式生成随机 Key
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

  // IPC: 更新 API Key
  ipcMain.handle('proxy-update-api-key', (_event, id: string, updates: Partial<import('./proxy/types').ApiKey>) => {
    try {
      const server = initProxyServer()
      const config = server.getConfig()
      const apiKeys = config.apiKeys || []
      
      const index = apiKeys.findIndex(k => k.id === id)
      if (index === -1) {
        return { success: false, error: 'API key not found' }
      }
      
      // 更新字段（不允许更新 id、createdAt、usage�?      const { id: _, createdAt: __, usage: ___, ...allowedUpdates } = updates
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

  // IPC: 删除 API Key
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

  // IPC: 重置 API Key 用量统计
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

  // IPC: 添加账号到反代池
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

  // IPC: 从反代池移除账号
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

  // IPC: 同步账号到反代池（批量更新）
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

  // IPC: 获取反代池账号列�?  ipcMain.handle('proxy-get-accounts', () => {
    if (!proxyServer) {
      return { accounts: [], availableCount: 0 }
    }
    const pool = proxyServer.getAccountPool()
    return {
      accounts: pool.getAllAccounts(),
      availableCount: pool.availableCount
    }
  })

  // IPC: 刷新模型缓存
  ipcMain.handle('proxy-refresh-models', () => {
    if (!proxyServer) {
      return { success: false, error: 'Proxy server not initialized' }
    }
    proxyServer.clearModelCache()
    return { success: true }
  })

  // IPC: 获取可用模型列表
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
          error: '请先在反代配置中设置或启�?API Key'
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

  // IPC: 获取账户可用模型列表
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

  // IPC: 获取可用订阅列表
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

  // IPC: 获取订阅管理/支付链接
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

  // IPC: 设置用户偏好（超额开�?关闭�?  ipcMain.handle('account-set-overage', async (_event, accessToken: string, overageStatus: 'ENABLED' | 'DISABLED', region?: string, profileArn?: string, machineId?: string, provider?: string, authMethod?: string, accountId?: string) => {
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

  // IPC: 在系统默认浏览器无痕模式中打开订阅链接
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' }
    }
  })

  // 代理日志持久化（请求日志，与详细日志分开存储�?  const getProxyLogsPath = (): string => join(app.getPath('userData'), 'proxy-request-logs.json')
  const MAX_LOGS = 100

  // IPC: 保存代理日志
  ipcMain.handle('proxy-save-logs', async (_event, logs: Array<{ time: string; path: string; status: number; tokens?: number }>) => {
    try {
      const logsPath = getProxyLogsPath()
      // 只保留最�?100 �?      const trimmedLogs = logs.slice(0, MAX_LOGS)
      await writeFile(logsPath, JSON.stringify(trimmedLogs, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('[ProxyLogs] Save failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save logs' }
    }
  })

  // IPC: 加载代理日志
  ipcMain.handle('proxy-load-logs', async () => {
    try {
      const logsPath = getProxyLogsPath()
      const content = await readFile(logsPath, 'utf-8')
      const logs = JSON.parse(content)
      return { success: true, logs }
    } catch (error) {
      // 文件不存在是正常�?      return { success: true, logs: [] }
    }
  })

  // IPC: 重置反代池状�?  ipcMain.handle('proxy-reset-pool', () => {
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

  // IPC: 手动解除账号封禁标记（用户确认账号已恢复后调用）
  // 1) 清除反代池中�?suspended 状�?  // 2) 同步清除 store.accountData[id].lastError，状态回�?active
  ipcMain.handle('proxy-clear-account-suspended', (_event, accountId: string) => {
    try {
      if (proxyServer) {
        proxyServer.getAccountPool().clearSuspended(accountId)
      }
      // 持久化清�?lastError
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

  // ============ K-Proxy MITM 代理 IPC ============

  // IPC: 初始�?K-Proxy 服务
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

  // IPC: 启动 K-Proxy
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
      // 保存配置
      if (store) {
        store.set('kproxyConfig', service.getConfig())
      }
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      console.error('[KProxy] Start failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start K-Proxy' }
    }
  })

  // IPC: 停止 K-Proxy
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

  // IPC: 获取 K-Proxy 状�?  ipcMain.handle('kproxy-get-status', () => {
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

  // IPC: 更新 K-Proxy 配置
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

  // IPC: 设置当前设备 ID
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

  // IPC: 生成新的设备 ID
  ipcMain.handle('kproxy-generate-device-id', () => {
    return { success: true, deviceId: generateDeviceId() }
  })

  // IPC: 添加设备 ID 映射
  ipcMain.handle('kproxy-add-device-mapping', (_event, mapping: DeviceIdMapping) => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, error: 'K-Proxy not initialized' }
      }
      service.addDeviceIdMapping(mapping)
      // 保存映射
      const mappings = service.getAllDeviceIdMappings()
      if (store) {
        store.set('kproxyDeviceMappings', mappings)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add mapping' }
    }
  })

  // IPC: 获取所有设�?ID 映射
  ipcMain.handle('kproxy-get-device-mappings', () => {
    const service = getKProxyService()
    if (!service) {
      const savedMappings = store?.get('kproxyDeviceMappings') as DeviceIdMapping[] | undefined
      return { success: true, mappings: savedMappings || [] }
    }
    return { success: true, mappings: service.getAllDeviceIdMappings() }
  })

  // IPC: 切换到账号设�?ID
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

  // IPC: 获取 CA 证书 PEM（用于导�?安装�?  ipcMain.handle('kproxy-get-ca-cert', () => {
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

  // IPC: 导出 CA 证书到指定路�?  ipcMain.handle('kproxy-export-ca-cert', async (_event, exportPath?: string) => {
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

  // IPC: 重置 K-Proxy 统计
  ipcMain.handle('kproxy-reset-stats', () => {
    const service = getKProxyService()
    if (service) {
      service.resetStats()
    }
    return { success: true }
  })

  // IPC: 检�?CA 证书是否已安装到系统信任存储
  ipcMain.handle('kproxy-check-ca-cert-installed', async () => {
    try {
      const service = getKProxyService()
      if (!service) {
        return { success: false, installed: false, error: 'K-Proxy not initialized' }
      }

      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 检查证�?        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令检�?        try {
          execSync('security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db', { encoding: 'utf-8' })
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      } else {
        // Linux: 检查文件是否存�?        const fs = await import('fs')
        const targetPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
        return { success: true, installed: fs.existsSync(targetPath) }
      }
    } catch (error) {
      console.error('[KProxy] Check CA cert installed failed:', error)
      return { success: false, installed: false, error: error instanceof Error ? error.message : 'Check failed' }
    }
  })

  // IPC: 安装 CA 证书到系统信任存�?  ipcMain.handle('kproxy-install-ca-cert', async () => {
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
        // Windows: 使用 certutil 安装到根证书存储
        try {
          execSync(`certutil -addstore -user Root "${caInfo.certPath}"`, { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate installed to Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('already in store') || errMsg.includes('已在存储�?)) {
            return { success: true, message: 'CA certificate already installed' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令安装到钥匙串
        execSync(`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caInfo.certPath}"`)
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      } else {
        // Linux: 复制到系�?CA 目录
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

  // IPC: 卸载 CA 证书从系统信任存�?  ipcMain.handle('kproxy-uninstall-ca-cert', async () => {
    try {
      const { execSync } = await import('child_process')
      const platform = process.platform

      if (platform === 'win32') {
        // Windows: 使用 certutil 删除证书
        try {
          execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf-8' })
          return { success: true, message: 'CA certificate removed from Windows certificate store' }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('not found') || errMsg.includes('找不�?)) {
            return { success: true, message: 'CA certificate not found in store' }
          }
          throw error
        }
      } else if (platform === 'darwin') {
        // macOS: 使用 security 命令删除
        execSync('security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db')
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      } else {
        // Linux: 删除证书并更�?        const fs = await import('fs')
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

  // ============ MCP 服务器管�?IPC ============

  // IPC: 保存 MCP 服务器配�?  ipcMain.handle('save-mcp-server', async (_event, name: string, config: { command: string; args?: string[]; env?: Record<string, string> }, oldName?: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      // 读取现有配置
      let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
      if (fs.existsSync(mcpPath)) {
        const content = fs.readFileSync(mcpPath, 'utf-8')
        mcpConfig = JSON.parse(content)
      }
      
      // 如果是重命名，先删除旧的
      if (oldName && oldName !== name) {
        delete mcpConfig.mcpServers[oldName]
      }
      
      // 添加/更新服务�?      mcpConfig.mcpServers[name] = config
      
      // 确保目录存在
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

  // IPC: 删除 MCP 服务�?  ipcMain.handle('delete-mcp-server', async (_event, name: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const mcpPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json')
      
      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: '配置文件不存�? }
      }
      
      const content = fs.readFileSync(mcpPath, 'utf-8')
      const mcpConfig = JSON.parse(content)
      
      if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[name]) {
        return { success: false, error: '服务器不存在' }
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

  // IPC: 删除 Steering 文件
  ipcMain.handle('delete-kiro-steering-file', async (_event, filename: string) => {
    try {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const homeDir = os.homedir()
      const filePath = path.join(homeDir, '.kiro', 'steering', filename)
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存�? }
      }
      
      fs.unlinkSync(filePath)
      console.log('[KiroSettings] Deleted steering file:', filePath)
      return { success: true }
    } catch (error) {
      console.error('[KiroSettings] Failed to delete steering file:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete file' }
    }
  })

  // ============ 机器码管�?IPC ============
  
  // IPC: 获取操作系统类型
  ipcMain.handle('machine-id:get-os-type', () => {
    return machineIdModule.getOSType()
  })

  // IPC: 获取当前机器�?  ipcMain.handle('machine-id:get-current', async () => {
    console.log('[MachineId] Getting current machine ID...')
    return await machineIdModule.getCurrentMachineId()
  })

  // IPC: 设置新机器码
  ipcMain.handle('machine-id:set', async (_event, newMachineId: string) => {
    console.log('[MachineId] Setting new machine ID:', newMachineId.substring(0, 8) + '...')
    const result = await machineIdModule.setMachineId(newMachineId)
    
    if (!result.success && result.requiresAdmin) {
      // 弹窗询问用户是否以管理员权限重启
      const shouldRestart = await machineIdModule.showAdminRequiredDialog()
      if (shouldRestart) {
        await machineIdModule.requestAdminRestart()
      }
    }
    
    return result
  })

  // IPC: 生成随机机器�?  ipcMain.handle('machine-id:generate-random', () => {
    return machineIdModule.generateRandomMachineId()
  })

  // IPC: 检查管理员权限
  ipcMain.handle('machine-id:check-admin', async () => {
    return await machineIdModule.checkAdminPrivilege()
  })

  // IPC: 请求管理员权限重�?  ipcMain.handle('machine-id:request-admin-restart', async () => {
    const shouldRestart = await machineIdModule.showAdminRequiredDialog()
    if (shouldRestart) {
      return await machineIdModule.requestAdminRestart()
    }
    return false
  })

  // IPC: 备份机器码到文件
  ipcMain.handle('machine-id:backup-to-file', async (_event, machineId: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '备份机器�?,
      defaultPath: 'machine-id-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    
    if (result.canceled || !result.filePath) {
      return false
    }
    
    return await machineIdModule.backupMachineIdToFile(machineId, result.filePath)
  })

  // IPC: 从文件恢复机器码
  ipcMain.handle('machine-id:restore-from-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '恢复机器�?,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: '用户取消' }
    }
    
    return await machineIdModule.restoreMachineIdFromFile(result.filePaths[0])
  })

  // 更新协议处理函数以支�?Social Auth 回调
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 重新定义协议处理
  handleProtocolUrl = (url: string): void => {
    if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

    try {
      const urlObj = new URL(url)
      
      // 处理 Social Auth 回调 (kiro://kiro.kiroAgent/authenticate-success)
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

      // 调用原始处理函数处理其他协议
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
      // macOS: 点击 Dock 图标时显示主窗口
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 加载并注册全局快捷�?  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: 处理第二个实例和协议 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 协议 URL 会作为命令行参数传入
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 聚焦主窗�?    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 处理协议 URL
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

// 应用退出前注销 URI 协议处理器并保存数据
app.on('will-quit', async (event) => {
  // 防止重复处理
  if (isQuitting) return
  
  // 防止应用立即退出，先保存数�?  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true
    
    // 设置超时，确�?3 秒后强制退出（防止关机阻塞�?    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)
    
    try {
      console.log('[Exit] Saving data before quit...')
      // 刷新待写入的防抖数据
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
