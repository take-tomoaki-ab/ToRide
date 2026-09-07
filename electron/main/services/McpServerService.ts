import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LocalHttpServer } from './LocalHttpServer.js'
import type { TaskService } from './TaskService.js'
import type { DevServerService } from './DevServerService.js'
import type { RuntimeTask, Task } from '../../../src/types/task.js'
import type { AppSettings, ClaudeModel, DevServerExitInfo, LaunchMode } from '../../../src/types/ipc.js'
import { resolveDevServerUrl } from '../../../src/utils/devServerUrl.js'

export type NotifyLevel = 'info' | 'question' | 'warning'

export type McpUserNotification = {
  level: NotifyLevel
  message: string
  /** 通知タイトルに使う見出し（タスクタイトル等）。特定できなければ undefined */
  title?: string
  /** クリック時にジャンプするタスク。特定できなければ undefined */
  taskId?: string
}

const NOTIFY_LEVELS: NotifyLevel[] = ['info', 'question', 'warning']

/** get_dev_server_log の既定行数と上限。MCPレスポンスがコンテキストを食い潰さないよう抑える */
const DEFAULT_LOG_LINES = 100
const MAX_LOG_LINES = 1000

/** ログを（必要なら grep で絞ってから）末尾 lines 行に切り詰める */
const tailLog = (
  log: string,
  lines: number,
  grep?: string
): { shown: string[]; total: number; matched: number } => {
  const all = log === '' ? [] : log.replace(/\n$/, '').split('\n')
  const needle = grep?.toLowerCase()
  const filtered = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all
  return { shown: filtered.slice(-lines), total: all.length, matched: filtered.length }
}

/**
 * タスクをMCPレスポンス用に間引く。
 *
 * RuntimeTask をそのまま返すと prompt 全文 / images / rotation.history / sessionId が毎回乗り、
 * status を1つ変えるだけの呼び出しでもコンテキストを大きく食う。
 * 「どのタスクか」と「今どうなっているか」の判断に要るフィールドだけを残す。
 */
const summarizeTask = (
  task: RuntimeTask,
  opts: { detail?: boolean; prompt?: boolean } = {}
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: task.id,
    type: task.type,
    status: task.status,
    title: task.title,
  }
  // 空文字の pane（orchestrate）や未設定フィールドは行数を食うだけなので落とす
  if (task.pane) out.pane = task.pane
  if (task.repoId) out.repoId = task.repoId
  if (task.depends_on) out.depends_on = task.depends_on

  if (opts.detail) {
    // タスクを識別・操作するのに要るタイプ固有フィールドだけ。プロンプト系は含めない
    const t = task as RuntimeTask & Record<string, unknown>
    for (const key of ['branch', 'baseBranch', 'ticket', 'url', 'prStatus', 'output', 'directory']) {
      if (t[key] !== undefined && t[key] !== '') out[key] = t[key]
    }
    if (task.prUrl) out.prUrl = task.prUrl
    if (task.workdir) out.workdir = task.workdir
    if (task.pid !== undefined) out.pid = task.pid
    // 2フィールド返すより使用率1つのほうが軽く、閾値判断にはこれで足りる
    if (task.contextUsed !== undefined && task.contextLimit) {
      out.contextPercent = Math.round((task.contextUsed / task.contextLimit) * 100)
    }
    if (task.startedAt) out.startedAt = task.startedAt
    if (task.completedAt) out.completedAt = task.completedAt
    if (task.rotationPending) out.rotationPending = true
    if (task.rotationDisabledReason) out.rotationDisabledReason = task.rotationDisabledReason
  }

  if (opts.prompt && task.prompt) out.prompt = task.prompt

  return out
}

/** MCPレスポンス用のJSON。インデントは嵩むだけなので付けない */
const toJson = (value: unknown): string => JSON.stringify(value)

/** DevServerExitInfo を1行のサマリにする */
const formatExit = (exit?: DevServerExitInfo): string => {
  if (!exit) return 'なし（未終了 or 未起動）'
  const parts = [`code=${exit.code}`, `signal=${exit.signal}`, `reason=${exit.reason}`, `at=${exit.at}`]
  if (exit.message) parts.push(`message=${exit.message}`)
  return parts.join(' ')
}

