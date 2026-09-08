import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { GitHubAuthError, type GitHubService, type GitHubAuthFailure } from '../services/GitHubService'
import type { GitService } from '../services/GitService'
import type { TaskService } from '../services/TaskService'
import { dismissReviewPr, type DismissedPrService } from '../services/DismissedPrService'
import type { AppSettings, GitHubTokenVerifyResult } from '../../../src/types/ipc'
import type { ReviewTask } from '../../../src/types/task'
import { buildRepoFullNameMap, extractFullNameFromPrUrl, listRepoFullNames } from '../utils/repoMap'
import {
  listSearchTokens,
  normalizeTokenScope,
  parseOwnerRepoFromUrl,
  resolveGitHubToken
} from '../utils/githubToken'

// 認証エラー通知の重複抑止（同期は数分ごとに走るため、失敗の面子が変わるまで再通知しない）
let lastAuthAlertKey = ''

export function registerGitHubHandlers(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  dismissedPrService: DismissedPrService,
  getSettings: () => AppSettings,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('github:sync-prs', async () => {
    const result = await syncReviewPRs(
      gitHubService,
      gitService,
      taskService,
      dismissedPrService,
      getSettings,
      getWindow
    )
    return result
  })

  ipcMain.handle('github:dismiss-pr', async (_, taskId: string) => {
    dismissReviewPr(taskService, dismissedPrService, { taskId })
  })

  ipcMain.handle(
    'github:verify-token',
    async (_, { scope, token }: { scope: string; token: string }): Promise<GitHubTokenVerifyResult> => {
      const normalized = normalizeTokenScope(scope)
      if (!normalized) {
        return { ok: false, message: 'スコープを owner または owner/repo 形式で入力してください' }
      }
      if (!token.trim()) {
        return { ok: false, message: 'トークンを入力してください' }
      }
      try {
        return await gitHubService.verifyToken(normalized, token.trim())
      } catch (error) {
        return { ok: false, message: `確認に失敗しました: ${(error as Error).message}` }
      }
    }
  )

  // 設定済みリポジトリのgitリモートから owner 一覧を返す（トークン未登録ownerの警告用）
  ipcMain.handle('github:repo-owners', async (): Promise<string[]> => {
    const fullNames = await listRepoFullNames(gitService, getSettings())
    const owners = new Set<string>()
    for (const { fullName } of fullNames) {
      const owner = fullName.split('/')[0]
      if (owner) owners.add(owner)
    }
    return [...owners].sort((a, b) => a.localeCompare(b))
  })
}

