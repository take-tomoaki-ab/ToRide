# ToRide

Claude Code の並列開発を管理するElectronデスクトップダッシュボード。

---

## 開発ルール

- **作業完了後は必ずコミットする**: ファイルを変更・追加したら、作業の最後に `git add` + `git commit` を実行する。コミットメッセージは変更内容を端的に表す日本語または英語で記述する。
- **バグ修正・機能追加・改善の実装依頼を受けたときは、必ず `/implement` のワークフローに従う**: mainからブランチを切る → 不明点を質問する → 実装してコミット → 動作確認を依頼する → OKをもらったらPRを作成する、の順で進める。

---

## 技術スタック

| 用途 | 技術 |
|---|---|
| デスクトップシェル | Electron 28 + electron-vite |
| UI | React 18 + TypeScript |
| スタイリング | Tailwind CSS |
| 状態管理 | Zustand |
| ローカルDB | better-sqlite3 (SQLite) |
| ターミナル | node-pty + @xterm/xterm |
| Git操作 | simple-git |
| ルーティング | react-router-dom v6 |

---

## ディレクトリ構造

```
electron/
  main/
    index.ts              # Electronエントリ・bg://プロトコル・settings/shell/dialog IPC
    db/schema.ts          # DB初期化・マイグレーション
    services/
      TaskService.ts      # タスクCRUD・アーカイブ
      TerminalService.ts  # node-pty管理 (Map<taskId, IPty>)
      GitService.ts       # simple-git ラッパー
      ClaudeService.ts    # claude起動・コンテキスト解析・通知
      DevServerService.ts # 開発サーバーspawn管理
      GitHubService.ts    # GitHub API（レビュー依頼PR取得）
      LocalHttpServer.ts  # 共有HTTPサーバー（addRoute()で複数エンドポイント登録）
      StopHookService.ts  # Stop Hook管理・/task-doneエンドポイント
      ContextLineService.ts # Status Line Hook管理・/context-updateエンドポイント
      SessionRotationService.ts # セッションローテーション（閾値検知・handoff完了検知・再起動）
      McpServerService.ts # MCPサーバー（タスクCRUD・タスク起動・開発サーバー制御ツールを公開）
      NotificationService.ts # デスクトップ通知の発行と通知履歴の保存
      ModelListService.ts # /v1/models からのモデル一覧取得
      SlashCommandService.ts # スラッシュコマンド・スキルの列挙（補完候補）
      McpHookService.ts   # ~/.claude/settings.json のmcpServers自動管理
      ResidentOrchestratorService.ts # 常駐オーケストレータの起票・起動
    plugins/
      PluginRegistry.ts   # プラグインレジストリ
      catalog.ts          # プラグイン一覧（Wrike・GitHub Issue）
      ticket/             # チケットプラグイン（WrikeTicketPlugin・GitHubIssueTicketPlugin）
    ipc/
      tasks.ts / terminal.ts / git.ts / claude.ts / devServer.ts / github.ts / notifications.ts
    utils/path.ts         # パスユーティリティ
  preload/index.ts        # contextBridge でwindow.api公開
src/
  types/
    task.ts               # Task, RuntimeTask, ArchiveEntry 型
    ipc.ts                # AppSettings, WindowApi, IpcChannels 型
    window.d.ts           # window.api の型宣言
  stores/
    taskStore.ts          # Zustand (tasks, filteredTasks, CRUD actions)
    terminalStore.ts      # Zustand (isOpen, activeTaskId)
  components/
    BackgroundSlideshow/  # 背景スライドショー（bg://プロトコル使用）
    BranchStatus/         # ブランチ状態表示（5秒ポーリング）
    Common/               # ConfirmDialog, ConflictWarningModal, BranchCombobox
    ContextMeter/         # コンテキスト使用量プログレスバー
    FilterBar/            # 検索・タイプフィルタ・新規タスクボタン
    NotificationBell/     # 通知履歴のベルアイコン・一覧パネル
    PaneStatusSidebar/    # ペイン状態・開発サーバー起動停止
    TaskCard/             # タスクカード (PRStatusBadge含む)
    TaskForm/             # タスク作成・編集モーダル
    Terminal/             # xterm.jsターミナルパネル
  pages/
    DashboardPage.tsx     # 3カラムKanbanボード
    ArchivePage.tsx       # アーカイブ一覧
    SettingsPage.tsx      # 設定画面
  App.tsx / main.tsx
```

---

## 実装済み機能

### タスク管理

