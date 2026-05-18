import type { Storage } from 'unstorage'
import type { MessageCollector } from '~/utils/index'
import { AsyncLocalStorage } from 'node:async_hooks'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { useStorage } from 'nitro/storage'
import { defineTask } from 'nitro/task'
import { createClient } from 'skland-kit'
import { createContext } from 'unctx'
import { attendCharacter, createMessageCollector, generateAttendanceKey, getSplitByComma } from '~/utils/index'

interface GameStats {
  gameName: string
  total: number
  succeeded: number // 本次签到成功
  alreadyAttended: number // 今天已签到
  failed: number // 签到失败
}

type AccountStatus = 'success' | 'skipped' | 'failed'

interface AccountGameStats {
  shortName: string
  succeeded: number
  alreadyAttended: number
  failed: number
}

interface AccountResult {
  index: number
  status: AccountStatus
  succeeded: number
  alreadyAttended: number
  failed: number
  byGame: Map<number, AccountGameStats>
  errorMessage?: string
}

const GAME_SHORT_NAMES: Record<number, string> = {
  1: '舟',
  3: '终',
}

function gameShortName(gameId: number, gameName: string): string {
  return GAME_SHORT_NAMES[gameId] ?? (gameName.replace(/明日方舟[：:]?/, '').slice(0, 2) || '游')
}

function getOrCreateAccountGameStats(
  accountResult: AccountResult,
  gameId: number,
  gameName: string,
): AccountGameStats {
  let stats = accountResult.byGame.get(gameId)
  if (!stats) {
    stats = { shortName: gameShortName(gameId, gameName), succeeded: 0, alreadyAttended: 0, failed: 0 }
    accountResult.byGame.set(gameId, stats)
  }
  return stats
}

function formatAccountGamePart(stats: AccountGameStats): string {
  const parts: string[] = []
  if (stats.succeeded > 0)
    parts.push(`新签${stats.succeeded}`)
  if (stats.alreadyAttended > 0)
    parts.push(`已签${stats.alreadyAttended}`)
  if (stats.failed > 0)
    parts.push(`失败${stats.failed}`)
  return parts.length > 0 ? `${stats.shortName}${parts.join('')}` : ''
}

function formatAccountGameSummary(accountResult: AccountResult): string {
  const parts = [...accountResult.byGame.values()]
    .map(formatAccountGamePart)
    .filter(Boolean)
  return parts.join(' ')
}

interface ExecutionStats {
  accounts: {
    total: number
    successful: number // 所有角色都成功的账号
    skipped: number // 今天已签到的账号
    failed: number // 有失败的账号
    failedIndexes: number[]
  }
  charactersByGame: Map<number, GameStats> // key: gameId
  accountResults: AccountResult[]
}

interface ProcessAccountResult {
  accountHasError: boolean
  charactersCount: number
  accountResult: AccountResult
}

interface AttendanceContext {
  stats: ExecutionStats
  messageCollector: MessageCollector
  storage: Storage
  maxRetries: number
  totalAccounts: number
}

// Create attendance context instance
const attendanceContext = createContext<AttendanceContext>({
  asyncContext: true,
  AsyncLocalStorage,
})

// Export composable function for accessing context
const useAttendanceContext = attendanceContext.use

const ATTENDANCE_AVAILABLE_APPCODE = ['arknights', 'endfield']

function createAccountResult(index: number, status: AccountStatus): AccountResult {
  return { index, status, succeeded: 0, alreadyAttended: 0, failed: 0, byGame: new Map() }
}

const PUSH_ERROR_MAX_LEN = 36

function truncateForPush(message: string, maxLen = PUSH_ERROR_MAX_LEN): string {
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen - 1)}…`
}

function formatAccountLine(result: AccountResult): string {
  switch (result.status) {
    case 'skipped':
      return `#${result.index} - 已跳过`
    case 'failed': {
      const hint = `请更新第${result.index}个token`
      const gameSummary = formatAccountGameSummary(result)
      if (result.errorMessage)
        return `#${result.index} ✗ ${truncateForPush(result.errorMessage)}${gameSummary ? ` ${gameSummary}` : ''} (${hint})`
      return `#${result.index} ✗ ${gameSummary || '失败'} (${hint})`
    }
    default: {
      const gameSummary = formatAccountGameSummary(result)
      return `#${result.index} ✓ ${gameSummary || '完成'}`
    }
  }
}

