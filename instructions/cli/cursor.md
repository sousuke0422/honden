# Cursor Agent CLI — 固有の操作ルール

これは Cursor Agent CLI 環境でのみ適用される操作ルール。
`honden brief --role <役> --cli cursor` が、役の指示書・共通の部品と共にこの節を組み上げる。
正本は SQLite 一つ（`~/.honden/honden.db`）である。`queue/*.yaml` も `dashboard.md` も無い。

## 概要

- 布陣の cursor は `cursor-agent --yolo`（Auto-run）で立つゆえ、ツール実行に追加の承認は不要
- 承認が無い代わりに、禁じ手の門は `.cursor/hooks.json` の `beforeShellExecution` が持つ。
  `failClosed: true` ゆえ、門が答えられぬ時は**通さぬ**。判定は `honden guard hook cursor` に
  集約されており、皮（`.cursor/hooks/guard-shell.sh`）は薄い
- 門に止められた時、直訴の余地があるものなら
  `honden guard appeal --cmd '<コマンド>' --reason '<理由>'` で将軍へ直訴し、
  下りた手形を `HONDEN_OTP=<札>` としてコマンドの頭に付けて使う。
  絶対域は手形でも通らぬ。叩く前に検めたければ `honden guard check --cmd '<コマンド>'`
- 名乗りは pane の `@agent_id` から引く。pane 番号（`honden-agents:agents.N`）で己を数えるな
- エージェント間通信は `honden inbox write` で行う。tmux を直接操作することは禁止

## セッションリセット

```
/new-chat
```

cursor に `/clear` は無い。文脈を消す命令は `/new-chat` である
（`honden nudge` の第三段が撃つのもこれ）。

## 終了

```
/quit
```

`/exit` ではない。ここは実測の塊で、cursor だけが `/quit` である。
（テキストと Enter は 0.3s 分けて送信される。）

## エージェント間通信

エージェントへのメッセージ送信は必ず `honden inbox write` を使うこと。
tmux を直接操作することは禁止。

```bash
honden inbox write --to <宛先> --type <種別> --from <差出人> --body "<本文>"

# 旧 inbox_write.sh と同じ並び順でも受ける
honden inbox write <宛先> <本文> <種別> <差出人>

# 長い本文は EOF が向いておる。シェルが引用符に手を入れぬゆえ
honden inbox write <<'EOF'
  to: karo
  from: ashigaru3
  type: report_received
  body: |
    本文
EOF
```

並び順・旗・標準入力は、どれか一つを使う。二つ以上渡すと弾かれる。

**受け手の作法**: `inbox_notice unread=N …` の行が届いたら `honden inbox read` で読み、
読んだらすぐ `honden inbox ack --all` で既読にせよ（着手の印。処理は ack の後。ack は「読んだ」の意で「済んだ」ではない。
済むまで既読にせぬと、芯が「無視された」と見て文脈を消しに来る）。
旧い `inbox3` の合図ではない——未読数と足軽の番号が同じ 1〜7 の範囲で
「足軽 3 号」と読み違える事例が実際に出たゆえ、`inbox_notice unread=N` へ改まった。
既読にできるのは己宛のものだけである。他人の報せを既読にすると、
その相手は報せが来たことを永久に知らぬ。

**cursor 固有**: cursor は仕事の切りではなく完了まで報せを読まぬ。
ゆえに急ぎの合図には Enter がもう一度（計 2 回）添えられる。
二度目の Enter で follow-up がステアリングとなり、
「完了まで待つ」が「次のツール呼び出しで読む」へ変わる（作業は中断されぬ）。

**急ぎの報せ**（範囲の増減など）は、honden のどの副命令の出力にも
「⚠ 急ぎの未読」として一行載る。作業の節目で honden を叩けば気づける。

任は inbox の `task_assigned` と `honden lease` で見る。`queue/tasks/{agent}.yaml` は無い。
報せは `honden report submit` で出す。`queue/reports/{agent}_report.yaml` へ書くのではない。
殿の裁定を要するものは `honden decision raise`（上役だけ）で挙げ、
開いておるものは `honden decisions` で見る。`dashboard.md` は無い。

## モデル切り替え

```
/model <model-name>
```

引数なしで実行すると利用可能なモデル一覧を表示する。

ただし pane で打つ `/model` はその場限りである。布陣の cursor は
`cursor-agent --yolo --model <model>` で立つゆえ、恒久の切替は
`scripts/switch_cli.sh` を通す（`config/settings.yaml` を書き換え、
`honden roster sync --settings <settings.yaml>` で正本へ移し、`/quit` させて立て直す）。

## 自動読み込みファイル

| ファイル | 内容 |
|----------|------|
| `.cursor/hooks.json` | フックの配線（`sessionStart` / `beforeShellExecution`） |
| `.cursor/hooks/session-start.sh` | 起動・reset の後に名乗りと作法を `additional_context` として注ぐ |
| `.cursor/hooks/guard-shell.sh` | 禁じ手の門の皮。`honden guard hook cursor` を呼ぶだけ |

honden に `CLAUDE.md`・`AGENTS.md`・`.cursor/rules/`・`.cursor/skills/` は無い。
役の指示書は生成物ではなく、`honden brief --role <役> --cli cursor` がその場で組む。
ゆえに「build を忘れた」も「生成物が部品とずれた」も起こらぬ。

三者の経路はこう分かれる:

- claude → `.claude/settings.json` の SessionStart hook（matcher 五種を明示）
- cursor → `.cursor/hooks.json` の `sessionStart`（`additional_context`）
- codex → `.codex/hooks.json` の SessionStart / PostCompact（平文を注ぐ・実測済み）

cursor には起動時に自動で読む md が無い。名乗りと作法は sessionStart フックの
`additional_context` だけが運ぶ。**このフックが黙れば、cursor は己が誰かを知らぬまま働く。**

## MCP ツール呼び出し構文

Cursor Agent の MCP 呼び出し構文は Claude Code と異なる（`__` → `_`）。

| 用途 | Claude Code | Cursor Agent |
|------|-------------|--------------|
| Context7: ライブラリ ID 解決 | `mcp__context7__resolve-library-id` | `mcp_context7_resolve-library-id` |
| Context7: ドキュメント取得 | `mcp__context7__query-docs` | `mcp_context7_query-docs` |

**パターン**: `mcp__server__tool`（Claude Code）→ `mcp_server_tool`（Cursor）。
セパレータがダブルからシングルになるだけ。

**検証済み（2026-05-28）**: Context7 `resolve-library-id` / `query-docs` 動作確認済み。

## 利用可能なツール

Cursor Agent は以下のツールを提供する：

- **ファイル操作**: 読み取り・書き込み・編集
- **シェルコマンド**: ターミナルコマンドの実行。`beforeShellExecution` の門を必ず通る
- **Web 検索**: 組み込みの検索機能