- **7タイプのタスク作成・編集**
  - `feat`: タイトル / リポジトリ / ブランチ* / 分岐元ブランチ / Wrikeチケット* / プロンプト*
  - `design`: タイトル / リポジトリ / 出力パス* / プロンプト
  - `review`: タイトル / リポジトリ / PR URL* / プロンプト
  - `bugfix`: タイトル / リポジトリ / ブランチ* / 分岐元ブランチ / Wrikeチケット* / プロンプト
  - `research`: タイトル / リポジトリ / ブランチ* / プロンプト*
  - `chore`: タイトル / ディレクトリ* / プロンプト（repoId不要）
  - `orchestrate`: タイトル / ディレクトリ（省略可） / プロンプト（repoId不要・ペイン非占有のコーディネーター役）
- **ブランチオートコンプリート**: ブランチ入力を Combobox に変更、既存ブランチをプレフィックス一致順に候補表示
- **チケットプラグイン**: Wrike（デフォルト）と GitHub Issue をサポート（PluginRegistry架）
- **PR URLから自動入力**: タスクフォームのURL自動入力欄にGitHub PR URLを渡すと、`review` タスクとしてタイプ・タイトル（`[repo] #番号 PRタイトル`）・PR URL・prStatus を自動設定し、gitリモートと突き合わせて `repoId` も自動選択（プラグイン設定不要で常に有効）
- **プロンプト変数チップ**: タスクフォームの変数チップをクリックするとカーソル位置に挿入
- **スラッシュコマンド補完**: プロンプト入力欄の**先頭**で `/` を打つとコマンド・スキルの候補を表示（↑↓で移動 / Enter・Tab で確定 / Esc で閉じる）
  - 収集元: ユーザー（`~/.claude/commands`・`skills`）/ プロジェクト（`<workdir>/.claude/...`）/ プラグイン（`installed_plugins.json` の installPath 配下）
  - 対象欄: タスクフォームの Prompt・ミッション説明、設定画面の promptTemplates・orchestrateSystemPrompt・bootPrompt
- **フォルダ選択**: choreタスクのDirectory入力にフォルダ選択ダイアログボタン
- **編集**: タイプ以外の全フィールドを編集可能
- **削除**: タスクの完全削除
- **アーカイブ**: 完了タスクをアーカイブへ移動
- **3カラムKanban**: `will_do` / `doing` / `done`
- **依存タスク**: 依存先が未完了なら開始をブロック（ホバーでツールチップ）
- **完了タイムスタンプ**: doneタスクに完了日時を表示
- **即時完了ボタン**: will_doカードでも「完了」ボタンで実行なしに完了へ移行可能

### タスク実行・ターミナル

- **タスク開始**:
  - タスクの `repoId` に対応するリポジトリ内の空きペインを自動割り当て
  - 対象ブランチへの自動チェックアウト（feat / bugfix / research）
  - Claude Code の自動起動（TUI起動検知後にプロンプト注入・自動送信）
  - モデル選択プルダウン（起動モードとは独立）で実行モデルを指定可能
  - 依存タスク未完了・対象リポジトリに空きペインなしの場合はボタン無効化
- **orchestrateタスク**: 複数タスクを統括するコーディネーター役として起動
  - ペインを占有しない（workdirはリポジトリの先頭ペインのパスを借用、なければhomedir）
  - 起動時にシステムプロンプト（`orchestrateSystemPrompt` 設定、デフォルトあり）+ メモリディレクトリ + ミッション説明を結合して注入
  - プロンプトはテンプレート変数展開の対象外
- **ペイン競合検出**: 同一ペインに実行中タスクがあれば警告モーダル（強制起動も可）
- **タスク完了時のセッション終了**: status が `done` になったら Claude セッションを終了する
  - 完了ボタン / 通知の「承認して完了」/ MCP の `update_task` / 実行中タスクの削除・アーカイブ、いずれの経路でも終了する
  - claude だけでなく PTY 配下の子孫プロセス（バックグラウンドジョブ等）もまとめて停止する
- **再起動時自動リセット**: 起動時にdoingタスクをwill_doに戻し、task_runtimeをクリア
- **セッション再開**: 完了タスクカードの「再開」ボタンで `claude --resume <uuid>` による前セッション継続
  - タスク起動時にUUIDを生成し `--session-id` フラグでClaudeに渡して保存
  - 別ペインでも再開可能（Claudeセッションはグローバル保存）
- **インタラクティブターミナル**: 右スライドパネル（幅はドラッグで変更可能）
  - xterm.jsによる個別PTYセッション
  - パネルを閉じてもPTYプロセスは維持（バックグラウンド継続）
  - ResizeObserverによる自動リサイズ追従
  - スリープ復帰・ウィンドウフォーカス時に自動再描画

### Claude Code 連携