function buildPushContent(stats: ExecutionStats): string {
  const { accounts } = stats
  const lines = [
    `汇总: ${accounts.successful}成功 ${accounts.skipped}跳过 ${accounts.failed}失败 / 共${accounts.total}账号`,
  ]

  for (const result of stats.accountResults)
    lines.push(formatAccountLine(result))

  if (stats.charactersByGame.size > 0) {
    const gameLine = [...stats.charactersByGame.entries()]
      .sort(([a], [b]) => a - b)
      .map(([gameId, g]) => {
        const short = gameShortName(gameId, g.gameName)
        return `${short} 新签${g.succeeded}/已签${g.alreadyAttended}/失败${g.failed}`
      })
      .join(' | ')
    lines.push(`游戏: ${gameLine}`)
  }

  return lines.join('\n')
}

async function processAccount(
  token: string,
  accountNumber: number,
): Promise<ProcessAccountResult> {
  // Get all dependencies from context
  const { stats, messageCollector, storage, maxRetries, totalAccounts } = useAttendanceContext()
  const accountResult = createAccountResult(accountNumber, 'success')

  // Check if already attended today
  const attendanceKey = await generateAttendanceKey(token)
  const hasAttended = await storage.getItem(attendanceKey)

  if (hasAttended) {
    messageCollector.log(`--- 账号 ${accountNumber}/${totalAccounts} ---`)
    messageCollector.log(`今天已经签到过，跳过`)
    stats.accounts.skipped++
    accountResult.status = 'skipped'
    stats.accountResults.push(accountResult)
    return { accountHasError: false, charactersCount: 0, accountResult }
  }

  messageCollector.log(`--- 账号 ${accountNumber}/${totalAccounts} ---`)
  messageCollector.log(`开始处理...`)

  const client = createClient()
  const { code } = await client.collections.hypergryph.grantAuthorizeCode(token)
  await client.signIn(code)

  const { list } = await client.collections.player.getBinding()
  // Build character list with game information preserved
  const characterList = list
    .filter(i => ATTENDANCE_AVAILABLE_APPCODE.includes(i.appCode))
    .flatMap((binding) => {
      if (binding.appCode === 'endfield') {
        // 终末地按单个角色展开，与明日方舟不同，每个 role 需要独立签到
        return binding.bindingList.flatMap(player =>
          player.roles.length > 0
            ? player.roles.map(role => ({ ...player, defaultRole: role, roles: [role] }))
            : [player],
        )
      }
      return binding.bindingList
    })

  let accountHasError = false
  for (const character of characterList) {
    // Initialize game stats if not exists
    if (!stats.charactersByGame.has(character.gameId)) {
      stats.charactersByGame.set(character.gameId, {
        gameName: character.gameName,
        total: 0,
        succeeded: 0,
        alreadyAttended: 0,
        failed: 0,
      })
    }

    const gameStats = stats.charactersByGame.get(character.gameId)!
    gameStats.total++
    const accountGameStats = getOrCreateAccountGameStats(accountResult, character.gameId, character.gameName)

    const result = await attendCharacter(
      client,
      character,
      maxRetries,
      character.gameName,
      retriesLeft => messageCollector.log(`操作失败，剩余重试次数: ${retriesLeft}`),
    )

    // Collect message to notification
    if (result.hasError) {
      messageCollector.error(result.message)
      gameStats.failed++
      accountGameStats.failed++
      accountResult.failed++
      accountHasError = true
    }
    else {
      messageCollector.log(result.message)
      if (result.success) {
        gameStats.succeeded++
        accountGameStats.succeeded++
        accountResult.succeeded++
      }
      else {
        // Already attended today
        gameStats.alreadyAttended++
        accountGameStats.alreadyAttended++
        accountResult.alreadyAttended++
      }
    }
  }

  // Save attendance status only if all characters succeeded
  if (!accountHasError) {
    await storage.setItem(attendanceKey, true)
    stats.accounts.successful++
    accountResult.status = 'success'
  }
  else {
    stats.accounts.failed++
    stats.accounts.failedIndexes.push(accountNumber)
    accountResult.status = 'failed'
  }

  stats.accountResults.push(accountResult)
  return { accountHasError, charactersCount: characterList.length, accountResult }
}

