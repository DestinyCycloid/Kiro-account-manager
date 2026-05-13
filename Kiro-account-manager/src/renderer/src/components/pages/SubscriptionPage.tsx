import { useState, useCallback, useEffect, useRef } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { Button, Card, CardContent } from '../ui'
import { 
  CreditCard, 
  ExternalLink, 
  Copy, 
  Download, 
  Loader2, 
  CheckCircle, 
  XCircle, 
  CheckSquare, 
  Square, 
  Minus,
  RefreshCw,
  Trash2,
  Zap
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

type SubTab = 'overage' | 'links'

interface SubscriptionPlan {
  name: string
  qSubscriptionType: string
  description: { title: string; billingInterval: string; featureHeader: string; features: string[] }
  pricing: { amount: number; currency: string }
}

interface SubscriptionLink {
  accountId: string
  email: string
  status: 'pending' | 'loading' | 'success' | 'error'
  url?: string
  error?: string
}

interface OverageItem {
  accountId: string
  email: string
  status: 'pending' | 'loading' | 'success' | 'error' | 'skipped'
  error?: string
}

// 模块级状态：组件卸载后仍保留（同一会话内）
let _links: SubscriptionLink[] = []
let _linksNotify: ((links: SubscriptionLink[]) => void) | null = null

export function appendSubscriptionLink(link: SubscriptionLink): void {
  _links = [..._links, link]
  _linksNotify?.(_links)
}

export function updateSubscriptionLink(accountId: string, update: Partial<SubscriptionLink>): void {
  _links = _links.map(l => l.accountId === accountId ? { ...l, ...update } : l)
  _linksNotify?.(_links)
}
let _availablePlans: SubscriptionPlan[] = []
let _selectedPlanType = ''
let _selectedLinkIds: Set<string> = new Set()
let _activeTab: SubTab = 'overage'
let _overageItems: OverageItem[] = []

export function SubscriptionPage() {
  const { accounts, selectedIds, updateAccount } = useAccountsStore()
  const { actualLanguage } = useTranslation()
  const isEn = actualLanguage === 'en'

  const [activeTab, setActiveTabState] = useState<SubTab>(_activeTab)
  const setActiveTab = (v: SubTab) => { _activeTab = v; setActiveTabState(v) }
  
  const [links, setLinksState] = useState<SubscriptionLink[]>(_links)
  const [isFetching, setIsFetching] = useState(false)
  const [selectedLinkIds, setSelectedLinkIdsState] = useState<Set<string>>(_selectedLinkIds)
  
  // 计划选择相关
  const [availablePlans, setAvailablePlansState] = useState<SubscriptionPlan[]>(_availablePlans)
  const [selectedPlanType, setSelectedPlanTypeState] = useState<string>(_selectedPlanType)
  const [isLoadingPlans, setIsLoadingPlans] = useState(false)

  // 超额相关
  const [overageItems, setOverageItemsState] = useState<OverageItem[]>(_overageItems)
  const [isSettingOverage, setIsSettingOverage] = useState(false)
  const overageListRef = useRef<HTMLDivElement>(null)

  // 包装 setter，同步更新模块级变量
  const setLinks = (val: SubscriptionLink[] | ((prev: SubscriptionLink[]) => SubscriptionLink[])) => {
    setLinksState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _links = next
      return next
    })
  }
  const setSelectedLinkIds = (val: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setSelectedLinkIdsState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _selectedLinkIds = next
      return next
    })
  }
  const setAvailablePlans = (val: SubscriptionPlan[]) => {
    _availablePlans = val
    setAvailablePlansState(val)
  }
  const setSelectedPlanType = (val: string) => {
    _selectedPlanType = val
    setSelectedPlanTypeState(val)
  }
  const setOverageItems = (val: OverageItem[] | ((prev: OverageItem[]) => OverageItem[])) => {
    setOverageItemsState(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      _overageItems = next
      return next
    })
  }

  // 注册外部写入回调（让 appendSubscriptionLink/updateSubscriptionLink 同步 React state）
  useEffect(() => {
    _linksNotify = setLinksState
    return () => { _linksNotify = null }
  }, [])

  // 超额列表自动滚动到底部
  useEffect(() => {
    const el = overageListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [overageItems])

  // 获取可升级的 FREE 账户（从选中或全部）
  const getUpgradeableAccounts = useCallback(() => {
    const source = selectedIds.size > 0 
      ? Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
      : Array.from(accounts.values())
    
    return source.filter(acc => {
      if (!acc) return false
      const type = (acc.subscription?.type || '').toUpperCase()
      const title = (acc.subscription?.title || '').toUpperCase()
      const isFreeTier = type.includes('FREE') || title.includes('FREE') || (!type && !title)
      const hasToken = !!acc.credentials?.accessToken
      return isFreeTier && hasToken
    })
  }, [accounts, selectedIds])

  // 加载可用订阅计划（用任一可用账户调用）
  const handleLoadPlans = async () => {
    const upgradeableAccounts = getUpgradeableAccounts()
    if (upgradeableAccounts.length === 0) return

    setIsLoadingPlans(true)
    const acc = upgradeableAccounts[0]!
    
    try {
      const result = await window.api.accountGetSubscriptions(
        acc.credentials.accessToken,
        acc.credentials?.region,
        acc.profileArn,
        acc.machineId,
        acc.credentials?.provider || acc.idp,
        acc.credentials?.authMethod,
        acc.id
      )
      if (result.success && result.plans && result.plans.length > 0) {
        setAvailablePlans(result.plans)
        // 默认选择第一个 PRO 计划
        const defaultPlan = result.plans.find(p => 
          p.qSubscriptionType?.toUpperCase().includes('PRO') && !p.qSubscriptionType?.toUpperCase().includes('PLUS')
        ) || result.plans[0]
        setSelectedPlanType(defaultPlan.qSubscriptionType)
      }
    } catch (error) {
      console.error('[SubscriptionPage] Failed to load plans:', error)
    }
    setIsLoadingPlans(false)
  }

  // 并发数
  const [concurrency, setConcurrency] = useState(5)

  // 批量并发获取订阅链接
  const handleBatchFetch = async () => {
    const upgradeableAccounts = getUpgradeableAccounts()
    if (upgradeableAccounts.length === 0 || !selectedPlanType) return

    setIsFetching(true)
    
    // 初始化状态
    const initialLinks: SubscriptionLink[] = upgradeableAccounts.map(acc => ({
      accountId: acc!.id,
      email: acc!.email || 'Unknown',
      status: 'pending'
    }))
    setLinks(initialLinks)
    setSelectedLinkIds(new Set())

    // 单个账号获取任务
    const fetchOne = async (idx: number) => {
      const acc = upgradeableAccounts[idx]!
      setLinks(prev => prev.map((link, i) => 
        i === idx ? { ...link, status: 'loading' } : link
      ))

      try {
        const tokenResult = await window.api.accountGetSubscriptionUrl(
          acc.credentials.accessToken,
          selectedPlanType,
          acc.credentials?.region,
          acc.profileArn,
          acc.machineId,
          acc.credentials?.provider || acc.idp,
          acc.credentials?.authMethod,
          acc.id
        )

        if (tokenResult.success && tokenResult.url) {
          setLinks(prev => prev.map((link, i) => 
            i === idx ? { ...link, status: 'success', url: tokenResult.url } : link
          ))
        } else {
          setLinks(prev => prev.map((link, i) => 
            i === idx ? { ...link, status: 'error', error: tokenResult.error || 'Failed to get URL' } : link
          ))
        }
      } catch (error) {
        setLinks(prev => prev.map((link, i) => 
          i === idx ? { ...link, status: 'error', error: error instanceof Error ? error.message : 'Unknown error' } : link
        ))
      }
    }

    // 并发池执行
    const indices = Array.from({ length: upgradeableAccounts.length }, (_, i) => i)
    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < indices.length) {
        const idx = cursor++
        await fetchOne(idx)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, indices.length) }, () => runNext())
    await Promise.all(workers)

    setIsFetching(false)
  }

  // 选择/取消选择链接
  const toggleLinkSelection = (accountId: string) => {
    setSelectedLinkIds(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      return next
    })
  }

  // 全选/取消全选成功的链接
  const toggleSelectAll = () => {
    const successLinks = links.filter(l => l.status === 'success')
    if (selectedLinkIds.size === successLinks.length) {
      setSelectedLinkIds(new Set())
    } else {
      setSelectedLinkIds(new Set(successLinks.map(l => l.accountId)))
    }
  }

  // 获取目标链接列表（选中的或全部成功的）
  const getTargetLinks = (mode: 'selected' | 'all'): SubscriptionLink[] => {
    const successLinks = links.filter(l => l.status === 'success' && l.url)
    if (mode === 'selected') {
      return successLinks.filter(l => selectedLinkIds.has(l.accountId))
    }
    return successLinks
  }

  // 打开单个链接
  const handleOpenLink = async (url: string) => {
    await window.api.openSubscriptionWindow(url)
  }

  // 批量打开链接（全部同时打开）
  const handleBatchOpen = async (mode: 'selected' | 'all') => {
    const targetLinks = getTargetLinks(mode)
    await Promise.all(
      targetLinks
        .filter(l => l.url)
        .map(l => window.api.openSubscriptionWindow(l.url!))
    )
  }

  // 复制单个链接
  const handleCopyLink = async (url: string) => {
    await navigator.clipboard.writeText(url)
  }

  // 导出链接
  const handleExport = async (mode: 'selected' | 'all') => {
    const targetLinks = getTargetLinks(mode)
    const text = targetLinks.map(l => l.url).join('\n')
    await navigator.clipboard.writeText(text)
  }

  // ===== 一键超额功能 =====
  // 获取可设置超额的账号（仅未开启）：已订阅（非 Free）、有 token、超额能力可用、超额未开启
  const getOverageableAccounts = useCallback(() => {
    return getAllSubscribedAccounts().filter(acc => acc && acc.subscription?.overageCapability === 'OVERAGE_CAPABLE' && acc.usage?.resourceDetail?.overageEnabled !== true)
  }, [accounts, selectedIds])

  // 获取所有已订阅账号（不限制超额能力，不限制是否已开启）
  const getAllSubscribedAccounts = useCallback(() => {
    const source = selectedIds.size > 0
      ? Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
      : Array.from(accounts.values())

    return source.filter(acc => {
      if (!acc) return false
      const hasToken = !!acc.credentials?.accessToken
      const type = (acc.subscription?.type || '').toUpperCase()
      const title = (acc.subscription?.title || '').toUpperCase()
      const isSubscribed = type.includes('PRO') || type.includes('ENTERPRISE') || type.includes('TEAMS') || title.includes('PRO') || title.includes('ENTERPRISE') || title.includes('TEAMS')
      return hasToken && isSubscribed
    })
  }, [accounts, selectedIds])

  const handleBatchSetOverage = async (customTargets?: NonNullable<ReturnType<typeof getAllSubscribedAccounts>>) => {
    const targets = customTargets ?? getOverageableAccounts()
    if (targets.length === 0) return

    setIsSettingOverage(true)

    // 初始化列表
    const initialItems: OverageItem[] = targets.map(acc => ({
      accountId: acc!.id,
      email: acc!.email || 'Unknown',
      status: 'pending'
    }))
    setOverageItems(initialItems)

    const setOne = async (idx: number) => {
      const acc = targets[idx]!
      setOverageItems(prev => prev.map((item, i) =>
        i === idx ? { ...item, status: 'loading' } : item
      ))

      try {
        const res = await window.api.accountSetOverage(
          acc.credentials.accessToken,
          'ENABLED',
          acc.credentials?.region,
          acc.profileArn,
          acc.machineId,
          acc.credentials?.provider || acc.idp,
          acc.credentials?.authMethod,
          acc.id
        )
        if (res.success) {
          setOverageItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: 'success' } : item
          ))
          // 更新 store 中账号的超额状态，使 UI 即时反映
          const existing = accounts.get(acc.id)
          if (existing) {
            updateAccount(acc.id, {
              usage: {
                ...existing.usage,
                resourceDetail: {
                  ...existing.usage?.resourceDetail,
                  overageEnabled: true
                }
              }
            })
          }
        } else {
          setOverageItems(prev => prev.map((item, i) =>
            i === idx ? { ...item, status: 'error', error: res.error || 'Unknown error' } : item
          ))
        }
      } catch (e) {
        setOverageItems(prev => prev.map((item, i) =>
          i === idx ? { ...item, status: 'error', error: e instanceof Error ? e.message : 'Unknown error' } : item
        ))
      }
    }

    // 并发池
    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < targets.length) {
        const idx = cursor++
        await setOne(idx)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => runNext())
    await Promise.all(workers)

    setIsSettingOverage(false)
  }

  const overageableCount = getOverageableAccounts().length
  const allSubscribedCount = getAllSubscribedAccounts().length
  const overageSuccessCount = overageItems.filter(i => i.status === 'success').length
  const overageErrorCount = overageItems.filter(i => i.status === 'error').length

  const successCount = links.filter(l => l.status === 'success').length
  const errorCount = links.filter(l => l.status === 'error').length
  const selectedCount = selectedLinkIds.size
  const upgradeableCount = getUpgradeableAccounts().length

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto max-w-6xl mx-auto">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 p-6 border border-primary/20">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary/10">
            <CreditCard className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Batch Subscription' : '批量订阅'}</h1>
            <p className="text-sm text-muted-foreground">
              {selectedIds.size > 0
                ? (isEn ? `Using ${selectedIds.size} selected accounts` : `使用已选中的 ${selectedIds.size} 个账户`)
                : (isEn ? 'Using all accounts' : '使用全部账户')
              }
            </p>
          </div>
        </div>
      </div>

      {/* 内部 Tab 切换 */}
      <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('overage')}
          className={cn(
            'px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'overage'
              ? 'bg-background shadow text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Zap className="h-4 w-4" />
          {isEn ? 'Overage Settings' : '超额设置'}
        </button>
        <button
          onClick={() => setActiveTab('links')}
          className={cn(
            'px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
            activeTab === 'links'
              ? 'bg-background shadow text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <CreditCard className="h-4 w-4" />
          {isEn ? 'Subscription Links' : '获取链接'}
        </button>
      </div>

      {/* ===== 超额设置 Tab ===== */}
      {activeTab === 'overage' && (
        <>
          {/* 操作栏 */}
          <Card>
            <CardContent className="py-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => handleBatchSetOverage()}
                disabled={isSettingOverage || overageableCount === 0}
              >
                {isSettingOverage ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Enable Overage (${overageableCount})`
                  : `一键超额 (${overageableCount})`
                }
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBatchSetOverage(getAllSubscribedAccounts())}
                disabled={isSettingOverage || allSubscribedCount === 0}
              >
                {isSettingOverage ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Set All (${allSubscribedCount})`
                  : `全部设置 (${allSubscribedCount})`
                }
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOverageItems([])}
                disabled={isSettingOverage || overageItems.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Clear' : '清空'}
              </Button>

              {/* 并发数控制 */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">{isEn ? 'Concurrency:' : '并发:'}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (val > 0) setConcurrency(val)
                  }}
                  disabled={isSettingOverage}
                  className="h-7 w-14 px-1.5 rounded border border-border bg-background text-xs text-center"
                />
              </div>

              <span className="text-xs text-muted-foreground ml-2">
                {overageableCount > 0
                  ? (isEn ? `${overageableCount} subscribed accounts without overage enabled` : `${overageableCount} 个已订阅账号未开启超额`)
                  : (isEn ? 'No accounts need overage enablement' : '没有需要开启超额的账号')
                }
              </span>

              {/* 统计 */}
              {overageItems.length > 0 && (
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  {overageSuccessCount > 0 && (
                    <span className="flex items-center gap-1 text-green-600">
                      <CheckCircle className="h-3 w-3" /> {overageSuccessCount}
                    </span>
                  )}
                  {overageErrorCount > 0 && (
                    <span className="flex items-center gap-1 text-red-500">
                      <XCircle className="h-3 w-3" /> {overageErrorCount}
                    </span>
                  )}
                  {isSettingOverage && (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {overageItems.filter(i => i.status === 'pending' || i.status === 'loading').length}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 超额结果列表 */}
          {overageItems.length > 0 && (
            <Card>
              <CardContent className="py-2">
                {/* 表头 */}
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : '邮箱'}</span>
                  <span className="w-20 text-center">{isEn ? 'Status' : '状态'}</span>
                  <span className="flex-1 text-right">{isEn ? 'Details' : '详情'}</span>
                </div>

                {/* 列表 */}
                <div ref={overageListRef} className="max-h-[60vh] overflow-y-auto">
                  {overageItems.map((item, idx) => (
                    <div
                      key={item.accountId}
                      className="flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                    >
                      <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>
                      <span className="flex-1 text-sm truncate" title={item.email}>{item.email}</span>
                      <span className="w-20 flex justify-center">
                        {item.status === 'pending' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Pending' : '等待中'}</span>
                        )}
                        {item.status === 'loading' && (
                          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        )}
                        {item.status === 'success' && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {item.status === 'error' && (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        {item.status === 'skipped' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Skipped' : '跳过'}</span>
                        )}
                      </span>
                      <span className="flex-1 text-right text-xs truncate">
                        {item.status === 'success' && (
                          <span className="text-green-600">{isEn ? 'Overage enabled' : '超额已开启'}</span>
                        )}
                        {item.status === 'error' && (
                          <span className="text-red-500" title={item.error}>{item.error}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 账号超额状态总览（未执行批量操作时显示） */}
          {overageItems.length === 0 && (
            <Card>
              <CardContent className="py-2">
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : '邮箱'}</span>
                  <span className="w-24 text-center">{isEn ? 'Subscription' : '订阅类型'}</span>
                  <span className="w-24 text-center">{isEn ? 'Overage Capable' : '超额能力'}</span>
                  <span className="w-24 text-center">{isEn ? 'Overage Status' : '超额状态'}</span>
                </div>
                {allSubscribedCount > 0 ? (
                  <div className="max-h-[60vh] overflow-y-auto">
                    {getAllSubscribedAccounts().map((acc, idx) => {
                      if (!acc) return null
                      const capable = acc.subscription?.overageCapability === 'OVERAGE_CAPABLE'
                      const enabled = acc.usage?.resourceDetail?.overageEnabled === true
                      return (
                        <div
                          key={acc.id}
                          className="flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                        >
                          <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>
                          <span className="flex-1 text-sm truncate" title={acc.email}>{acc.email}</span>
                          <span className="w-24 text-center text-xs">
                            {acc.subscription?.title || acc.subscription?.type || '-'}
                          </span>
                          <span className="w-24 flex justify-center">
                            {capable ? (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-muted-foreground/40" />
                            )}
                          </span>
                          <span className="w-24 flex justify-center">
                            {enabled ? (
                              <span className="text-xs text-green-600 font-medium">{isEn ? 'ENABLED' : '已开启'}</span>
                            ) : capable ? (
                              <span className="text-xs text-amber-500 font-medium">{isEn ? 'DISABLED' : '未开启'}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="py-12 text-center text-muted-foreground">
                    <Zap className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">
                      {isEn
                        ? 'No subscribed accounts found. Ensure accounts are checked first.'
                        : '未找到已订阅账号。请先检测账号状态。'}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ===== 获取链接 Tab ===== */}
      {activeTab === 'links' && (
        <>
          {/* 计划选择 */}
          <Card>
            <CardContent className="py-3 space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLoadPlans}
                  disabled={isLoadingPlans || upgradeableCount === 0}
                >
                  {isLoadingPlans ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-1" />
                  )}
                  {isEn ? 'Load Plans' : '加载计划'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {availablePlans.length > 0
                    ? (isEn ? `${availablePlans.length} plans available` : `已加载 ${availablePlans.length} 个计划`)
                    : (isEn ? 'Click to load available subscription plans' : '点击加载可用订阅计划')
                  }
                </span>
              </div>

              {availablePlans.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {availablePlans.map(plan => (
                    <button
                      key={plan.qSubscriptionType}
                      onClick={() => setSelectedPlanType(plan.qSubscriptionType)}
                      className={cn(
                        'px-3 py-1.5 rounded-md border text-xs font-medium transition-colors',
                        selectedPlanType === plan.qSubscriptionType
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/50'
                      )}
                    >
                      <div>{plan.description.title || plan.name}</div>
                      <div className="text-[10px] opacity-70">
                        ${plan.pricing.amount / 100}/{plan.description.billingInterval}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 操作栏 */}
          <Card>
            <CardContent className="py-3 flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={handleBatchFetch}
                disabled={isFetching || upgradeableCount === 0 || !selectedPlanType}
              >
                {isFetching ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <CreditCard className="h-4 w-4 mr-1" />
                )}
                {isEn
                  ? `Fetch Links (${upgradeableCount})`
                  : `获取链接 (${upgradeableCount})`
                }
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setLinks([]); setSelectedLinkIds(new Set()) }}
                disabled={isFetching || links.length === 0}
                title={isEn ? 'Clear results' : '清空结果'}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {isEn ? 'Clear' : '清空'}
              </Button>

              {/* 并发数控制 */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">{isEn ? 'Concurrency:' : '并发:'}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (val > 0) setConcurrency(val)
                  }}
                  disabled={isFetching}
                  className="h-7 w-14 px-1.5 rounded border border-border bg-background text-xs text-center"
                />
              </div>

              <div className="w-px h-6 bg-border" />

              {successCount > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBatchOpen('selected')}
                    disabled={selectedCount === 0}
                    title={isEn ? 'Open selected in incognito' : '无痕打开选中链接'}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {isEn ? `Open Selected (${selectedCount})` : `打开选中 (${selectedCount})`}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBatchOpen('all')}
                    title={isEn ? 'Open all in incognito' : '无痕打开全部链接'}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {isEn ? `Open All (${successCount})` : `全部打开 (${successCount})`}
                  </Button>

                  <div className="w-px h-6 bg-border" />

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('selected')}
                    disabled={selectedCount === 0}
                    title={isEn ? 'Copy selected links' : '复制选中链接'}
                  >
                    <Copy className="h-4 w-4 mr-1" />
                    {isEn ? `Export Selected (${selectedCount})` : `导出选中 (${selectedCount})`}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('all')}
                    title={isEn ? 'Copy all links' : '复制全部链接'}
                  >
                    <Download className="h-4 w-4 mr-1" />
                    {isEn ? `Export All (${successCount})` : `全部导出 (${successCount})`}
                  </Button>
                </>
              )}

              {/* 统计 */}
              {links.length > 0 && (
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                  {successCount > 0 && (
                    <span className="flex items-center gap-1 text-green-600">
                      <CheckCircle className="h-3 w-3" /> {successCount}
                    </span>
                  )}
                  {errorCount > 0 && (
                    <span className="flex items-center gap-1 text-red-500">
                      <XCircle className="h-3 w-3" /> {errorCount}
                    </span>
                  )}
                  {isFetching && (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {links.filter(l => l.status === 'pending' || l.status === 'loading').length}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 链接列表 */}
          {links.length > 0 && (
            <Card>
              <CardContent className="py-2">
                {/* 表头 */}
                <div className="flex items-center gap-3 py-2 px-2 border-b text-xs font-medium text-muted-foreground">
                  <button
                    onClick={toggleSelectAll}
                    className="flex-shrink-0"
                    disabled={successCount === 0}
                  >
                    {selectedLinkIds.size === successCount && successCount > 0 ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : selectedLinkIds.size > 0 ? (
                      <Minus className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <span className="w-8 text-center">#</span>
                  <span className="flex-1">{isEn ? 'Email' : '邮箱'}</span>
                  <span className="w-20 text-center">{isEn ? 'Status' : '状态'}</span>
                  <span className="w-24 text-center">{isEn ? 'Actions' : '操作'}</span>
                </div>

                {/* 列表 */}
                <div className="max-h-[60vh] overflow-y-auto">
                  {links.map((link, idx) => (
                    <div
                      key={link.accountId}
                      className={cn(
                        "flex items-center gap-3 py-2 px-2 border-b last:border-b-0 hover:bg-muted/50 transition-colors",
                        selectedLinkIds.has(link.accountId) && 'bg-primary/5'
                      )}
                    >
                      {/* 选择框 */}
                      <button
                        onClick={() => link.status === 'success' && toggleLinkSelection(link.accountId)}
                        className="flex-shrink-0"
                        disabled={link.status !== 'success'}
                      >
                        {selectedLinkIds.has(link.accountId) ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className={cn("h-4 w-4", link.status !== 'success' && 'opacity-30')} />
                        )}
                      </button>

                      {/* 序号 */}
                      <span className="w-8 text-center text-xs text-muted-foreground">{idx + 1}</span>

                      {/* 邮箱 */}
                      <span className="flex-1 text-sm truncate" title={link.email}>
                        {link.email}
                      </span>

                      {/* 状态 */}
                      <span className="w-20 flex justify-center">
                        {link.status === 'pending' && (
                          <span className="text-xs text-muted-foreground">{isEn ? 'Pending' : '等待中'}</span>
                        )}
                        {link.status === 'loading' && (
                          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        )}
                        {link.status === 'success' && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {link.status === 'error' && (
                          <span className="text-xs text-red-500 truncate" title={link.error}>
                            <XCircle className="h-4 w-4 inline" />
                          </span>
                        )}
                      </span>

                      {/* 操作 */}
                      <span className="w-24 flex justify-center gap-1">
                        {link.status === 'success' && link.url && (
                          <>
                            <button
                              onClick={() => handleOpenLink(link.url!)}
                              className="p-1 rounded hover:bg-muted"
                              title={isEn ? 'Open in incognito' : '无痕打开'}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleCopyLink(link.url!)}
                              className="p-1 rounded hover:bg-muted"
                              title={isEn ? 'Copy link' : '复制链接'}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        {link.status === 'error' && (
                          <span className="text-[10px] text-red-500 truncate max-w-[80px]" title={link.error}>
                            {link.error}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 空状态 */}
          {links.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  {upgradeableCount > 0
                    ? (isEn
                        ? `${upgradeableCount} FREE accounts available for upgrade. Click "Fetch Links" to start.`
                        : `有 ${upgradeableCount} 个 FREE 账户可升级。点击"获取链接"开始。`)
                    : (isEn
                        ? 'No FREE tier accounts found. Select accounts in the Accounts page first.'
                        : '未找到 FREE 账户。请先在账户管理页面选择账户。')
                  }
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