- **起動モード切り替え**（`normal` / `auto` / `bypass` / `plan`）:
  - 通常: `claude`
  - 自動許可モード: `claude --permission-mode auto`（設定 `useAutoMode` で有効化）
  - 危険モード: `claude --dangerously-skip-permissions`（設定 `useDangerouslySkipPermissions` で有効化）
  - researchタスクはデフォルトで `plan` モード起動
  - 起動ボタンのドロップダウンからタスクごとに上書き可能
- **モデル選択**: 起動モードとは独立したプルダウンで実行モデルを指定（`--model` フラグ）
  - モデル一覧は `/v1/models` から動的取得、失敗時は opus/sonnet/haiku にフォールバック（ModelListService）
- **プロンプト注入**: タスク固有prompt → 設定テンプレート の優先順で適用。TUI起動検知後に注入して自動送信
- **プロンプトテンプレート変数**: `{title}` は全タイプ共通、各タイプ固有変数あり
  - feat: `{branch}` `{ticket}` `{prompt}`
  - design: `{output}`
  - review: `{pr-url}`
  - bugfix: `{branch}` `{ticket}`
  - research: `{branch}` `{prompt}`
  - chore: `{directory}`
- **Stop Hook**: `~/.claude/hooks/stop.sh` でタスク完了を検知・HTTP通知（設定画面からインストール）
- **Status Line Hook**: `~/.claude/statusline.sh` で各APIレスポンス後にコンテキスト使用量をリアルタイム更新（設定画面からインストール）
- **MCP サーバー**: `create_task` / `list_tasks` / `list_repos` / `update_task` / `delete_task` / `dismiss_pr` / `start_task` / `list_dev_servers` / `start_dev_server` / `stop_dev_server` / `get_dev_server_log` / `notify_user` / `get_rotation_status` ツールを公開（設定画面からインストール、`~/.claude/settings.json` に自動登録）
  - `start_task` は `launchMode` パラメータで起動モードを指定可能
  - `update_task` は `title` / `status` / `prompt` / `depends_on` / `rotation` を部分更新できる
  - `create_task` / `list_tasks` / `update_task` / `start_task` のレスポンスは要約のみ（`summarizeTask()`）。`list_tasks` は `id` で1件に絞れ、プロンプト本文は `include_prompt: true` のときだけ含まれる
  - `list_dev_servers` は workdir・実行中タスク情報に加えて直近の終了情報（`lastExitCode` / `lastExitSignal` / `lastExitedAt` / `lastExitReason` / `lastExitMessage`）を含めて返却
  - `get_dev_server_log` は開発サーバーの stdout/stderr を返す（既定は末尾100行・最大1000行、`grep` で行フィルタ可）。停止後もログは残るため異常終了の原因調査に使える
  - `notify_user` はタスク内のClaudeセッションが任意のタイミングでデスクトップ通知を送るツール（`message` 必須 / `level`: info・question・warning / `title` / `taskTitle` / `taskId`）。`taskTitle` からタスクを逆引きし、通知クリックで該当タスクへジャンプする
  - `get_rotation_status` はセッションローテーションの状態（使用率・閾値・回数・履歴・保留/停止）を返す。`update_task` の `rotation` で設定を変更できる
  - `dismiss_pr` はレビュー依頼PRの dismiss（PR自動同期の対象外にしてタスクを削除）。`id`（reviewタスクID）か `url`（PR URL）のどちらか一方を指定する。`url` 指定はタスクが無いPRにも先回りで使える

### Git 連携

- **ブランチ状態表示**（5秒ポーリング）: ブランチ名 / ahead(↑緑) / behind(↓赤) / 未コミット変更数(黄)
- **自動ブランチチェックアウト**: タスク開始時に指定ブランチを作成/切り替え
- **PRステータスバッジ**: review タスクで `open` / `merged` / `closed` をリアルタイム表示
- **PR URL自動検出**: Status Line Hookペイロード経由でセッション中に作成されたGitHub PR URLを検出し、実行中タスクに自動紐付け（reviewタスクは対象外）。PRボタンは `PR#番号` 形式で表示
- **外部リンク**: WrikeチケットおよびGitHub PRをブラウザで開く

### コンテキストウィンドウ管理

- **トークン使用量表示**: `75,234 / 200,000 tokens` 形式
- **プログレスバー**: 緑(0〜80%) / 黄(80〜90%) / 赤(90%〜)
- **デスクトップ通知**: 80%到達時 / 90%到達時 / タスク完了時（通知クリックで関連画面へジャンプ）
- **リアルタイム更新**: Status Line Hook 経由で各APIレスポンス後に即時反映（stdout パースはフォールバック）
  - used_percentageベースで計算、セッション最大値を追跡して逆行防止

### 通知センター