/** タイトル文字列から対象タスクを引く。doing のタスクを優先し、完全一致 → 部分一致で探す */
const findTaskByTitle = (tasks: Task[], title: string): Task | undefined => {
  const norm = (s: string) => s.trim().toLowerCase()
  const target = norm(title)
  if (!target) return undefined
  const ordered = [...tasks].sort(
    (a, b) => Number(b.status === 'doing') - Number(a.status === 'doing')
  )
  return (
    ordered.find((t) => norm(t.title) === target) ??
    ordered.find((t) => norm(t.title).includes(target) || target.includes(norm(t.title)))
  )
}

export class McpServerService {
  constructor(
    localServer: LocalHttpServer,
    taskService: TaskService,
    devServerService: DevServerService,
    getSettings: () => AppSettings,
    notifyTasksUpdated: () => void = () => {},
    startTask?: (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>,
    notifyUser?: (notification: McpUserNotification) => void,
    getRotationStatus?: (taskId: string) => unknown | null,
    dismissPr?: (target: { taskId?: string; url?: string }) => { url: string; deletedTaskIds: string[] }
  ) {
    const createServer = (): Server => {
      const server = new Server(
        { name: 'toride', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'create_task',
            description: 'ToRide にタスクを登録する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                type: {
                  type: 'string',
                  enum: ['feat', 'bugfix', 'review', 'research', 'design', 'chore', 'orchestrate'],
                  description: 'タスクのタイプ',
                },
                title: { type: 'string', description: 'タスクのタイトル' },
                branch: { type: 'string', description: 'ブランチ名（type が feat/bugfix/research の場合は必須）' },
                baseBranch: { type: 'string', description: '分岐元ブランチ名' },
                ticket: {
                  type: 'string',
                  description:
                    'WrikeチケットURL（type が feat/bugfix の場合は必須）。会話やミッションにチケットURLが含まれていれば必ず設定し、不明な場合は空のまま作成せずユーザーに確認すること',
                },
                prompt: {
                  type: 'string',
                  description:
                    'Claude に渡すプロンプト。省略すると設定済みのタスクタイプ別テンプレートが自動適用されるため、タスク固有の指示がなければ省略を推奨。' +
                    '指定した場合はテンプレートの代わりにこのプロンプトが使われる。プロンプト内では {title} {branch} {ticket} {pr-url} {output} {directory} のテンプレート変数が起動時に展開されるため、' +
                    'title・branch・ticket 等の他フィールドの値を直書きせず変数で参照すること',
                },
                repoId: { type: 'string', description: 'リポジトリID（chore以外のタイプでは必須。list_repos で確認可能）' },
                url: { type: 'string', description: 'GitHub PR URL（type が review の場合は必須）' },
                output: { type: 'string', description: '出力先パス（type が design の場合は必須）' },
                directory: { type: 'string', description: '作業ディレクトリ（type が chore の場合は必須）' },
                depends_on: { type: 'string', description: '依存するタスクの ID。指定したタスクが完了するまでこのタスクを開始できない' },
              },
              required: ['type', 'title'],
            },
          },
          {
            name: 'list_tasks',
            description:
              '現在登録されているタスクの一覧を取得する。' +
              'レスポンスにはプロンプト本文は含まれない（必要なときだけ include_prompt を指定すること）',
            inputSchema: {
              type: 'object' as const,
              properties: {
                status: {
                  type: 'string',
                  enum: ['will_do', 'doing', 'done'],
                  description: 'フィルタするステータス（省略時は全件）',
                },
                id: { type: 'string', description: 'タスクIDで1件だけ取得する' },
                include_prompt: {
                  type: 'boolean',
                  description:
                    'プロンプト本文を含める（既定 false）。全件に対して指定するとコンテキストを大きく消費するため、id や status で絞ってから使うこと',
                },
              },
            },
          },
          {
            name: 'list_repos',
            description: '設定済みのリポジトリ一覧を取得する。create_task の repoId に使う値がわかる',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: 'update_task',
            description:
              'タスクのタイトル・ステータス・プロンプトなどを更新する。指定したフィールドだけが変更される。' +
              'レスポンスは更新後の要約のみで、プロンプト本文やローテーション履歴は含まれない',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
                title: { type: 'string', description: '新しいタイトル' },
                status: {
                  type: 'string',
                  enum: ['will_do', 'doing', 'done'],
                  description: '新しいステータス',
                },
                prompt: { type: 'string', description: '新しいプロンプト' },
                depends_on: { type: 'string', description: '依存するタスクの ID（空文字で依存関係を解除）' },
                rotation: {
                  type: 'object',
                  description:
                    'セッションローテーション設定。コンテキスト使用率が threshold に達したら handoff ファイルに引き継ぎを書かせてセッションを作り直す。' +
                    '未指定のキーはアプリのグローバル既定値にフォールバックする',
                  properties: {
                    enabled: { type: 'boolean', description: '有効にするか（既定 false）' },
                    threshold: { type: 'number', description: 'ローテーションを開始する使用率(%)。既定 60' },
                    handoffPath: { type: 'string', description: '引き継ぎファイルのパス。enabled 時は必須' },
                    bootPrompt: { type: 'string', description: '新セッションへの追記文面。変数 {handoffPath} {rotationCount}' },
                  },
                },
              },
              required: ['id'],
            },
          },
          {
            name: 'delete_task',
            description: 'タスクを削除する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
              },
              required: ['id'],
            },
          },
          {
            name: 'dismiss_pr',
            description:
              'レビュー依頼PRを dismiss する。PR URL を dismiss 済みとして記録し、該当する review タスクを削除する。' +
              '以後そのPRはPR自動同期でタスク再作成されない（PRがclose/mergeされると記録は自動で消える）。' +
              'id と url のどちらか一方を指定する（id は list_tasks で確認可能）',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'review タスクのID。そのタスクの PR URL を dismiss する' },
                url: {
                  type: 'string',
                  description:
                    'GitHub PR URL。タスクが存在しないPRでも先回りで dismiss できる。該当する review タスクがあれば併せて削除される',
                },
              },
            },
          },
          {
            name: 'start_task',
            description: 'タスクを起動する（doing 状態にして Claude を起動）。空きペインがない場合はエラーになる',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
                launchMode: {
                  type: 'string',
                  enum: ['normal', 'auto', 'bypass', 'plan'],
                  description: 'Claude の起動モード。省略時は設定値に従う。bypass=--dangerously-skip-permissions, auto=--permission-mode auto, plan=--permission-mode plan, normal=デフォルト',
                },
                model: {
                  type: 'string',
                  description:
                    'Claude のモデル。default（または省略）は --model 指定なし。エイリアス（opus / sonnet / haiku / fable 等）またはフルモデルID（claude-fable-5 等）を指定すると --model <値> で起動する',
                },
              },
              required: ['id'],
            },
          },
          {
            name: 'get_rotation_status',
            description:
              'セッションローテーションの状態を取得する。現在の使用率・閾値・これまでのローテーション回数と履歴・' +
              '保留や自動停止（ガード作動）の状態がわかる。自分が何回目の引き継ぎセッションかを確認するのに使う',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
              },
              required: ['id'],
            },
          },
          {
            name: 'list_dev_servers',
            description:
              '設定済みの開発サーバーの一覧と起動状態を取得する。各エントリに repoId / paneId / label / workdir（作業ディレクトリ）/ runningTaskId（そのペインで実行中のタスクID）/ runningTaskTitle が含まれる。' +
              'start_dev_server を呼ぶ前に必ずこのツールを呼び出し、現在の自分のタスクIDと runningTaskId が一致するペインを選ぶこと。一致するペインが存在しない場合は workdir でカレントディレクトリと照合して選ぶこと。',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: 'start_dev_server',
            description:
              '開発サーバーを起動する。すでに起動中の場合は再起動される。起動は非同期のため、結果は list_dev_servers で確認できる。' +
              '呼び出す前に list_dev_servers で現在のタスクが動いているペイン（runningTaskId が自分のタスクIDと一致するもの）を特定し、そのペインの repoId / paneId を使うこと。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                repoId: { type: 'string', description: 'リポジトリID（list_dev_servers で確認可能）' },
                paneId: { type: 'string', description: 'ペインID' },
                label: { type: 'string', description: '開発サーバーのラベル' },
              },
              required: ['repoId', 'paneId', 'label'],
            },
          },
          {
            name: 'notify_user',
            description:
              'ユーザーのデスクトップに通知を送る。ユーザーの判断・入力を仰ぎたいとき（質問する直前など）や、ユーザーが知るべき警告・重要な結果が出たときに呼ぶ。' +
              '進捗の逐次報告や、そのまま作業を続行できる内容では呼ばないこと（通知が埋もれて役に立たなくなる）。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                message: {
                  type: 'string',
                  description: '通知の本文。通知欄で読み切れる1〜2文で要点を書く',
                },
                level: {
                  type: 'string',
                  enum: ['info', 'question', 'warning'],
                  description:
                    '通知の種別。question=ユーザーの入力・判断を待っている、warning=注意が必要な事象、info=単なるお知らせ（省略時は info）',
                },
                title: {
                  type: 'string',
                  description: '通知タイトルに使う短い見出し。省略時は taskTitle / taskId から解決したタスク名が使われる',
                },
                taskTitle: {
                  type: 'string',
                  description:
                    '自分が担当しているタスクのタイトル。通知クリックで該当タスクへジャンプさせるために使う。分かる範囲で指定する',
                },
                taskId: {
                  type: 'string',
                  description: 'タスクID（分かる場合のみ。taskTitle より優先される。list_tasks で確認可能）',
                },
              },
              required: ['message'],
            },
          },
          {
            name: 'get_dev_server_log',
            description:
              '開発サーバーの標準出力・標準エラーのログを取得する。サーバーが落ちた・起動しない・リクエストが失敗するといったときに原因を調べるために使う。' +
              '停止後もログは残るため、異常終了（list_dev_servers の lastExit.reason が abnormal）したサーバーの原因調査にも使える。' +
              `既定では末尾 ${DEFAULT_LOG_LINES} 行を返す（最大 ${MAX_LOG_LINES} 行）。repoId / paneId / label は list_dev_servers で確認すること。`,
            inputSchema: {
              type: 'object' as const,
              properties: {
                repoId: { type: 'string', description: 'リポジトリID（list_dev_servers で確認可能）' },
                paneId: { type: 'string', description: 'ペインID' },
                label: { type: 'string', description: '開発サーバーのラベル' },
                lines: {
                  type: 'number',
                  description: `末尾から取得する行数（既定 ${DEFAULT_LOG_LINES} / 最大 ${MAX_LOG_LINES}）`,
                },
                grep: {
                  type: 'string',
                  description:
                    '指定するとこの文字列を含む行だけに絞り込む（大文字小文字を区別しない）。絞り込んだ結果の末尾 lines 行を返す',
                },
              },
              required: ['repoId', 'paneId', 'label'],
            },
          },
          {
            name: 'stop_dev_server',
            description: '起動中の開発サーバーを停止する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                repoId: { type: 'string', description: 'リポジトリID（list_dev_servers で確認可能）' },
                paneId: { type: 'string', description: 'ペインID' },
                label: { type: 'string', description: '開発サーバーのラベル' },
              },
              required: ['repoId', 'paneId', 'label'],
            },
          },
        ],
      }))

      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>
        try {
          switch (req.params.name) {
            case 'list_repos': {
              const repos = getSettings().repos.map((r) => ({ id: r.id, name: r.name }))
              return { content: [{ type: 'text' as const, text: JSON.stringify(repos, null, 2) }] }
            }
            case 'create_task': {
              const { type, title, status, pane, ...rest } = args as {
                type: Task['type']
                title: string
                status?: Task['status']
                pane?: string
                [key: string]: unknown
              }
              if (type !== 'chore' && type !== 'orchestrate' && !rest.repoId) {
                throw new Error('repoId is required for non-chore tasks. Use list_repos to get valid repo IDs.')
              }
              if ((type === 'feat' || type === 'bugfix') && !rest.ticket) {
                throw new Error(
                  'ticket is required for feat/bugfix tasks. Provide the Wrike ticket URL, or ask the user for it if unknown.'
                )
              }
              const task = taskService.create({
                type,
                title,
                status: status ?? 'will_do',
                pane: pane ?? '',
                ...rest,
              } as Omit<Task, 'id' | 'created_at'>)
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: toJson(summarizeTask(task, { detail: true })) }] }
            }
            case 'list_tasks': {
              const { status, id, include_prompt } = args as {
                status?: Task['status']
                id?: string
                include_prompt?: boolean
              }
              const filtered = taskService
                .list()
                .filter((t) => (id ? t.id === id : true))
                .filter((t) => (status ? t.status === status : true))
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: toJson(
                      filtered.map((t) => summarizeTask(t, { detail: true, prompt: include_prompt }))
                    ),
                  },
                ],
              }
            }
            case 'update_task': {
              const { id, ...data } = args as { id: string } & Record<string, unknown>
              const task = taskService.update(id, data as Partial<Task>)
              notifyTasksUpdated()
              // 何を書き換えたかは呼び出し側の確認に要るが、値の再掲は不要なのでキー名だけ返す
              const updated = Object.keys(data)
              return {
                content: [
                  { type: 'text' as const, text: toJson({ ...summarizeTask(task), updated }) },
                ],
              }
            }
            case 'delete_task': {
              const { id } = args as { id: string }
              taskService.delete(id)
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: `deleted: ${id}` }] }
            }
            case 'dismiss_pr': {
              const { id, url } = args as { id?: string; url?: string }
              if (!dismissPr) {
                throw new Error('dismiss_pr is not available')
              }
              const result = dismissPr({ taskId: id, url })
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: toJson({ dismissed: result.url, deletedTaskIds: result.deletedTaskIds }) }] }
            }
            case 'start_task': {
              const { id, launchMode, model } = args as { id: string; launchMode?: LaunchMode; model?: ClaudeModel }
              if (!startTask) {
                throw new Error('start_task is not available')
              }
              await startTask(id, launchMode, model)
              notifyTasksUpdated()
              const task = taskService.list().find((t) => t.id === id)
              if (!task) {
                throw new Error(`Task not found: ${id}`)
              }
              return {
                content: [{ type: 'text' as const, text: toJson(summarizeTask(task, { detail: true })) }],
              }
            }
            case 'get_rotation_status': {
              const { id } = args as { id: string }
              if (!getRotationStatus) {
                throw new Error('get_rotation_status is not available')
              }
              const status = getRotationStatus(id)
              if (!status) {
                throw new Error(`Task not found: ${id}`)
              }
              return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] }
            }
            case 'list_dev_servers': {
              const statuses = devServerService.status()
              const doingTasks = taskService.list().filter((t) => t.status === 'doing')
              const servers = getSettings().repos.flatMap((repo) =>
                repo.panes.flatMap((pane) => {
                  const runningTask = doingTasks.find(
                    (t) => t.repoId === repo.id && t.pane === pane.id
                  )
                  return pane.devServers.map((server) => {
                    const status = statuses.find(
                      (s) => s.repoId === repo.id && s.paneId === pane.id && s.label === server.label
                    )
                    return {
                      repoId: repo.id,
                      repoName: repo.name,
                      paneId: pane.id,
                      workdir: pane.path,
                      runningTaskId: runningTask?.id ?? null,
                      runningTaskTitle: runningTask?.title ?? null,
                      label: server.label,
                      url: resolveDevServerUrl(server.url) ?? null,
                      running: status?.running ?? false,
                      pid: status?.pid,
                      // 落ちたことに気づけるよう直近の終了情報を返す。詳細は get_dev_server_log で追う
                      lastExitCode: status?.lastExit?.code ?? null,
                      lastExitSignal: status?.lastExit?.signal ?? null,
                      lastExitedAt: status?.lastExit?.at ?? null,
                      lastExitReason: status?.lastExit?.reason ?? null,
                      lastExitMessage: status?.lastExit?.message ?? null,
                    }
                  })
                })
              )
              return { content: [{ type: 'text' as const, text: JSON.stringify(servers, null, 2) }] }
            }
            case 'start_dev_server': {
              const { repoId, paneId, label } = args as { repoId: string; paneId: string; label: string }
              const repo = getSettings().repos.find((r) => r.id === repoId)
              if (!repo) {
                throw new Error(`Repo not found: ${repoId}. Use list_dev_servers to get valid IDs.`)
              }
              const paneConfig = repo.panes.find((p) => p.id === paneId)
              if (!paneConfig) {
                throw new Error(`Pane not found: ${paneId} in repo ${repoId}`)
              }
              const serverConfig = paneConfig.devServers.find((s) => s.label === label)
              if (!serverConfig) {
                throw new Error(`Dev server not found: ${label} in pane ${paneId}`)
              }
              devServerService.start(repoId, paneConfig, serverConfig)
              return { content: [{ type: 'text' as const, text: `started: ${repoId}:${paneId}:${label}` }] }
            }
            case 'notify_user': {
              const { message, level, title, taskTitle, taskId } = args as {
                message?: string
                level?: NotifyLevel
                title?: string
                taskTitle?: string
                taskId?: string
              }
              if (!notifyUser) {
                throw new Error('notify_user is not available')
              }
              if (typeof message !== 'string' || !message.trim()) {
                throw new Error('message is required')
              }
              const resolvedLevel = level ?? 'info'
              if (!NOTIFY_LEVELS.includes(resolvedLevel)) {
                throw new Error(`Invalid level: ${resolvedLevel}. Use one of ${NOTIFY_LEVELS.join(' / ')}`)
              }
              const tasks = taskService.list()
              const task =
                (taskId ? tasks.find((t) => t.id === taskId) : undefined) ??
                (taskTitle ? findTaskByTitle(tasks, taskTitle) : undefined)
              notifyUser({
                level: resolvedLevel,
                message: message.trim(),
                title: title?.trim() || task?.title || taskTitle?.trim() || undefined,
                taskId: task?.id,
              })
              return { content: [{ type: 'text' as const, text: 'notified' }] }
            }
            case 'get_dev_server_log': {
              const { repoId, paneId, label, lines, grep } = args as {
                repoId: string
                paneId: string
                label: string
                lines?: number
                grep?: string
              }
              const repo = getSettings().repos.find((r) => r.id === repoId)
              if (!repo) {
                throw new Error(`Repo not found: ${repoId}. Use list_dev_servers to get valid IDs.`)
              }
              const paneConfig = repo.panes.find((p) => p.id === paneId)
              if (!paneConfig) {
                throw new Error(`Pane not found: ${paneId} in repo ${repoId}`)
              }
              if (!paneConfig.devServers.some((s) => s.label === label)) {
                throw new Error(`Dev server not found: ${label} in pane ${paneId}`)
              }

              const limit = Math.min(
                Math.max(Math.floor(Number(lines) || DEFAULT_LOG_LINES), 1),
                MAX_LOG_LINES
              )
              const keyword = typeof grep === 'string' && grep.trim() ? grep.trim() : undefined
              const log = devServerService.getLog(repoId, paneId, label)
              const { shown, total, matched } = tailLog(log, limit, keyword)
              const status = devServerService
                .status()
                .find((s) => s.repoId === repoId && s.paneId === paneId && s.label === label)

              const header = [
                `server: ${repoId}:${paneId}:${label}`,
                `running: ${status?.running ?? false}${status?.pid ? ` (pid=${status.pid})` : ''}`,
                `lastExit: ${formatExit(status?.lastExit)}`,
                keyword
                  ? `log: 全${total}行中 "${keyword}" にマッチ${matched}行 / 末尾${shown.length}行を表示`
                  : `log: 全${total}行 / 末尾${shown.length}行を表示`,
              ].join('\n')

              const body = shown.length
                ? shown.join('\n')
                : keyword
                  ? `("${keyword}" にマッチする行はありません)`
                  : '(ログなし。まだ起動していない可能性があります)'
              return { content: [{ type: 'text' as const, text: `${header}\n--- log ---\n${body}` }] }
            }
            case 'stop_dev_server': {
              const { repoId, paneId, label } = args as { repoId: string; paneId: string; label: string }
              devServerService.stop(repoId, paneId, label)
              return { content: [{ type: 'text' as const, text: `stopped: ${repoId}:${paneId}:${label}` }] }
            }
            default:
              throw new Error(`Unknown tool: ${req.params.name}`)
          }
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
            isError: true,
          }
        }
      })

      return server
    }

    // StreamableHTTP エンドポイント (GET/POST /mcp)
    localServer.addRawRoute('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const server = createServer()
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })
  }
}
