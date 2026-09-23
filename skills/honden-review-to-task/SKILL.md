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
argument-hint: "[PR番号] [--project project] [--repo owner/name]"
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

## 引数

- `$0`：PR 番号。必須。
- `--project <project>`：task の project key または UUID。必須。
- `--repo <owner/name>`：対象 repo。省略時は cwd の repo を使う。
  対象 repo の木の外から実行するときは必ず渡す。

## task CLI の設定

この skill は `task` を直接呼ぶため、shell に次の三つが要る。

```bash
export TASK_API_URL=https://task.koyori.app/api
export TASK_TOKEN=...
export TASK_TENANT=...
task auth whoami --json
```

honden の木では秘密を git に載せず `.envrc` に書き、`direnv allow` で読む。
`TASK_TENANT` は推測しない。PAT の `/personal_tokens/me` は `tenant_id` を返さず、
同名の陣を推すと 403 になることを 2026-09-21 に実測したため、明示するほかない。
`tenant_id` を返す変更（#769）は 2026-09-22 に merge されたが、
**merge と本番 API が返すことは別である**——2026-09-23 に task 0.1.24 で
`task auth whoami --json` を実測したところ、返る鍵は id / name / user_id /
username / scopes / allowed_project_ids / expires_at のみで `tenant_id` は
無かった。いつ返るようになるかは分からない。読む者は同じ命を打って
`tenant_id` の鍵の有無を己で確かめよ——現れたら `TASK_TENANT` の明示を
落とす検討ができる（それまでは要る）。

`TASK_API_URL` の末尾の `/api` は必須である。2026-09-22 に PR #768 で、
`https://task.koyori.app` は `Resource not found`、
`https://task.koyori.app/api` は成功することを実測した。前者の表示から
口の違いは分からないため、鍵・陣・案件を疑う前に `/api` を確かめる。

同じ実測で `/api/v1/personal_tokens/me` は 200 でも tenant_id を返さず、
`/api/v1/tenants` は 403、`/api/v1/users/me` と `/me` は 401、
`/api/v1/tenants/me` は UUID として読めず 400 だった。
review の口は `/tenants/{tenant}/projects/{project}/…` なので、陣の UUID は明示する。

honden 自身が `cmd done` で使う review gate は別経路である。
その tenant は `settings.yaml` の `review.gate.tenant`、案件別なら
`review.gates.<id>.tenant` に書く。直接 `task` を呼ぶこの skill の
`TASK_TENANT` を settings が自動で shell へ出すわけではない。

---

## 手順

### Step 1: 対象 repo と head SHA を取る

**40 桁の小文字 16 進でなければならない。** 短縮 SHA を渡すと、そのラウンドは
指摘を全部解消しても通らなくなる（ゲートが `latest_head_sha` を厳密一致で
比べるため）。しかも「同じ commit に見えるのに再レビューを要求される」形で
出るので、画面から原因を辿れない。

```bash
pr="$0"
project="…" # --project で受けた project key または UUID
repo_arg="…" # --repo で受けた owner/name。省略時は空文字
if [[ -n "$repo_arg" ]]; then
  repo="$repo_arg"
else
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi
pr_json=$(gh pr view "$pr" --repo "$repo" --json headRefOid,url)
head_sha=$(jq -r .headRefOid <<<"$pr_json")
pr_url=$(jq -r .url <<<"$pr_json")
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'head_sha が 40 桁の sha でない: %s\n' "$head_sha" >&2
  exit 1
}
[[ "$pr_url" == "https://github.com/$repo/pull/$pr" ]] || {
  printf 'repo 不一致: %s\n' "$pr_url" >&2
  exit 1
}
```

`head_sha` はここで一度だけ取り、findings JSON と Step 7 の `--head` に使い回す。
`git rev-parse HEAD` は cwd の checkout を写すだけで、PR の head とは限らない。
`repo` と `pr_url` が食い違えば、別 repo の同番号 PR なので投入せず止める。

`gh` が使えないなら、PR 自身の `headRefOid` を取れないので止める。
cwd の ref を代用しない。

> **`git log` の表示を根拠にしてはならない。** merge commit を黙って除外する
> ことがあり、件数が合ってしまうので欠落に気づけない（honden の
> Tool Output Trust）。

### Step 2: 既に同じラウンドが無いか見る

```bash
task --version
task auth whoami --json
task review rounds --project "$project" --pr "$pr" --repo "$repo"
```

`whoami` は review command より先に打つ。403 は PAT が偽とは限らず、
scope、tenant、project authorization の不足でも起きるためである。

PR 番号は引数、head SHA は Step 1 の GitHub `headRefOid`、round 番号と
finding ID は `task review submit` / `task review rounds` の応答から取る。
cwd の Git の状態や表示順から推測しない。

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

- `head_sha` は Step 1 の `$head_sha` をそのまま書く。cwd の HEAD や取り直した値を混ぜない
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