export default defineTask<'success' | 'failed'>({
  meta: {
    name: 'attendance',
    description: '每日签到',
  },
  async run() {
    const config = useRuntimeConfig()

    const tokens = getSplitByComma(config.tokens)

    const notificationUrls = getSplitByComma(config.notificationUrls)

    const messageCollector = createMessageCollector({
      notificationUrls,
    })

    if (tokens.length === 0) {
      messageCollector.log('未配置任何账号，跳过签到任务')
      return { result: 'success' }
    }

    const storage = useStorage()

    const maxRetries = Number(config.maxRetries)

    // Initialize statistics
    const stats: ExecutionStats = {
      accounts: {
        total: tokens.length,
        successful: 0,
        skipped: 0,
        failed: 0,
        failedIndexes: [],
      },
      charactersByGame: new Map(),
      accountResults: [],
    }

    const ctx = {
      stats,
      messageCollector,
      storage,
      maxRetries,
      totalAccounts: tokens.length,
    }

    // Create context scope for async operations
    await attendanceContext.call(ctx, async () => {
      // Process each account within the context
      for (const [index, token] of tokens.entries()) {
        const accountNumber = index + 1

        try {
          await processAccount(token, accountNumber)
        }
        catch (error) {
          const { stats, messageCollector } = useAttendanceContext()
          const errorMessage = error instanceof Error ? error.message : String(error)
          messageCollector.log(`--- 账号 ${accountNumber}/${tokens.length} ---`)
          messageCollector.error(`处理失败: ${errorMessage}`)
          stats.accounts.failed++
          stats.accounts.failedIndexes.push(accountNumber)
          const accountResult: AccountResult = {
            index: accountNumber,
            status: 'failed',
            succeeded: 0,
            alreadyAttended: 0,
            failed: 0,
            byGame: new Map(),
            errorMessage: `处理失败: ${errorMessage}`,
          }
          stats.accountResults.push(accountResult)
        }
      }
    })

    // 控制台输出完整摘要
    messageCollector.log(`\n========== 执行摘要 ==========`)
    messageCollector.log(`账号: ${stats.accounts.successful}成功 ${stats.accounts.skipped}跳过 ${stats.accounts.failed}失败 / 共${stats.accounts.total}`)
    for (const result of stats.accountResults)
      messageCollector.log(formatAccountLine(result))
    for (const [gameId, gameStats] of [...stats.charactersByGame.entries()].sort(([a], [b]) => a - b)) {
      const short = gameShortName(gameId, gameStats.gameName)
      messageCollector.log(
        `【${short}/${gameStats.gameName}】新签${gameStats.succeeded} 已签${gameStats.alreadyAttended} 失败${gameStats.failed} / 总${gameStats.total}`,
      )
    }

    // 推送仅发送一条短摘要（适配 ServerChan 长度限制）
    if (stats.accounts.successful > 0 || stats.accounts.failed > 0 || stats.accounts.skipped > 0) {
      const hasFailedAccount = stats.accounts.failed > 0
      if (hasFailedAccount)
        messageCollector.notifyError(buildPushContent(stats))
      else
        messageCollector.notify(buildPushContent(stats))
      await messageCollector.push()
    }

    // 签到业务失败（部分账号/角色）不标记任务失败；仅未捕获的系统级异常会向外抛出
    return { result: 'success' }
  },
})