デスクトップ通知は出た瞬間を逃すと二度と見られないため、FilterBar のベルアイコンから履歴を追えるようにしている。

- **一覧**: ベルをクリックするとパネルを開き、新しい順に表示（カテゴリ・レベル・相対時刻つき）。未読はバッジで件数を表示
- **既読**: 項目ごとの「既読」ボタンと「すべて既読」ボタン。項目本体をクリックすると既読にしたうえで通知クリックと同じ遷移をする
- **記録対象**: `context`（80%/90%警告）/ `rotation`（保留・停止・中止）/ `devserver`（異常終了）/ `mcp`（`notify_user`）
- **記録しないもの**: Stop Hook 由来のタスク完了通知、GitHub PR同期・トークンエラー、手動完了時の完了通知
- **通知OFF時**: `notificationsEnabled = false` でもデスクトップ通知を出さないだけで履歴には残る
- **保持**: SQLite の `notifications` テーブルに最大200件。超えた分は古い側から削除

### セッションローテーション

auto-compact は「圧縮結果がまた履歴に積まれて底が上がる」ため、**compact ではなくセッションを作り直して引き継ぐ**方式。長時間走るタスク（常駐オーケストレータ・長い実タスク）向けの opt-in 機能。

- **閾値検知**: コンテキスト使用率が `threshold`（既定60%）に到達したら開始
- **handoff 指示**: 引き継ぎファイルを書かせる指示をPTYに送信。指示文には「ローテーション」という語を使わず、*終了する / 会話履歴は渡らない / このファイルだけが渡る*を平文で明示する
- **`\r` の送信条件**: 本文を write → 200ms → **入力欄にエコーされたか検証** してから Enter を送る。エコーがなければ Enter を送らず保留。`AskUserQuestion` / `ExitPlanMode` などの対話プロンプトを誤承認しないための必須要件
- **完了検知（AND条件）**: Stop Hook 発火 ∧ handoffファイル存在 ∧ mtime > 指示送信時刻。**3条件が揃うまで絶対に kill しない**
- **タイムアウト**: 600秒。**旧セッションは kill せず**通知のみ出して保留。タスクカードから手動ローテーションを実行できる
- **新セッション起動**: `--resume` ではなく新しい sessionId を採番。`git checkout` はスキップし、bootPrompt を通常の起動プロンプトの**末尾に追加**（置換ではない）
- **ガード（症状側）**: 起動から10分未満はローテーションしない / 直近1時間に3回を超えたら自動停止
- **ガード（原因側）**: 新セッションの最初のターン終了時点の使用率を `baseline` として記録し、`threshold * 0.8` を超えたら自動停止（handoff肥大の検知）。handoffが8KB超なら警告
- **通知**: rotation有効タスクでは80%/90%通知を抑制。ただし**保留・停止・中止の通知は必ず出す**（無音が「正常」を意味するのを防ぐため）
- **履歴**: `rotation.history` に回数・時刻・理由を記録。`{rotationCount}` として bootPrompt に展開

### 常駐オーケストレータ（residentOrchestrator）

ダッシュボードの「常駐オーケストレータを立てる」ボタンで orchestrate タスクを1本起票して起動する（`ResidentOrchestratorService`）。

- **発火は人がボタンを押したときだけ**。時刻での自動起票は持たない（平日判定をコードに持たせると祝日と有給で崩れるため、押す人に任せる）
- **冪等性は既存タスクチェックのみ**: `repoId` 一致の orchestrate が `will_do` / `doing` にあれば起票せず `skipped` を返す。`done` は見ないので、完了させてからもう一度押せばまた立つ
- **重複チェックのスコープを `repoId` 一致に限る**理由: 全 orchestrate を見ると、別リポジトリのオーケストレータが走っている間ずっと立てられなくなる
- **設定画面に出すのは `repoId` / `title` / `prompt`**。`rotation` / `autoStart` は毎回変える値ではないので AppSettings 側だけに置く。ボタンの隣にも「どこに立つか」を1行出す
- **`repoId` はフォールバックせずエラーにする**: 未設定・設定に無いIDのときは先頭のリポジトリや homedir に落とさない。意図しないリポジトリに立つと消す手間がかかるうえ、既定でそのまま起動まで進んでしまう。ボタン自体も disabled にして押す前に気づけるようにする
- **rotation はタスク単位で載せる**: `rotationDefaults` はグローバル既定値なので、そこに書くと他リポジトリで走っている orchestrate にも効いてしまう。`rotation.bootPrompt` 省略時は `residentOrchestrator.prompt` を流用する
- **ローテーションは常に有効**: 起票時に `rotation.enabled: true` を必ず載せる（設定の `rotation` が無い場合も、`enabled: false` が書かれている場合も上書きする）。長時間走る前提のタスクなので設定任せにはしない。rotation 有効時は 80/90% 通知が抑制されるため、設定漏れで無効のままだと「無音でコンテキストが埋まる」＝気づく手がかりが何も残らない状態になる
- **`handoffPath` の解決**: `residentOrchestrator.rotation.handoffPath` → `rotationDefaults.handoffPath` → `~/.toride/handoff/orchestrator.md`（アプリ既定）。`rotationDefaults` に値があるときは起票時に**焼き込まず** `undefined` を載せて `SessionRotationService.resolveConfig` に引かせる（焼き込むと設定画面で変えても起票済みタスクに効かない）。どちらも空のときだけ既定パスを埋め、親ディレクトリを `mkdirSync` する。`handoffPath` が空だと `onContextUpdate` が無音で return するため、ここを空にしない責任は起票側が持つ
- **ログ**: `[residentOrchestrator] created / skipped / start-failed`。見送りは正常系なので `console.log`。結果は押した人の画面にトーストで返るので、デスクトップ通知は出さない