**`task review submit` に `--repo` は無い**（0.1.24 の `--help` で実測。旗は
`--json` / `--project` / `--pr` のみ）。投入先の repo は project の
GitHub 連携先（current integration）から決まる——`rounds --help` の
`--repo` の既定が「the current integration」と明言している。
ゆえに `--project` と `--repo` の組を誤ると、Step 1 は指定 repo の PR を
正しく検めたのに、round は連携先側の同番号 PR へ立つ。読み返す先
（`--repo "$repo"`）には現れないので、誤投入したのに「round なし」に
見えて気づけない。

0.1.24 の `task review summary --project "$project" --pr "$pr" --json` は、
`--repo` を渡さなければ current integration を使い、JSON の `repository` に
その repo 名を返す（2026-09-23 実測）。`summary` は未レビュー等でも有効な
JSON を出して exit 1 になるため、exit 0 と 1 の双方を受け入れた上で
`repository` を**投入前に** `$repo` と厳密比較する。欠落、不正な JSON、
食い違いのいずれでも投入せず止める。

```bash
if integration_json=$(task review summary \
  --project "$project" --pr "$pr" --json); then
  integration_exit=0
else
  integration_exit=$?
fi
[[ "$integration_exit" -eq 0 || "$integration_exit" -eq 1 ]] || {
  printf 'project の GitHub 連携先を取得できぬ（task review summary exit=%s）。\n' \
    "$integration_exit" >&2
  exit 1
}
integration_repo=$(jq -er \
  '.repository | select(type == "string" and length > 0)' \
  <<<"$integration_json") || {
  printf 'task review summary の JSON に有効な repository が無い。投入せず止める。\n' >&2
  exit 1
}
[[ "$integration_repo" == "$repo" ]] || {
  printf 'repo 不一致: --project %s の GitHub 連携先は %s、対象は %s。投入せず止める。\n' \
    "$project" "$integration_repo" "$repo" >&2
  exit 1
}

rounds_before=$(task review rounds --project "$project" --pr "$pr" --repo "$repo" --json | jq length)

task review submit findings.json --project "$project" --pr "$pr"

rounds_json=$(task review rounds --project "$project" --pr "$pr" --repo "$repo" --json)
rounds_after=$(jq length <<<"$rounds_json")
[[ "$rounds_after" -gt "$rounds_before" ]] || {
  printf '投入した round が %s の PR #%s に現れぬ（%s 件のまま）。\n' "$repo" "$pr" "$rounds_after" >&2
  printf -- '--project %s の GitHub 連携先が %s と違う疑いが濃い。盤の project 設定で連携先を確かめ、\n' "$project" "$repo" >&2
  printf '連携先側の同番号 PR に誤投入の round が立っておらぬか検分して始末した上で、正しい組で投入し直せ。\n' >&2
  exit 1
}
latest_head=$(jq -r 'max_by(.round).head_sha' <<<"$rounds_json")
[[ "$latest_head" == "$head_sha" ]] || {
  printf '読み返した最新 round の head_sha (%s) が投入した %s と違う。別の投入と交錯した疑いがある。\n' \
    "$latest_head" "$head_sha" >&2
  printf 'rounds の一覧を目で検分し、己の round がどれかを確かめてから先へ進め。\n' >&2
  exit 1
}
```

一括で 1 回だけ呼ぶ（1 件ずつ送らない）。

### Step 7: マージ可否を見て、そのまま報告する

```bash
if summary_json=$(task review summary \
  --project "$project" --pr "$pr" --repo "$repo" --head "$head_sha" --json); then
  summary_exit=0
else
  summary_exit=$?
fi
summary_json_valid=false
if printf '%s\n' "$summary_json" | jq -e . >/dev/null; then
  summary_json_valid=true
fi
```

`task review summary` は `--head` を省くと cwd の `git rev-parse HEAD` を比較対象にする。
別 repo の木から叩けば、無関係な SHA と比べて偽の `blocked` を返す。
この罠は 2026-09-17 に `honden-review-check` で実測し、2026-09-21 には
PR #749 を honden の木から調べて honden の main HEAD と比較する形で再発した。
ゆえに cwd にかかわらず、Step 1 の PR `headRefOid` を `--head` に必ず渡す。

**未解決の High/Medium が残っていれば終了コード 1** になる。ただし、
有効な summary JSON を取れない exit 1 は通信障害等であり `blocked` ではない。
隣の `honden-review-check` と同じく、次の語で報告する。

| exit | JSON | 報告 |
|---:|---|---|
| 0 | 有効 | `mergeable` |
| 1 | 有効 | `blocked`。未解決、未検証、古い SHA を列挙 |
| 1 | 無効 | `判定不能: task 側未読` |
| 2 | — | 設定不足または入力不正。stderr で分ける |
| 3 | — | 認証失敗（401） |
| 4 | — | 権限不足（403） |
| 5 | — | 対象なし（404） |

`/honden-review` の総合判定は、この task 側の要約に添える形で伝える。

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
