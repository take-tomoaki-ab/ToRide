import { app, BrowserWindow, shell, ipcMain, safeStorage, protocol, dialog, powerMonitor } from 'electron'
import { join, extname } from 'path'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, getDatabase } from './db/schema'
import { TaskService } from './services/TaskService'
import { TerminalService } from './services/TerminalService'
import { GitService } from './services/GitService'
import { ClaudeService } from './services/ClaudeService'
import { DevServerService } from './services/DevServerService'
import { GitHubService } from './services/GitHubService'
import { DismissedPrService, dismissReviewPr } from './services/DismissedPrService'
import { LocalHttpServer } from './services/LocalHttpServer'
import { StopHookService } from './services/StopHookService'
import { ContextLineService } from './services/ContextLineService'
import { McpServerService, type McpUserNotification } from './services/McpServerService'
import { ModelListService } from './services/ModelListService'
import { SlashCommandService } from './services/SlashCommandService'
import { McpHookService } from './services/McpHookService'
import { SessionRotationService } from './services/SessionRotationService'
import { ResidentOrchestratorService } from './services/ResidentOrchestratorService'
import { importImages, deleteImages } from './services/ImageStore'
import { PluginRegistry } from './plugins/PluginRegistry'
import { PLUGIN_CATALOG } from './plugins/catalog'
import { registerTaskHandlers } from './ipc/tasks'
import { registerTerminalHandlers } from './ipc/terminal'
import { registerGitHandlers } from './ipc/git'
import { registerClaudeHandlers, createStartTaskFn } from './ipc/claude'
import { registerDevServerHandlers } from './ipc/devServer'
import { registerGitHubHandlers, syncReviewPRs } from './ipc/github'
import { registerTicketHandlers } from './ipc/ticket'
import { registerNotificationHandlers } from './ipc/notifications'
import { NotificationService } from './services/NotificationService'
import type { AppSettings } from '../../src/types/ipc'