### ペイン・開発サーバー・複数リポジトリ

- **ペインステータスサイドバー（左192px）**: リポジトリ名ヘッダーつきグループ表示 / ペインID / パス / 占有状況
- **開発サーバー制御**: ペインごとに複数サーバーを起動/停止
  - ●実行中（緑）/ ○停止中（灰）のステータス表示
  - ターミナルパネルでリアルタイムログ閲覧（1秒ポーリング）
  - 設定画面でドラッグ＆ドロップ並べ替え（青線インジケータで挿入位置表示）
  - 異常終了時にデスクトップ通知
- **複数リポジトリ対応**:
  - 設定は `repos: RepoConfig[]` の階層構造（リポジトリ > ペイン）
  - タスク開始時はタスクの `repoId` が指すリポジトリ内のペインにのみ割り当て
  - 旧 `panes` 形式は起動時に `repos[0]（id:repo1, name:default）` として自動マイグレーション
  - `chore` タスクは `repoId` 不要（`directory` を workdir として使用）

### 検索・フィルタ

- **全文検索**: タイトル / ブランチ / チケット / URL / PR URL（PR番号含む）を横断検索
- **検索クリアボタン**: 検索ボックスの×ボタンでキーワードを一括クリア
- **タイプフィルタ**: チェックボックスで絞り込み
- **カラム件数表示**: 各ステータスのタスク数を表示

### アーカイブ

- **一括アーカイブ**: doneカラムのタスクをまとめてアーカイブ（フィルタ適用中は表示中のタスクのみ対象）
- アーカイブページ（`/archive`）で過去のタスクを時系列表示
- 展開してタイプ・ブランチ・チケット・プロンプト・日時を確認
- 確認ダイアログ付きで個別削除

### GitHub PR 自動同期

- **レビュー依頼PR自動取得**: GitHub API (`review-requested:<username>`) でオープンなレビュー依頼PRを取得
- **タスク自動作成**: 既存タスク・アーカイブに存在しないPRを `review` タスクとして自動登録
- **重複防止**: `url` フィールドで既存・アーカイブ済みを突き合わせて重複を排除
- **repoId自動解決**: PRのリポジトリをgitリモートURLと突き合わせて対応する `repoId` をマッピング
- **自動同期タイマー**: アプリ起動中1分ごとにチェック、設定間隔（デフォルト5分）で同期実行
- **手動同期**: 設定画面の「今すぐ同期」ボタンでオンデマンド実行
- **デスクトップ通知**: 新規タスク作成時に件数を通知
- **マルチトークン検索**: 登録トークンごとに `review-requested` 検索を実行し、PRのURLで結果をマージ（fine-grained token はアクセス可能リポジトリしか検索できないため）
- **認証エラー通知**: 401 / 403（権限不足）を握り潰さず集約してデスクトップ通知。失敗スコープの面子が変わるまで再通知しない（403 はレート制限と区別）

### GitHub トークン管理（fine-grained PAT 対応）

- **owner / owner/repo 単位で複数トークンを登録**: `githubTokens: GitHubTokenEntry[]`
- **解決順序**: `owner/repo` → `owner` → 共通フォールバック `githubPat`
- **疎通確認**: 設定画面の「疎通確認」ボタンで `GET /user`（有効期限取得）＋スコープ対象への実アクセスまで確認
  - `owner/repo` スコープ: `GET /repos/{owner}/{repo}` を直接叩く
  - `owner` スコープ: `GET /user/repos` を列挙して owner 配下のアクセス可能リポジトリを確認（最大3ページで打ち切り）
