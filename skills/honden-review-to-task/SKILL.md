---
name: honden-review-to-task
user-invocable: true
description: |
  `/honden-review` が出した指摘を koyori-app/task の review-findings へ投入する。
  レビューの**後に**走らせる。レビュー自体は行わない。
  重大度を task の四段階へ写し、head SHA を確かめ、投入前に honden が数を検める。
  「レビュー結果を task へ」「指摘を投入」「honden-review-to-task」「/review のあと task へ」で起動。
  Do NOT use for: レビューそのもの（`/honden-review` を先に走らせよ）、
  PR に紐づかぬ課題の起票（task の通常タスクを使え）、
  GitHub へのインラインコメント投稿（**仕様で禁じられている**）。
allowed-tools: Bash
argument-hint: "<PR番号> [--project <キー>]"
---

# honden-review-to-task — レビュー指摘を task へ移す

## North Star

**レビューの結果を、会話の外へ残すこと。**

いま `/honden-review` の指摘は画面へ出て終わる。読んだ者が直したかどうかは
誰も追わず、PR を後から見る者には届かない。task の review-findings に置けば、
直した／繰り延べた／棄却したまでが記録に残り、**未解決が残る間はマージが止まる**。

## When to Use

- `/honden-review` を走らせた直後、**同じ会話の中で**
- 「レビュー結果を task へ入れて」と言われた時

Do NOT use for:
- レビューそのもの → 先に `/honden-review N` を走らせる
- PR に紐づかない課題 → task の通常タスクとして起票する
- GitHub へのインラインコメント → **仕様で禁じられている**（要約 1 本のみ）

## 前提

- 直前の `/honden-review` の出力が**この会話に残っている**こと
- `task` CLI が使えること（`task review submit` があること）
- `honden` が道に在ること（投入前の検めに使う）

---

## 手順

### Step 1: head SHA を取る

**40 桁の小文字 16 進でなければならない。** 短縮 SHA を渡すと、そのラウンドは
指摘を全部解消しても通らなくなる（ゲートが `latest_head_sha` を厳密一致で
比べるため）。しかも「同じ commit に見えるのに再レビューを要求される」形で
出るので、画面から原因を辿れない。

```bash
gh pr view <PR番号> --json headRefOid -q .headRefOid
```

`gh` が使えないなら `git rev-parse <ref>`。

> **`git log` の表示を根拠にしてはならない。** merge commit を黙って除外する
> ことがあり、件数が合ってしまうので欠落に気づけない（honden の
> Tool Output Trust）。

### Step 2: 既に同じラウンドが無いか見る

```bash
task review rounds --project <キー> --pr <PR番号>
```

**同じ head SHA のラウンドが既にあれば、そこで止める。** 二度投入すると
R2（第二ラウンド）ができ、「同じ commit を二度レビューした」ことになる。

指摘を差し替えたい場合は、新しいラウンドを作るのではなく
`task review resolve` で個々の状態を動かす。

### Step 3: 重大度を写す

`/honden-review` は五段階、task は四段階で **`critical` を持たない**。

| `/honden-review` | task | |
|---|---|---|
| 💥 Critical | `high` | **潰れる。題の頭に 💥 を残す** |
| 🚨 High | `high` | |
| 🔴 Medium | `medium` | |
| 🟡 Low-Medium | `low` | |
| 🔵 Low | `nit` | |

**🟡 を `medium` へ上げてはならない。** task では `medium` がマージを止める。
🟡 はレビュー自身が「改善推奨」と言っているもので、上へ寄せると
**対応表の中に隠れた方針変更**になる。繰り延べても消えはしない——
task は `deferred` にした指摘から通常タスクを自動で起票する。

### Step 4: 書き写す

**レビュー出力を読み直し、一件ずつ JSON へ移す。**

```json
{
  "head_sha": "<40桁>",
  "summary": "<総括。レビューの冒頭 2〜4 文をそのまま>",
  "findings": [
    {
      "severity": "high",
      "title": "💥 認証が完全に存在しない",
      "body": "<説明と → 対処法。markdown 可>",
      "file": "src/auth.ts",
      "line": 42
    }
  ]
}
```

- `title` はレビューの指摘タイトルをそのまま
- `body` に**説明と `→` の対処法**を入れる。ここが薄いと直す者が困る
- `file` / `line` は分かる時だけ。`line` は 1 以上の整数
- 指摘ゼロなら `"findings": []`

**ここが最も危うい所である。** 書式のずれではなく、**書き写す時に落とす・
重大度を言い換える・無い物を足す**。十件あれば、一件消えても人の目では
気づけない。だから次で機械に数えさせる。

### Step 5: 投入前に検める（**飛ばしてはならない**）

レビュー出力を数えて、重大度ごとの件数を**先に申告する**。

```bash
honden review check findings.json --expect high=2,medium=3,low=1,nit=0
```

- 申告と実際が食い違えば止まる（落とし・作り足しの検め）
- `critical` の綴り、`title` / `body` の欠落、`line` が整数でないもの、
  短縮 SHA も同時に弾く
- 💥 が付いた題が `high` になっていなければ止まる（言い換えの検め）

通らなければ**投入しない**。JSON を直してもう一度。

> 申告も書き写しも同じ者が書くので、この検めは完全ではない——
> 数え違いと書き落としが同時に起きれば通る。**一方だけの誤りは必ず捕らえる。**

### Step 6: 投入する

```bash
task review submit findings.json --project <キー> --pr <PR番号>
```

一括で 1 回だけ呼ぶ（1 件ずつ送らない）。

### Step 7: マージ可否を見て、そのまま報告する

```bash
task review summary --project <キー> --pr <PR番号>
```

**未解決の High/Medium が残っていれば終了コード 1** になる。これがマージ可否の
答えであり、`/honden-review` の総合判定はその要約に添える形で伝える。

```
レビュー指摘を task へ入れた（R1 / <head SHA の先頭 7 桁>）
  high 2 / medium 3 / low 1 / nit 0
マージ可否: 未解決の High/Medium が 5 件（task review summary が 1 を返した）
  <指摘一覧への URL>
```

---

## 失敗した時

| | |
|---|---|
| `honden review check` が件数違いで止まる | レビュー出力を数え直す。**申告のほうが正しいとは限らない** |
| `severity must be one of` | `critical` を書いている。💥 は `high` へ潰す |
| head SHA が弾かれる | 短縮を渡している。`--json headRefOid` で取り直す |
| 同じ head SHA のラウンドが既にある | 二度目である。投入せず、`task review resolve` で個々を動かす |
| `task` CLI が無い | 投入は諦め、レビュー結果を会話に残したまま殿へ告げる |

## 注意

- **GitHub へインラインコメントを投稿しない。** PR に置くのは bot の要約 1 本
  だけというのが仕様（koyori-app/task #623）。要約は task 側のジョブが書く
- レビュー専用の鍵は `write:review` だけを持たせる。タスク書き換えの権を
  レビュー用の鍵に渡さない
- この手順は task が繋がっている時だけ意味を持つ。繋がっていなければ
  `/honden-review` の出力をそのまま残せばよい——**投入できないことを、
  レビューが失敗したことにしない**
