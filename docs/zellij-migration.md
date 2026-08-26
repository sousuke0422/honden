# Zellij への移行覚え（調査 2026-08-27・実機 0.44.3 検証済み）

殿が tmux から Zellij への変更を検討しておられる。移る日のための対応表と、
移る前に決めねばならぬ一点を残す。

## 結論の先出し

- **操作の相当はほぼ全部ある**。ただし scripting の要（list-panes・send-keys・
  --pane-id）は **0.44.0 (2026-03-23) 以降**。ディストリ配布の古い版では動かぬ
- **pane 単位の任意メタデータ（tmux の `@agent_id`）だけが無い**。
  ここが唯一の設計判断で、名乗り（identity）の根幹に触れる
- honden 側で触るのは TS の 3 箇所のみ（下表）。**Rust の芯は無改修**
  ——「芯は agent も pane も知らない」設計の配当がここで出る

## 触る場所（honden 側の全台帳）

| 場所 | いま（tmux） | Zellij |
|---|---|---|
| `src/pane.ts` panes() | `list-panes -a/-s -F` | `zellij --session S action list-panes --json` + 自前整形。**全セッション横断は無い**——list-sessions でループ |
| `src/nudge.ts` send() | `send-keys -l` / Enter / Escape / C-c | `write-chars -p ID` / `send-keys -p ID "Enter"` / **`"Esc"`（`"Escape"` は不正・実測）** / `"Ctrl c"` |
| `src/main.ts` who() | `display-message -p '#{@agent_id}'` | 下の設計判断に依る |
| `src/identity.ts` | `TMUX_PANE` の有無 = 布陣の中 | `$ZELLIJ_PANE_ID`。**ただしセッション内でのみ一意**——鍵は (SESSION_NAME, PANE_ID) の組にすること |
| `scripts/testenv.sh` | 頭の註に列挙した 8 種 | new-session -d → `attach --create-background`、split-window → `action new-pane -d`（**生成 pane ID を stdout に返す**）、capture-pane → `action dump-screen` |

## 移る前に決める一点: 名乗りの正をどこに置くか

tmux では「名乗りは pane から取る。env は布陣の外のみ」を型にした
（env は騙れるゆえ）。Zellij には pane メタデータが無いので、三案:

| 案 | 中身 | 評 |
|---|---|---|
| (a) pane 名に詰める | `rename-pane` で `agent_id=karo`、読みは `list-panes --json` の title | **tmux 方式に最も近い**。外部照会できる。弱点: 枠に表示され、手動 rename で消える |
| (b) 起動時 env 注入 | `new-pane -- env AGENT_ID=karo <CLI>` | pane 内で完結し往復不要。**だが騙り耐性は今の HONDEN_AGENT_ID と同じ**——名乗りの正にはできぬ |
| (c) sidecar 台帳 | (SESSION, PANE_ID) → agent の対応ファイル | 現行の registry fallback と同型。台帳と実体がずれる古い病 |

**見立て: (a) を正とし、(b) を布陣外相当の補助に。** (a) の「手動 rename で消える」は、
tmux の @agent_id も同じ弱さを持っておった（消えれば nudge が届かぬだけで fail-closed）。

## 拾い物

- `zellij action dump-screen -p ID [--ansi]` = capture-pane 相当（実測）
- **`zellij subscribe` = pane 出力のリアルタイム購読**。旧 watcher の
  busy 判定（画面文字列の観測）を polling 無しで置き換えうる素材
- `new-pane` 系が生成 pane ID を stdout に返す——tmux で pane_index 順に
  @agent_id を付けて読み戻す往復が、一手で済む

## 出所

一次資料: zellij.dev 公式 doc・GitHub CHANGELOG（0.44.0 = PR #4690/#4691/#4846）。
全項目をローカル 0.44.3（WSL2）の使い捨て背景セッションで実測後、削除済み。