export async function syncReviewPRs(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  dismissedPrService: DismissedPrService,
  getSettings: () => AppSettings,
  getWindow: () => BrowserWindow | null
): Promise<{ created: number; total: number; authErrors: string[] }> {
  const settings = getSettings()
  const githubUsername = settings.githubUsername?.trim()
  const searchTokens = listSearchTokens(settings)

  if (!githubUsername || searchTokens.length === 0) {
    return { created: 0, total: 0, authErrors: [] }
  }

  const authFailures: GitHubAuthFailure[] = []

  const {
    prs,
    tokenByUrl,
    authErrors: searchAuthErrors
  } = await gitHubService.fetchReviewRequestedPRs(githubUsername, searchTokens)
  authFailures.push(...searchAuthErrors)

  // PRのURLからそのPRに使えるトークンを引く。
  // 登録スコープで引けない場合は、そのPRを発見したトークンを使う。
  const tokenForUrl = (url: string): string | undefined => {
    const parsed = parseOwnerRepoFromUrl(url)
    return resolveGitHubToken(settings, parsed?.owner, parsed?.repo) ?? tokenByUrl.get(url)
  }

  // 個別PRのAPIエラーは同期全体を止めない。認証エラーのみ集約して後で通知する
  const fetchPRStatusSafely = async (
    url: string
  ): Promise<'open' | 'draft' | 'merged' | 'closed' | null> => {
    const token = tokenForUrl(url)
    if (!token) return null
    try {
      return await gitHubService.fetchPRStatus(url, token)
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        authFailures.push({ label: error.target, status: error.status, detail: error.detail })
      }
      return null
    }
  }

  // リポジトリのgitリモートURLからrepoIdへのマップを構築
  const repoFullNameMap = await buildRepoFullNameMap(gitService, settings)

  // will_do / doing の review タスクの url のみ収集（done・アーカイブは再取得対象）
  const existingTasks = taskService.list()
  const existingUrls = new Set(
    existingTasks
      .filter((t) => t.type === 'review' && (t.status === 'will_do' || t.status === 'doing'))
      .map((t) => (t as { url?: string }).url)
      .filter(Boolean)
  )

  const dismissedUrls = new Set(dismissedPrService.listUrls())

  let created = 0
  const createdTaskIds: string[] = []
  for (const pr of prs) {
    if (existingUrls.has(pr.html_url)) continue
    if (dismissedUrls.has(pr.html_url)) continue

    const repoId = repoFullNameMap.get(pr.repositoryFullName.toLowerCase())

    const newTask = taskService.create({
      type: 'review',
      status: 'will_do',
      title: `[${pr.repositoryName}] #${pr.number} ${pr.title}`,
      pane: '',
      repoId,
      url: pr.html_url,
      prStatus: pr.state as ReviewTask['prStatus']
    } as Omit<ReviewTask, 'id' | 'created_at'>)
    createdTaskIds.push(newTask.id)
    created++
  }

  // 既存reviewタスクの prStatus を同期
  const reviewTasksWithUrl = existingTasks.filter(
    (t) => t.type === 'review' && (t as { url?: string }).url
  )
  let statusUpdated = 0
  for (const task of reviewTasksWithUrl) {
    const url = (task as { url?: string }).url!
    const updates: Record<string, unknown> = {}

    // repoId未設定の既存タスクはPRのURLから補完
    if (!(task as { repoId?: string }).repoId) {
      const fullName = extractFullNameFromPrUrl(url)
      const repoId = fullName ? repoFullNameMap.get(fullName.toLowerCase()) : undefined
      if (repoId) {
        updates.repoId = repoId
      }
    }

    const prStatus = await fetchPRStatusSafely(url)
    if (prStatus !== null && prStatus !== (task as { prStatus?: string }).prStatus) {
      updates.prStatus = prStatus
    }

    if (Object.keys(updates).length > 0) {
      taskService.update(task.id, updates as Parameters<typeof taskService.update>[1])
      statusUpdated++
    }
  }

  // dismiss済みPRのうちclose/merge済みのレコードを削除（テーブル肥大防止）
  // 今回の取得結果に含まれるPRはopen確定なのでAPI確認をスキップ
  const openPrUrls = new Set(prs.map((pr) => pr.html_url))
  for (const url of dismissedUrls) {
    if (openPrUrls.has(url)) continue
    const prStatus = await fetchPRStatusSafely(url)
    if (prStatus === 'closed' || prStatus === 'merged') {
      dismissedPrService.remove(url)
    }
  }

  const hasChanges = created > 0 || statusUpdated > 0
  if (hasChanges) {
    getWindow()?.webContents.send('tasks:updated')
  }

  const { notificationsEnabled = true } = settings

  if (created > 0 && notificationsEnabled) {
    const notification = new Notification({
      title: 'レビュー依頼のPRを検出',
      body: `${created} 件の新しいレビュー依頼タスクを作成しました`
    })
    if (createdTaskIds.length > 0) {
      notification.on('click', () => {
        const win = getWindow()
        win?.show()
        win?.focus()
        win?.webContents.send('navigation:goto', { type: 'pr-detected', taskId: createdTaskIds[0] })
      })
    }
    notification.show()
  }

  const authErrors = summarizeAuthFailures(authFailures)
  notifyAuthFailures(authErrors, notificationsEnabled)

  return { created, total: prs.length, authErrors }
}

/** 同一スコープの認証エラーをまとめて表示用の文字列にする */
function summarizeAuthFailures(failures: GitHubAuthFailure[]): string[] {
  const byLabel = new Map<string, number>()
  for (const failure of failures) {
    if (!byLabel.has(failure.label)) byLabel.set(failure.label, failure.status)
  }
  return [...byLabel.entries()].map(
    ([label, status]) =>
      `${label}: ${status === 401 ? 'トークンが無効か期限切れです' : '権限が不足しています'}（HTTP ${status}）`
  )
}

/** 認証エラーを通知する。失敗の面子が前回と同じなら再通知しない */
function notifyAuthFailures(authErrors: string[], notificationsEnabled: boolean): void {
  if (authErrors.length === 0) {
    lastAuthAlertKey = ''
    return
  }

  const key = [...authErrors].sort().join('|')
  if (key === lastAuthAlertKey) return
  lastAuthAlertKey = key

  console.warn('[github] token auth failures:', authErrors.join(' / '))
  if (!notificationsEnabled) return

  new Notification({
    title: 'GitHub トークンを確認してください',
    body: authErrors.join('\n')
  }).show()
}