- **有効期限表示**: `github-authentication-token-expiration` ヘッダから取得し、残7日以内は黄・期限切れは赤で表示
- **未登録owner警告**: 設定済みリポジトリのgitリモートから owner を集め、トークン未登録の owner を設定画面に表示

### 背景画像スライドショー

- 指定ディレクトリ内の画像（jpg/jpeg/png/gif/webp/avif/bmp）をランダムにクロスフェード表示
- `bg://local?path=...` カスタムElectronプロトコルでローカル画像を安全に配信
- 切替間隔（秒）を設定画面で変更可能（デフォルト30秒）
- 設定画面のフォルダ選択ダイアログで画像ディレクトリを選択

---

## 設定項目（AppSettings）

| フィールド | 説明 |
|---|---|
| `repos` | RepoConfig[] - リポジトリ単位でペインをグループ管理（id / name / panes[]） |
| `githubPat` | GitHub PAT（全owner共通のフォールバック・safeStorageで暗号化保存） |
| `githubTokens` | GitHubTokenEntry[] - owner / owner/repo 単位のfine-grained token（scope / token / expiresAt / lastCheck。tokenはsafeStorageで暗号化保存） |
| `githubUsername` | GitHubユーザー名（PR自動同期用） |
| `githubPrSyncIntervalMin` | PR自動同期間隔（分、デフォルト5） |
| `useDangerouslySkipPermissions` | claude起動時に`--dangerously-skip-permissions`を付加 |
| `useAutoMode` | claude起動時に`--permission-mode auto`を付加 |
| `promptTemplates` | タスクタイプ別プロンプトテンプレート |
| `orchestrateSystemPrompt` | orchestrateタスク起動時に先頭に付与するシステムプロンプト（未設定時はデフォルト） |
| `rotationDefaults` | セッションローテーションのグローバル既定値（enabled / threshold / handoffPath / bootPrompt）。タスク側が未指定のキーだけフォールバック |
| `rotationHandoffInstruction` | handoffを書かせる指示文のテンプレート（変数: `{used}` `{handoffPath}`） |
| `residentOrchestrator` | 常駐オーケストレータの内容（repoId / title / prompt は設定画面にUIあり。autoStart / rotation は設定のみ。title・prompt・rotation.bootPromptで `{date}` を展開）。`rotation.enabled` は無視され常に true |
| `notificationsEnabled` | デスクトップ通知の有効/無効（デフォルトtrue） |
| `stopHookPort` | ローカルHTTPサーバーのポート（デフォルト39457） |
| `pluginSettings` | チケットプラグイン設定（暗号化フィールドはsafeStorage管理） |
| `enabledPlugins` | 有効なプラグインIDの一覧 |
| `extraPaths` | 子プロセス（git hooks等）に追加するPATHエントリ |
| `backgroundImageDir` | 背景スライドショー画像ディレクトリ |
| `backgroundIntervalSec` | スライドショー切替間隔（秒） |

設定画面からインストール可能なフック・サービス：

| 項目 | ファイル | 説明 |
|---|---|---|
| Stop Hook | `~/.claude/hooks/stop.sh` | タスク完了時にHTTP通知を送信 |
| Status Line Hook | `~/.claude/statusline.sh` | 各APIレスポンス後にコンテキスト使用量を更新 |
| MCP Server | `~/.claude/settings.json` の `mcpServers` | Claude Codeからタスク操作を可能にする |

---

## 重要な設計決定

