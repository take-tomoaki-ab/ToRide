import type Database from 'better-sqlite3'
import type { TaskService } from './TaskService'

/**
 * dismissしたレビューPRのURLを管理するサービス。
 * dismiss済みPRはPR自動同期でタスク再作成の対象外になる。
 * PRがclose/mergeされたレコードは同期時に削除され、テーブルの肥大を防ぐ。
 */
export class DismissedPrService {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  add(url: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO dismissed_prs (url, dismissed_at) VALUES (?, ?)`)
      .run(url, new Date().toISOString())
  }

  listUrls(): string[] {
    const rows = this.db.prepare(`SELECT url FROM dismissed_prs`).all() as Array<{ url: string }>
    return rows.map((row) => row.url)
  }

  remove(url: string): void {
    this.db.prepare(`DELETE FROM dismissed_prs WHERE url = ?`).run(url)
  }
}

/**
 * PR URL を PR自動同期が突き合わせる形（GitHub の html_url と同じ形）に正規化する。
 * `/files` や `#discussion_r...` 付きのURLをそのまま登録すると、同期側の
 * `dismissedUrls.has(pr.html_url)` に一致せずタスクが再作成され、さらに
 * close/merge 判定のAPI呼び出しも失敗してレコードが永久に残る。
 */
export function normalizePrUrl(url: string): string | null {
  const match = url.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
  if (!match) return null
  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

/**
 * レビューPRを dismiss する（URLを登録して以後の自動同期の対象外にし、該当タスクを削除する）。
 * UI の Dismiss ボタン（IPC）と MCP の dismiss_pr から共用するため、ここに1本化している。
 *
 * taskId 指定なら そのタスクの url、url 指定なら そのURL自体を対象にする。
 * 同じPRを指す review タスクが複数あればまとめて削除する（残っていると次の同期で目に入り続ける）。
 */
export function dismissReviewPr(
  taskService: TaskService,
  dismissedPrService: DismissedPrService,
  target: { taskId?: string; url?: string }
): { url: string; deletedTaskIds: string[] } {
  const taskId = target.taskId?.trim()
  const rawUrl = target.url?.trim()
  if (!taskId && !rawUrl) {
    throw new Error('Either id or url is required to dismiss a PR')
  }

  let source: string
  if (taskId) {
    const task = taskService.list().find((t) => t.id === taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    const taskUrl = (task as { url?: string }).url
    if (task.type !== 'review' || !taskUrl) {
      throw new Error('Only review tasks with a PR URL can be dismissed')
    }
    source = taskUrl
  } else {
    source = rawUrl!
  }

  const url = normalizePrUrl(source)
  if (!url) {
    throw new Error(`Not a GitHub PR URL: ${source}`)
  }

  dismissedPrService.add(url)

  const deletedTaskIds: string[] = []
  for (const task of taskService.list()) {
    if (task.type !== 'review') continue
    const taskUrl = (task as { url?: string }).url
    if (!taskUrl || normalizePrUrl(taskUrl) !== url) continue
    taskService.delete(task.id)
    deletedTaskIds.push(task.id)
  }

  return { url, deletedTaskIds }
}