// GUIアプリとして起動した場合のベースラインPATH拡張（シェルプロファイルが読まれないため）
process.env.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`

// bg:// カスタムプロトコルをセキュアとして登録（app.whenReady より前に必要）
protocol.registerSchemesAsPrivileged([
  { scheme: 'bg', privileges: { secure: true, standard: true, supportFetchAPI: true } }
])

// プラグインレジストリ（getSettings() から参照するためモジュールレベルで初期化）
const registry = new PluginRegistry()

let mainWindow: BrowserWindow | null = null
let devServerServiceInstance: DevServerService | null = null
let terminalServiceInstance: TerminalService | null = null
let localHttpServerInstance: LocalHttpServer | null = null
let prSyncTimerId: ReturnType<typeof setInterval> | null = null

function getWindow(): BrowserWindow | null {
  return mainWindow
}

function getSettings(): AppSettings {
  const db = getDatabase()
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('settings') as
    | { value: string }
    | undefined

  if (!row) {
    return { repos: [] }
  }

  const raw = JSON.parse(row.value) as Record<string, unknown>

  // 旧 panes 形式から repos 形式へのマイグレーション
  if (raw.panes && !raw.repos) {
    raw.repos = [{ id: 'repo1', name: 'default', panes: raw.panes as import('../../src/types/ipc').PaneConfig[] }]
    delete raw.panes
  }

  // 旧 devServers[].port（数値）→ url（文字列）へのマイグレーション
  if (raw.repos) {
    for (const repo of raw.repos as import('../../src/types/ipc').RepoConfig[]) {
      for (const pane of repo.panes ?? []) {
        for (const ds of pane.devServers ?? []) {
          const legacy = ds as { port?: number; url?: string }
          if (legacy.port !== undefined && legacy.url === undefined) {
            legacy.url = String(legacy.port)
          }
          delete legacy.port
        }
      }
    }
  }

  // 旧 wrikeAccessToken/wrikeItemTypeFeatId/wrikeItemTypeBugfixId → pluginSettings.wrike へのマイグレーション
  if (raw.wrikeAccessToken !== undefined || raw.wrikeItemTypeFeatId !== undefined) {
    if (!raw.pluginSettings) raw.pluginSettings = {}
    ;(raw.pluginSettings as Record<string, Record<string, string>>)['wrike'] = {
      accessToken: (raw.wrikeAccessToken as string) ?? '',
      itemTypeFeatId: (raw.wrikeItemTypeFeatId as string) ?? '',
      itemTypeBugfixId: (raw.wrikeItemTypeBugfixId as string) ?? '',
    }
    delete raw.wrikeAccessToken
    delete raw.wrikeItemTypeFeatId
    delete raw.wrikeItemTypeBugfixId
  }

  // enabledPlugins マイグレーション: 未設定かつ wrike accessToken 設定済みなら ['wrike'] に
  if (!raw.enabledPlugins) {
    const hasWrikeToken = !!(raw.pluginSettings as Record<string, Record<string, string>> | undefined)?.wrike?.accessToken
    raw.enabledPlugins = hasWrikeToken ? ['wrike'] : []
  }

  const settings = raw as AppSettings

  // Decrypt GitHub PAT if exists
  if (settings.githubPat && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = Buffer.from(settings.githubPat, 'base64')
      settings.githubPat = safeStorage.decryptString(encrypted)
    } catch {
      // Decryption failed (e.g., app was renamed and safeStorage key changed).
      // Clear to undefined so the user is prompted to re-enter rather than
      // using the garbage encrypted bytes as the actual token.
      settings.githubPat = undefined
      console.warn('[settings] GitHub PAT decryption failed - cleared. User needs to re-enter.')
    }
  }

  // Decrypt per-owner GitHub tokens
  if (settings.githubTokens && safeStorage.isEncryptionAvailable()) {
    settings.githubTokens = settings.githubTokens.map((entry) => {
      if (!entry.token) return entry
      try {
        const encrypted = Buffer.from(entry.token, 'base64')
        return { ...entry, token: safeStorage.decryptString(encrypted) }
      } catch {
        // 復号失敗（アプリ名変更等でsafeStorageの鍵が変わった場合）。
        // 暗号化バイト列をトークンとして使わないよう空にして再入力を促す。
        console.warn(
          `[settings] GitHub token decryption failed for scope "${entry.scope}" - cleared. User needs to re-enter.`
        )
        return { ...entry, token: '' }
      }
    })
  }

  // Decrypt encrypted plugin settings
  if (settings.pluginSettings && safeStorage.isEncryptionAvailable()) {
    for (const plugin of registry.listTicketPlugins()) {
      const ps = settings.pluginSettings[plugin.id]
      if (!ps) continue
      for (const field of plugin.settingFields) {
        if (field.encrypted && ps[field.key]) {
          try {
            const encrypted = Buffer.from(ps[field.key], 'base64')
            ps[field.key] = safeStorage.decryptString(encrypted)
          } catch {
            // Decryption failed - clear so the field is treated as unset
            ps[field.key] = ''
            console.warn(`[settings] Plugin ${plugin.id}.${field.key} decryption failed - cleared.`)
          }
        }
      }
    }
  }

  return settings
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url && details.url !== 'about:blank') {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '')) return
    if (!is.dev && url.startsWith('file://')) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.toride')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize database
  const db = initDatabase()

  // 起動時にdoingタスクをwill_doに戻す（再起動でPTYセッションが消えるため）
  db.prepare(`UPDATE tasks SET status = 'will_do' WHERE status = 'doing'`).run()
  db.prepare(`DELETE FROM task_runtime`).run()

  // 設定の extraPaths を PATH に追加（git hooks等の子プロセスに引き継ぐため）
  {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('settings') as { value: string } | undefined
    if (row) {
      const raw = JSON.parse(row.value) as { extraPaths?: string[] }
      const extras = (raw.extraPaths ?? []).filter(Boolean)
      if (extras.length > 0) {
        process.env.PATH = `${extras.join(':')}:${process.env.PATH || ''}`
      }
    }
  }

  // 設定保存ヘルパー（暗号化 + DB保存）
  function saveSettings(merged: AppSettings): void {
    const toSave = { ...merged }
    if (toSave.githubPat && safeStorage.isEncryptionAvailable()) {
      toSave.githubPat = safeStorage.encryptString(toSave.githubPat).toString('base64')
    }
    if (toSave.githubTokens) {
      // 空スコープ・空トークンの行は保存しない（UI上の未入力行を残さない）
      const entries = toSave.githubTokens.filter((e) => e.scope.trim() && e.token.trim())
      toSave.githubTokens = safeStorage.isEncryptionAvailable()
        ? entries.map((e) => ({
            ...e,
            token: safeStorage.encryptString(e.token).toString('base64')
          }))
        : entries
    }
    if (toSave.pluginSettings && safeStorage.isEncryptionAvailable()) {
      for (const plugin of registry.listTicketPlugins()) {
        const ps = toSave.pluginSettings[plugin.id]
        if (!ps) continue
        for (const field of plugin.settingFields) {
          if (field.encrypted && ps[field.key]) {
            toSave.pluginSettings[plugin.id][field.key] = safeStorage
              .encryptString(ps[field.key])
              .toString('base64')
          }
        }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(
      'settings',
      JSON.stringify(toSave)
    )
  }

  // 起動時: enabledPlugins に基づいてプラグインを条件付き登録
  {
    const initialSettings = getSettings()
    const enabled = initialSettings.enabledPlugins ?? []
    for (const item of PLUGIN_CATALOG) {
      if (enabled.includes(item.id)) {
        registry.registerTicketPlugin(item.factory())
      }
    }
  }

  // Initialize services
  const notificationService = new NotificationService({
    db,
    getWindow,
    isDesktopEnabled: () => getSettings().notificationsEnabled ?? true,
  })
  const taskService = new TaskService(db)
  const terminalService = new TerminalService()
  terminalServiceInstance = terminalService
  const gitService = new GitService()
  const devServerService = new DevServerService()
  devServerServiceInstance = devServerService
  devServerService.onAbnormalExit(({ repoId, paneId, label }) => {
    notificationService.notify({
      category: 'devserver',
      level: 'error',
      title: 'Dev Server 異常終了',
      body: `「${label}」が予期せず終了しました`,
      navigation: { type: 'devserver', repoId, paneId, label },
    })
  })
  const gitHubService = new GitHubService()
  const dismissedPrService = new DismissedPrService(db)
  const localHttpServer = new LocalHttpServer()
  localHttpServerInstance = localHttpServer
  const stopHookService = new StopHookService(localHttpServer)
  const contextLineService = new ContextLineService(localHttpServer)
  const mcpHookService = new McpHookService()
  // rotationService は startTaskFn に依存し、startTaskFn は claudeService に依存するため、
  // claudeService へは遅延参照のクロージャで渡す（生成順の循環を避ける）
  let rotationService: SessionRotationService | null = null
  const claudeService = new ClaudeService(
    terminalService,
    contextLineService,
    (taskId) => rotationService?.isRotationEnabled(taskId) ?? false,
    (input) => notificationService.notify(input)
  )
  contextLineService.onPrDetected(({ taskId, prUrl }) => {
    try {
      // reviewタスクはレビュー対象PRをurlに持つため、検知したPRを紐付けない
      const task = taskService.list().find((t) => t.id === taskId)
      if (!task || task.type === 'review') return
      taskService.update(taskId, { prUrl })
      getWindow()?.webContents.send('tasks:updated')
    } catch (err) {
      console.error('[contextLineService] PR URL save failed:', err)
    }
  })
  const startTaskFn = createStartTaskFn({
    claudeService,
    taskService,
    gitService,
    terminalService,
    getWindow,
    getSettings,
    stopHookService,
  })
  rotationService = new SessionRotationService({
    taskService,
    claudeService,
    terminalService,
    stopHookService,
    gitService,
    getSettings,
    getWindow,
    startTask: startTaskFn,
    notify: (input) => notificationService.notify(input),
  })
  // 閾値判定はコンテキスト更新に相乗りする（Status Line Hook 経由が主系）
  claudeService.onContextUpdate((info) => rotationService?.onContextUpdate(info))

  // タスクが done になったら Claude セッションを確実に終了させる。
  // 完了経路は UI の完了ボタン / 通知の「承認して完了」/ MCP の update_task と複数あるため、
  // TaskService の status 変化に1本だけフックして取りこぼしを防ぐ。
  // 落とさないと claude とそのバックグラウンドジョブが走り続け、完了後も通知を出してくる
  const endTaskSession = (taskId: string) => {
    stopHookService.removeTaskCallback(taskId)
    rotationService?.clear(taskId)
    claudeService.resetContextTracking(taskId)
    terminalService.kill(taskId)
  }
  taskService.onStatusChange(({ taskId, to }) => {
    if (to === 'done') endTaskSession(taskId)
  })
  // 実行中のまま削除／アーカイブされた場合もセッションが孤児になる
  taskService.onDeleted((taskId) => endTaskSession(taskId))

  const NOTIFY_LEVEL_LABEL: Record<McpUserNotification['level'], string> = {
    info: 'お知らせ',
    question: '入力待ち',
    warning: '注意',
  }
  const notifyUserFromMcp = ({ level, message, title, taskId }: McpUserNotification) => {
    const label = NOTIFY_LEVEL_LABEL[level]
    notificationService.notify({
      category: 'mcp',
      level: level === 'warning' ? 'warning' : 'info',
      title: title ? `[${label}] ${title}` : `[${label}]`,
      body: message,
      navigation: taskId ? { type: 'task', taskId } : null,
      urgency: level === 'warning' ? 'critical' : 'normal',
    })
  }
  new McpServerService(localHttpServer, taskService, devServerService, getSettings, () => {
    getWindow()?.webContents.send('tasks:updated')
  }, startTaskFn, notifyUserFromMcp, (taskId) => rotationService?.getStatus(taskId) ?? null,
    (target) => dismissReviewPr(taskService, dismissedPrService, target))
  const initialPort = getSettings().stopHookPort ?? 39457
  localHttpServer.start(initialPort).catch((e) => {
    console.error('[LocalHttpServer] failed to start:', e)
  })

  // Register IPC handlers
  registerTaskHandlers(taskService, getSettings, getWindow)
  registerNotificationHandlers(notificationService)
  registerTerminalHandlers(terminalService, getWindow, stopHookService, rotationService ?? undefined)
  registerGitHandlers(gitService)
  const modelListService = new ModelListService()
  registerClaudeHandlers(
    claudeService,
    taskService,
    gitService,
    terminalService,
    getWindow,
    getSettings,
    stopHookService,
    modelListService
  )

  // スラッシュコマンド／スキル補完
  const slashCommandService = new SlashCommandService()
  ipcMain.handle('claude:list-commands', (_, workdir?: string) =>
    slashCommandService.listCommands(workdir)
  )

  // Stop Hook IPC handlers
  ipcMain.handle('hooks:status', () => stopHookService.getHookStatus())
  ipcMain.handle('hooks:install', () => stopHookService.installHook())
  ipcMain.handle('hooks:uninstall', () => stopHookService.uninstallHook())

  // Session Rotation IPC handlers
  ipcMain.handle('rotation:status', (_, taskId: string) => rotationService?.getStatus(taskId) ?? null)
  ipcMain.handle('rotation:rotate-now', async (_, taskId: string) => {
    if (!rotationService) throw new Error('ROTATION_UNAVAILABLE')
    await rotationService.rotateNow(taskId)
  })

  // MCP Server IPC handlers
  ipcMain.handle('mcp:status', () => mcpHookService.getStatus())
  ipcMain.handle('mcp:install', () => mcpHookService.install(localHttpServer.getPort()))
  ipcMain.handle('mcp:uninstall', () => mcpHookService.uninstall())

  // Status Line (context) IPC handlers
  ipcMain.handle('hooks:statusline-status', () => contextLineService.getStatusLineStatus())
  ipcMain.handle('hooks:statusline-install', () => contextLineService.installStatusLine())
  ipcMain.handle('hooks:statusline-uninstall', () => contextLineService.uninstallStatusLine())
  registerDevServerHandlers(devServerService, getWindow, getSettings)
  registerGitHubHandlers(gitHubService, gitService, taskService, dismissedPrService, getSettings, getWindow)
  registerTicketHandlers(registry, getSettings, gitHubService, gitService)

  // PR自動同期タイマー（1分ごとにチェックし、設定された間隔で同期を実行）
  let lastPrSyncAt = 0
  prSyncTimerId = setInterval(async () => {
    const s = getSettings()
    const intervalMs = (s.githubPrSyncIntervalMin ?? 5) * 60 * 1000
    const now = Date.now()
    if (now - lastPrSyncAt >= intervalMs) {
      lastPrSyncAt = now
      try {
        await syncReviewPRs(gitHubService, gitService, taskService, dismissedPrService, getSettings, getWindow)
      } catch (err) {
        console.error('[github:sync-prs] auto-sync error:', err)
      }
    }
  }, 60_000)

  // ダッシュボードの「常駐オーケストレータを立てる」ボタン
  const residentOrchestratorService = new ResidentOrchestratorService({
    taskService,
    getSettings,
    startTask: startTaskFn,
    notifyTasksUpdated: () => getWindow()?.webContents.send('tasks:updated'),
  })
  ipcMain.handle('residentOrchestrator:run-now', () => residentOrchestratorService.runNow())

  // Settings handlers
  ipcMain.handle('settings:get', async () => {
    return getSettings()
  })

  ipcMain.handle('settings:set', async (_, settings: Partial<AppSettings>) => {
    try {
      const current = getSettings()
      const merged = { ...current, ...settings }
      saveSettings(merged)
    } catch (error) {
      throw new Error(`Failed to save settings: ${(error as Error).message}`)
    }
  })

  // Shell handler
  ipcMain.handle('shell:open-external', async (_, url: string) => {
    await shell.openExternal(url)
  })

  // 画像ファイル一覧取得
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'])
  ipcMain.handle('shell:list-images', async (_, dir: string): Promise<string[]> => {
    try {
      return readdirSync(dir)
        .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
        .map((f) => join(dir, f))
    } catch {
      return []
    }
  })

  // ディレクトリ選択ダイアログ
  ipcMain.handle('dialog:open-directory', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 画像選択ダイアログ（複数選択可）
  ipcMain.handle('dialog:open-images', async (): Promise<string[] | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'] }]
    })
    return result.canceled ? null : result.filePaths
  })

  // 添付画像の取り込み・削除
  ipcMain.handle('images:import', async (_, sourcePaths: string[]): Promise<string[]> => {
    return importImages(sourcePaths)
  })

  ipcMain.handle('images:delete', async (_, paths: string[]): Promise<void> => {
    deleteImages(paths)
  })

  // 設定エクスポート
  ipcMain.handle('settings:export', async (): Promise<boolean> => {
    if (!mainWindow) return false
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'toride-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const settings = getSettings()
    const { githubPat: _omit, githubTokens: _omitTokens, ...exportSettings } = settings
    writeFileSync(result.filePath, JSON.stringify(exportSettings, null, 2), 'utf-8')
    return true
  })

  // 設定インポート
  ipcMain.handle('settings:import', async (): Promise<AppSettings | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const content = readFileSync(result.filePaths[0], 'utf-8')
    const imported = JSON.parse(content) as Partial<AppSettings>
    const current = getSettings()
    const merged = { ...current, ...imported }
    saveSettings(merged)
    return getSettings()
  })

  // Plugin handlers
  ipcMain.handle('plugin:catalog', async () => {
    return PLUGIN_CATALOG.map(({ factory: _factory, ...meta }) => meta)
  })

  ipcMain.handle('plugin:install', async (_, id: string) => {
    const item = PLUGIN_CATALOG.find((c) => c.id === id)
    if (!item) throw new Error(`Unknown plugin: ${id}`)
    if (!registry.listTicketPlugins().find((p) => p.id === id)) {
      registry.registerTicketPlugin(item.factory())
    }
    const current = getSettings()
    const enabled = [...new Set([...(current.enabledPlugins ?? []), id])]
    saveSettings({ ...current, enabledPlugins: enabled })
  })

  ipcMain.handle('plugin:uninstall', async (_, id: string) => {
    registry.unregisterTicketPlugin(id)
    const current = getSettings()
    const enabled = (current.enabledPlugins ?? []).filter((p) => p !== id)
    saveSettings({ ...current, enabledPlugins: enabled })
  })

  // bg:// プロトコル → ローカル画像ファイルを直接読んで返す
  const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
  }
  protocol.handle('bg', (request) => {
    try {
      const filePath = new URL(request.url).searchParams.get('path') ?? ''
      const data = readFileSync(filePath)
      const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, { headers: { 'Content-Type': contentType } })
    } catch (e) {
      console.error('[bg] error:', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  createWindow()

  powerMonitor.on('resume', () => {
    mainWindow?.webContents.send('system:resume')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  if (prSyncTimerId) clearInterval(prSyncTimerId)
  devServerServiceInstance?.stopAll()
  terminalServiceInstance?.killAll()
  localHttpServerInstance?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