- **pane競合**: 同一paneのdoingタスク存在時はIPCエラーコード `PANE_CONFLICT` を返却
- **リポジトリ別ペイン割り当て**: タスクの `repoId` に対応するリポジトリ内の空きペインのみ使用（`NO_REPO_ASSIGNED` / `NO_FREE_PANE` エラーコードあり）
- **設定マイグレーション**: 旧 `panes` フラットリストは `getSettings()` 内で `repos[{id:'repo1',name:'default',panes:[...]}]` に自動変換
- **repoId の保存**: `BaseTask.repoId` はタスクの `data` JSON カラムに保存（専用DBカラムなし）
- **worktree対応**: 同一リポジトリの複数ワークツリーを別paneにマッピング可能（`git checkout` でブランチ切り替え）
- **DBファイル**: `app.getPath('userData')` に保存
- **GitHub PAT**: `safeStorage.encryptString` で暗号化してDB保存。`githubTokens[].token` も同様（復号失敗時は空にして再入力を促す）
- **GitHubトークンの解決**: `utils/githubToken.ts` の `resolveGitHubToken(settings, owner, repo)` に集約。`owner/repo` → `owner` → `githubPat` の順に引く
- **チケットプラグインへのトークン受け渡し**: URLの owner/repo に対応するトークンのみ `pluginSettings.githubPat` に注入（GitHub以外のURLでは渡さない）
- **PR URL自動入力のトークン**: `ticket:fetch` の PR URL 経路も `resolveGitHubTokenForUrl()` で解決（未登録ownerは未認証で取得を試み、privateなら404案内）
- **リポジトリ名の解決**: `utils/repoMap.ts` の `listRepoFullNames()` が基点。`buildRepoFullNameMap()`（repoId解決）と `github:repo-owners`（owner一覧）が共用する
- **設定エクスポート**: `githubPat` / `githubTokens` は除外
- **PTY管理**: `Map<taskId, IPty>` でセッションをライフサイクル全体で維持
- **セッション終了は子孫プロセスまで**: `pty.kill()` はログインシェルにしかシグナルが届かず、claude が起動したバックグラウンドジョブが生き残って完了後も通知を出してくる。`TerminalService.kill()` は kill 前に `ps -eo pid=,ppid=` で子孫PIDを洗い出し（親を先に殺すと reparent されて辿れなくなる）、SIGTERM → 3秒後に生存分へ SIGKILL する。アプリ終了時の `killAll()` は setTimeout が発火しないので猶予なしの SIGKILL
- **完了時のセッション終了フックは `TaskService` に集約**: done にする経路が UI / 通知 / MCP と複数あるため、`TaskService.onStatusChange` / `onDeleted` を index.ts で1本だけ購読して `stopHook.removeTaskCallback` → `rotation.clear` → `resetContextTracking` → `terminal.kill` を実行する。各呼び出し元に散らすと必ず取りこぼす
- **コンテキスト解析**: Status Line Hook 経由が主系、stdout/stderrパースはフォールバック。`used_percentage` ベースで計算し、セッション最大値を追跡して逆行防止
- **bg://プロトコル**: `protocol.registerSchemesAsPrivileged` で`app.whenReady`より前に登録必要
- **再起動時クリーンアップ**: 起動直後にdoing→will_do変換 + task_runtimeテーブル全削除
- **LocalHttpServer**: Stop Hook・Status Line Hook・MCP SSEを共有する単一HTTPサーバー（`addRoute()` / `addRawRoute()` でエンドポイント追加）
- **ポートファイルの削除条件**: `~/.toride/port` はインスタンス間で共有される1本しかないため、`LocalHttpServer.stop()` は中身が自分のポートと一致するときだけ削除する。無条件に消すと、別プロファイルで並走させた2号機を閉じただけで稼働中インスタンスの `stop.sh` / `statusline.sh` が参照先を失い、通知とコンテキスト更新が黙って止まる
- **MCPトランスポート**: SSEトランスポートを使用。ポートは `~/.toride/port` と同一のLocalHttpServer上で動作
- **セッションID**: タスク起動時にUUIDを生成し `--session-id` でClaudeに渡す。`claude --resume <uuid>` で完了後も再開可能
- **pane占有判定**: 同一リポジトリ内のみに限定（別リポジトリの同名paneは除外）
- **resume時のworkdir**: `claude --resume` はcwdでセッションを検索するため、元のpaneのworkdirを使用
- **orchestrateのpane非占有**: orchestrateタスクは `pane` を空文字にして起動し、ペイン占有判定の対象外（workdirはリポジトリ先頭ペインのパスを借用）
- **プロンプト注入タイミング**: 固定遅延ではなくTUI起動検知ベースで注入し自動送信
- **PR URL検出**: ターミナル出力スキャンではなくStatus Line Hookのペイロードから検出
- **開発サーバーの終了情報**: `DevServerService` が `lastExits: Map<key, DevServerExitInfo>` で直近の終了（code / signal / 時刻 / manual・abnormal / spawn失敗メッセージ）を保持し、`status()` に載せて返す。`start()` 時にクリアするので「今の起動で落ちたか」だけが残る
- **開発サーバーログの保持上限**: `DevServerService` はログを約200万文字（`String.length` 基準＝UTF-16コードユニット数。日本語ログでは実メモリはこれより大きい）まで保持し、超えたら約150万文字まで古い側を行頭で切り落として `[... 古いログは省略されました ...]` を先頭に置く。毎チャンク切り詰めると保持分まるごとのコピーが走るため、切り落とし先を別に設けて頻度を落としている
- **MCPのタスクレスポンスは要約に固定**: `RuntimeTask` をそのまま返すと `prompt` 全文・`images`・`rotation.history`（ローテーションのたびに積まれる）・`sessionId` が毎回乗り、status を1つ変えるだけの `update_task` でもコンテキストを大きく食う。`summarizeTask()` で「どのタスクか」と「今どうなっているか」に要るフィールドだけに絞り、`contextUsed`/`contextLimit` は `contextPercent` 1つに畳み、`JSON.stringify` のインデントも付けない。`list_tasks` からプロンプト本文を落とした代わりに `id` 絞り込みと `include_prompt` を用意して、必要なときだけ1件分取れるようにしている
- **開発サーバーログの返却量**: MCPレスポンスがコンテキストを食い潰さないよう `get_dev_server_log` は既定100行・最大1000行に切り詰める。`grep` は先に行フィルタしてから末尾N行を取る
- **dismiss は `dismissReviewPr()` に集約**: UI（`github:dismiss-pr` IPC）と MCP（`dismiss_pr`）の両方から呼ぶため、`DismissedPrService.ts` の関数1本にまとめている。URLは `normalizePrUrl()` で `html_url` と同じ形（`/files` や `#discussion_r...` を落とす）に正規化してから登録する。正規化しないと同期側の `dismissedUrls.has(pr.html_url)` に一致せずタスクが再作成され、close/merge 判定のAPI呼び出しも失敗してレコードが永久に残る。同じPRを指す review タスクは複数あってもまとめて削除する
- **notify_userのタスク解決**: セッションが自分のタスクIDを知らなくても通知できるよう、`taskTitle` からdoingタスク優先で完全一致→部分一致で逆引きする。解決できなければ通知は出しクリック時はウィンドウフォーカスのみ
- **モデル一覧**: `/v1/models` から動的取得し、失敗時は opus/sonnet/haiku にフォールバック（ModelListService）
- **スラッシュコマンド候補のスキャン**: `~/.claude/skills` はシンボリックリンクで貼られることが多く `Dirent.isDirectory()` が false になるため、リンクは `stat` で辿り直す。frontmatter の `description` はブロックスカラー（`|` / `>`）もあるので最初の段落だけ取り出す。SKILL.md は大きいので先頭4KBのみ読む
- **候補の同名解決**: プロジェクト > ユーザー > プラグインの優先で先勝ち。プラグインは `pluginName:` を名前空間に付け、project スコープのものは workdir がその配下のときだけ含める
- **ローテーション後のコンテキスト追跡リセット**: `ClaudeService.fireContextUpdate` は単調増加ゲート（`used <= prevMax` を捨てる）を持つため、新セッションの小さい値が全て捨てられる。`resetContextTracking()` を呼ばないと閾値判定が二度と発火しない
- **StopHookのコールバックは `Map<taskId, Set<cb>>`**: 1タスクに複数の購読者（タスク完了通知 / ローテーションのidle・handoff検知）がいるため。起動のたびに `removeTaskCallback` してから登録し直す（Set化で積み上がるのを防ぐ）
- **エコー検証の照合対象**: 日本語本文ではなく `handoffPath`（ASCII）の末尾。CJKはTUI上で全角幅として描画され折り返し計算が半角と異なるため。照合前に空白・改行を全除去して正規化する。指示文の最終行を `{handoffPath}` で終わらせているのはこのため
- **ローテーションのバッファ**: `ClaudeService.cleanBuffers` は `resetContextTracking()` でクリアされるため流用せず、`SessionRotationService` が `terminalService.onData` に自前リスナを持つ
- **rotation設定の保存先**: `BaseTask.rotation` は `data` JSON カラム。ランタイム状態（保留・baseline等）は `task_runtime.rotation_state` にJSONで保存（再起動でクリア）
- **residentOrchestrator は永続状態を持たない**: 人がボタンを押したときだけ動くので、日付スタンプでの打ち切りは不要（判断はタスク一覧だけで完結する）
- **通知履歴は Stop Hook 由来を積まない**: タスク完了は必ずタスクカードに残るので履歴に入れると同じ情報が二重になる。一覧に残すのは「見逃すと困る通知」（コンテキスト警告・ローテーションの異常・Devサーバー異常終了・MCPからの呼びかけ）に絞る
- **通知の発行は `NotificationService.notify()` に集約**: 履歴の記録とデスクトップ通知の生成を1か所にまとめ、クリック時の遷移先（`NavigationPayload`）も同じレコードから復元する。`ClaudeService` / `SessionRotationService` には service ではなく `notify` 関数だけ渡して、DBへの依存を持ち込まない
- **通知クリック時の遷移は `src/utils/navigateToTarget.ts` に共通化**: デスクトップ通知（main → `navigation:goto`）と通知一覧パネルの両方から同じ挙動を再現する必要があるため、App.tsx のハンドラから切り出した
- **`task_runtime` の upsert**: 起動時に `DELETE FROM task_runtime` するため既存タスクの行が消える。`TaskService.update()` は runtime 更新前に `INSERT OR IGNORE` で行を作る（無いと pid / contextUsed 等の UPDATE が全て空振りする）
