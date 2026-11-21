---
name: honden-review-to-task
user-invocable: true
description: |
  `/honden-review` が出した指摘を、koyori-app/task の review-findings へ投入する。
  レビューの後に実行する skill で、レビュー自体は行わない。
  重大度を task の四段階へ写し、head SHA を確かめ、投入の前に honden が件数を検査する。
  「レビュー結果を task へ」「指摘を投入」「honden-review-to-task」「/review のあと task へ」で起動する。
  Do NOT use for: レビューそのもの（先に `/honden-review` を実行する）、
  PR に紐づかない課題の起票（task の通常タスクを使う）、
  GitHub へのインラインコメントの投稿（仕様で禁じられている）。
allowed-tools: Bash
argument-hint: "[PR番号] [--project project] [--repo owner/name]"
---

# レビュー指摘を task へ移す honden-review-to-task

## レビューの結果を会話の外へ残す理由

この skill の目的は、レビューの結果を会話の外へ残すことである。

`/honden-review` の指摘は、今は画面に出て終わる。
読んだ人が直したかどうかは誰も追わず、PR を後から見る人にも届かない。
task の review-findings に置けば、直した、繰り延べた、棄却した、という経過が記録に残る。
しかも、**未解決の指摘が残る間はマージが止まる**。

## 使う場面

- `/honden-review` を実行した直後に、同じ会話の中で使う。
- 「レビュー結果を task へ入れて」と頼まれた時に使う。

次の用途には使わない。

- レビューそのもの：先に `/honden-review N` を実行する。
- PR に紐づかない課題：task の通常タスクとして起票する。
- GitHub へのインラインコメント：仕様で禁じられている（PR に置くのは要約 1 本だけである）。

## 前提

- 直前の `/honden-review` の出力が、この会話に残っている。
- `task` CLI が使え、`task review submit` がある。
- 投入前の検査に使う `honden` が PATH に在る。

## 引数

- `$0`：PR 番号。必須。
- `--project <project>`：task の project key または UUID。必須。
- `--repo <owner/name>`：対象の repo。省略すると cwd の repo を使う。
  対象の repo の作業木の外から実行する時は、必ず渡す。

## task CLI の設定

この skill は `task` を直接呼ぶので、shell に次の三つの環境変数が要る。

```bash
export TASK_API_URL=https://task.koyori.app/api
export TASK_TOKEN=...
export TASK_TENANT=...
task auth whoami --json
```

honden の作業木では、秘密を git に載せず `.envrc` に書き、`direnv allow` で読む。

`TASK_TENANT` は推測せず、明示する。
PAT の `/personal_tokens/me` は `tenant_id` を返さない。
同じ名前のテナントを推して指定すると 403 になることも、2026-09-21 に実測した。

2026-09-24 時点（`task --version` の実測は 0.1.26）の `task auth whoami --json` には、次の二つの性質がある。

- (a) 応答に `tenant_id` の鍵が載る（id、name、user_id、username、scopes、allowed_project_ids、expires_at とともに）。
- (b) その `whoami` を実行するにも、依然として `TASK_TENANT` が要る。
  `env -u TASK_TENANT task auth whoami --json` は exit 2（tenant_id 未設定）になる。

2026-09-23 までは (a) が成り立たず、この文書にも「返らない」と書いてあった（当時は正しかった）。

(b) を要らなくする修正は、task の PR #786 である（2026-09-23T23:06:21Z に merge 済み）。
ただし、merge は版の公開ではない。
2026-09-24 に実測した最新の GitHub release の tag はまだ v0.1.26 で、#786 を含む CLI のリリースはまだ出ていない。
その版を入れれば、(b) は消える見込みである。

確かめ方は変えない。
`task --version` と `env -u TASK_TENANT task auth whoami --json` を実行する（0.1.26 では exit 2 になる）。
版が出たら、この行の tag 名を具体的な値へ書き換えてよい。

`TASK_API_URL` の末尾の `/api` は必須である。
2026-09-22 に PR #768 で、`https://task.koyori.app` は `Resource not found` になり、`https://task.koyori.app/api` は成功することを実測した。
前者の表示からは API の入口の違いが分からないので、鍵、テナント、project を疑う前に `/api` を確かめる。

同じ実測では、次の結果も得た。

- `/api/v1/personal_tokens/me` は 200 だが、tenant_id を返さない。
- `/api/v1/tenants` は 403 になる。
- `/api/v1/users/me` と `/me` は 401 になる。
- `/api/v1/tenants/me` は UUID として読めず、400 になる。

review の API は `/tenants/{tenant}/projects/{project}/…` の形なので、テナントの UUID は明示する。

honden 自身が `cmd done` で使う review gate は、この skill とは別の経路である。
その tenant は `settings.yaml` の `review.gate.tenant` に書き、案件ごとに分けるなら `review.gates.<id>.tenant` に書く。
settings に書いた tenant を、`task` を直接呼ぶこの skill の `TASK_TENANT` として shell へ自動で出すわけではない。

---

## 手順

### Step 1: 対象 repo と head SHA を取る

head SHA は 40 桁の小文字 16 進でなければならない。
短縮した SHA を渡すと、そのラウンドは指摘を全部解消してもゲートを通らなくなる（ゲートが `latest_head_sha` を厳密な一致で比べるため）。
しかも「同じ commit に見えるのに再レビューを求められる」形で現れるので、画面から原因を辿れない。

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
  printf 'head_sha が 40 桁の SHA ではない: %s\n' "$head_sha" >&2
  exit 1
}
[[ "$pr_url" == "https://github.com/$repo/pull/$pr" ]] || {
  printf 'repo が一致しない: %s\n' "$pr_url" >&2
  exit 1
}
```

`head_sha` はここで一度だけ取り、findings の JSON と Step 7 の `--head` に使い回す。
レビューには時間がかかり、その間に PR へ push されることがある。
そこで、Step 6（submit の直前）と Step 7（判定の直前）では、比べるためだけに `gh pr view … --json headRefOid` をそれぞれ実行し直す。
取り直した値で `$head_sha` を上書きしてはならない。
findings は、最初に取った head をレビューした結果だからである。

`git rev-parse HEAD` は cwd の checkout を写すだけで、PR の head とは限らない。
`repo` と `pr_url` が食い違えば、別の repo の同じ番号の PR を指しているので、投入せずに止める。

Step の間で受け渡すのは値だけにする。
head の取り直しは関数にせず、同じ処理を各 Step に書き写す（Step 2 と Step 6 が同じ `jq` の式を書き写しているのと同じ流儀である）。
関数を Step 1 に置くと、Step 6 や Step 7 を新しい shell で実行した時に「command not found」になる。
しかも、その失敗は「head を取り直せなかった」という誤った診断に化ける。
各 Step が前提にしてよい値は、`pr`、`repo`、`project`、`head_sha` の四つだけである。

`gh` が使えなければ、PR 自身の `headRefOid` を取れないので止める。
cwd の ref で代用しない。

> `git log` の表示は根拠にしない。
> `git log` は merge commit を黙って除くことがあり、件数が合ってしまうので欠落に気づけない（honden の「道具の出力を鵜呑みにするな」）。

### Step 2: 同じラウンドが既に無いかを見る

```bash
task --version
task auth whoami --json
rounds_before_json=$(task review rounds \
  --project "$project" --pr "$pr" --repo "$repo" --json) || {
  rounds_exit=$?
  printf 'task review rounds が失敗した（exit=%s）。\n' "$rounds_exit" >&2
  exit 1
}
if ! jq -e 'type == "array"' <<<"$rounds_before_json" >/dev/null; then
  printf 'task review rounds の応答が JSON 配列ではない。\n' >&2
  exit 1
fi
if jq -e --arg h "$head_sha" 'any(.[]; .head_sha == $h)' <<<"$rounds_before_json" >/dev/null; then
  printf 'head %s の round は既にある。新しい round は作らず、task review resolve で個々の指摘を動かす。\n' \
    "$head_sha" >&2
  exit 1
fi
```

`whoami` は review のコマンドより先に実行する。
403 は PAT が偽物だから起きるとは限らず、scope、tenant、project の権限の不足でも起きるためである。

PR 番号は引数から、head SHA は Step 1 の GitHub の `headRefOid` から取る。
round 番号と finding の ID は、`task review submit` と `task review rounds` の応答から取る。
cwd の Git の状態や表示の順から推測しない。

同じ head SHA のラウンドが既にあれば、そこで止める。
上の `jq -e --arg h "$head_sha" 'any(.[]; .head_sha == $h)'` が、その検査である。
Step 6 でも、submit の直前に `rounds_before_json` を読み直し、同じ式でもう一度止める。
head が動いていれば通るので、`--force` のような抜け道は要らない。
二度投入すると R2（第二ラウンド）ができ、「同じ commit を二度レビューした」ことになる。

指摘を差し替えたい時は、新しいラウンドを作らず、`task review resolve` で個々の指摘の状態を動かす。

### Step 3: 重大度を写す

`/honden-review` は五段階で、task は四段階である。
task は `critical` を持たない。

| `/honden-review` | task | |
|---|---|---|
| 💥 Critical | `high` | **潰れる。題の頭に 💥 を残す** |
| 🚨 High | `high` | |
| 🔴 Medium | `medium` | |
| 🟡 Low-Medium | `low` | |
| 🔵 Low | `nit` | |

🟡 を `medium` へ上げるわけにはいかない。
task では `medium` がマージを止める。
🟡 はレビュー自身が「改善推奨」と言っている指摘なので、上へ寄せると、対応表の中に方針の変更を隠すことになる。
`low` のまま繰り延べても、指摘は消えない。
task は `deferred` にした指摘から、通常タスクを自動で起票する。

### Step 4: 指摘を JSON へ書き写す

レビューの出力を読み直し、一件ずつ JSON へ移す。

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

- `head_sha` には、Step 1 の `$head_sha` をそのまま書く。cwd の HEAD や取り直した値を混ぜない。
- `title` には、レビューの指摘の題をそのまま書く。
- `body` には、説明と `→` の対処法を入れる。ここが薄いと、直す人が困る。
- `file` と `line` は、分かる時だけ書く。`line` は 1 以上の整数である。
- 指摘が一件も無ければ `"findings": []` にする。

この手順で一番誤りが入りやすいのは、書式ではなく書き写しである。
書き写す時に指摘を落とす、重大度を言い換える、無い指摘を足す、という誤りが起きる。
十件あれば、一件消えても人の目では気づけない。
そこで、次の Step で機械に数えさせる。

### Step 5: 投入の前の検査（省かない）

レビューの出力を数えて、重大度ごとの件数を先に申告する。

```bash
honden review check findings.json --expect high=2,medium=3,low=1,nit=0
```

この検査は、次の誤りで止まる。

- 申告と実際の件数が食い違う（落としと作り足しの検査）。
- `critical` の綴り、`title` と `body` の欠落、整数でない `line`、短縮した SHA がある。
- 💥 の付いた題が `high` になっていない（言い換えの検査）。

通らなければ投入しない。
JSON を直して、もう一度検査する。

> 申告も書き写しも同じ人が書くので、この検査は完全ではない。
> 数え違いと書き落としが同時に起きれば、検査を通ってしまう。
> 一方だけの誤りであれば、必ず捕らえる。

### Step 6: 投入する

取れなかった値を、取れたことにしない。
`$(task … | jq …)` の形は、`task` が失敗しても、`jq` が空の入力を黙って通す。
`jq -e` だけでは足りない（`[]` は有効な JSON である）。
`task` の exit と、JSON が配列であることの両方を見てから数える。

`task review submit` には `--repo` の旗が無い。
0.1.24 の `--help` で実測すると、旗は `--json`、`--project`、`--pr` だけだった。
投入先の repo は、project の GitHub 連携先（current integration）から決まる。
`rounds --help` も、`--repo` の既定を「the current integration」と明言している。
そのため、`--project` と `--repo` の組を誤ると、Step 1 は指定した repo の PR を正しく検査したのに、round は連携先の側の同じ番号の PR に立つ。
読み返す先（`--repo "$repo"`）には現れないので、誤って投入したのに「round なし」に見えて気づけない。

0.1.24 の `task review summary --project "$project" --pr "$pr" --json` は、`--repo` を渡さなければ current integration を使い、JSON の `repository` にその repo 名を返す（2026-09-23 に実測）。
`summary` は、未レビューなどの時も有効な JSON を出して exit 1 になる。
そこで、exit 0 と 1 の両方を受け入れた上で、`repository` を投入の前に `$repo` と厳密に比べる。
欠落、不正な JSON、食い違いのどれかがあれば、投入せずに止める。

> 検査を足したら、その検査が取り除いた原因を、stderr の文言と失敗の表がまだ書いていないかを見直す。
> 先頭の案内が古い仮説のままだと、次に踏んだ人が誤る。
> 例えば、投入前の連携先の照合を足した後も、投入後の読み取りの遅れを「連携先の疑い」として先頭に書いたまま、という残りが起きうる。

```bash
if integration_json=$(task review summary \
  --project "$project" --pr "$pr" --json); then
  integration_exit=0
else
  integration_exit=$?
fi
[[ "$integration_exit" -eq 0 || "$integration_exit" -eq 1 ]] || {
  printf 'project の GitHub 連携先を取得できない（task review summary exit=%s）。\n' \
    "$integration_exit" >&2
  exit 1
}
integration_repo=$(jq -er \
  '.repository | select(type == "string" and length > 0)' \
  <<<"$integration_json") || {
  printf 'task review summary の JSON に有効な repository が無い。投入せずに止める。\n' >&2
  exit 1
}
[[ "$integration_repo" == "$repo" ]] || {
  printf 'repo が一致しない: --project %s の GitHub 連携先は %s、対象は %s。投入せずに止める。\n' \
    "$project" "$integration_repo" "$repo" >&2
  exit 1
}

rounds_before_json=$(task review rounds \
  --project "$project" --pr "$pr" --repo "$repo" --json) || {
  rounds_exit=$?
  printf 'task review rounds（投入前）が失敗した（exit=%s）。投入せずに止める。\n' "$rounds_exit" >&2
  exit 1
}
if ! jq -e 'type == "array"' <<<"$rounds_before_json" >/dev/null; then
  printf 'task review rounds（投入前）の応答が JSON 配列ではない。投入せずに止める。\n' >&2
  exit 1
fi
rounds_before=$(jq 'length' <<<"$rounds_before_json")

if jq -e --arg h "$head_sha" 'any(.[]; .head_sha == $h)' <<<"$rounds_before_json" >/dev/null; then
  printf 'head %s の round は既にある。新しい round は作らず、task review resolve で個々の指摘を動かす。\n' \
    "$head_sha" >&2
  exit 1
fi

# 投入の直前に、PR の head が動いていないかを見る。ここで止まった時は、まだ投入していない。
head_now=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid) || head_now=""
if [[ ! "$head_now" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'PR の現在の head を取り直せなかった。head が動いたかは分からない。投入はしていない。止める。\n' >&2
  exit 1
fi
[[ "$head_now" == "$head_sha" ]] || {
  printf 'head が動いた（%s → %s）。再レビューしてから投入する。投入はしていない。\n' \
    "$head_sha" "$head_now" >&2
  exit 1
}

task review submit findings.json --project "$project" --pr "$pr" || {
  submit_exit=$?
  if rounds_reread_json=$(task review rounds \
    --project "$project" --pr "$pr" --repo "$repo" --json); then
    if ! jq -e 'type == "array"' <<<"$rounds_reread_json" >/dev/null; then
      printf 'task review submit が失敗した（exit=%s）。rounds は返ったが JSON 配列ではない。弾かれたかは分からない。\n' \
        "$submit_exit" >&2
    elif jq -e --arg h "$head_sha" 'any(.[]; .head_sha == $h)' <<<"$rounds_reread_json" >/dev/null; then
      printf 'task review submit が失敗した（exit=%s）。この head の round は既に立っている。submit は再実行しない。task review resolve で個々の指摘を動かす。\n' \
        "$submit_exit" >&2
    else
      printf 'task review submit が失敗した（exit=%s）。この head の round は読み返しでは見つからない。同じコマンドを再実行してよい。\n' \
        "$submit_exit" >&2
    fi
  else
    rounds_reread_exit=$?
    printf 'task review submit が失敗した（exit=%s）。rounds を読み返せなかった（exit=%s）。弾かれたかは分からない。\n' \
      "$submit_exit" "$rounds_reread_exit" >&2
  fi
  exit 1
}

rounds_json=$(task review rounds \
  --project "$project" --pr "$pr" --repo "$repo" --json) || {
  rounds_exit=$?
  printf 'task review submit は成功した。task review rounds（投入後）が失敗した（exit=%s）。\n' \
    "$rounds_exit" >&2
  printf 'submit は再実行しない。rounds の読み取りだけを再実行する。\n' >&2
  exit 1
}
if ! jq -e 'type == "array"' <<<"$rounds_json" >/dev/null; then
  printf 'task review submit は成功した。task review rounds（投入後）の応答が JSON 配列ではない。\n' >&2
  printf 'submit は再実行しない。rounds の読み取りだけを再実行する。\n' >&2
  exit 1
fi
rounds_after=$(jq 'length' <<<"$rounds_json")
[[ "$rounds_after" -gt "$rounds_before" ]] || {
  printf 'task review submit は成功した。読み返しでは round が増えたように見えない（%s の PR #%s、%s 件のまま）。\n' \
    "$repo" "$pr" "$rounds_after" >&2
  printf '読み取りの遅れか、別の投入と交錯した可能性がある。submit は再実行しない。rounds の読み取りだけを再実行する。\n' >&2
  printf '念のため、投入前に照合した連携先が、投入の後に差し替わっていないかを確かめる。\n' >&2
  printf -- '--project %s の GitHub 連携先と %s を比べ、連携先の側の同じ番号の PR に round が立っていないかを確かめる。\n' \
    "$project" "$repo" >&2
  exit 1
}
latest_head=$(jq -r 'max_by(.round).head_sha' <<<"$rounds_json")
[[ "$latest_head" == "$head_sha" ]] || {
  printf 'task review submit は成功した。読み返した最新の round の head_sha (%s) が、投入した %s と違う。\n' \
    "$latest_head" "$head_sha" >&2
  printf 'rounds の一覧を目で確かめ、自分の round がどれかを特定してから先へ進む。submit は再実行しない。rounds の読み取りだけを再実行する。\n' >&2
  exit 1
}
```

指摘は一括で 1 回だけ送る（1 件ずつ送らない）。

### Step 7: マージの可否を見て、そのまま報告する

この時点で、投入はもう済んでいる。
そのため、ここで止める時の文言は、Step 6 の直前の検査とは違う。
投入の後に、「投入していない」と読める文言を出すわけにはいかない。

```bash
# 判定の直前に、PR の head が動いていないかを見る。ここで止まった時は、投入はもう済んでいる。
head_now=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid) || head_now=""
if [[ ! "$head_now" =~ ^[0-9a-f]{40}$ ]]; then
  printf '投入は済んでいる。判定の前に PR の現在の head を取り直せなかった。head が動いたかは分からない。mergeable とは言えない。submit は再実行しない。head の取り直しだけを再実行する。\n' >&2
  exit 1
fi
[[ "$head_now" == "$head_sha" ]] || {
  printf '投入は済んだが、その後に head が動いた（%s → %s）。新しい head は未レビューなので、mergeable とは言えない。submit は再実行しない。\n' \
    "$head_sha" "$head_now" >&2
  exit 1
}

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

`task review summary` は、`--head` を省くと cwd の `git rev-parse HEAD` を比べる対象にする。
別の repo の作業木から実行すると、無関係な SHA と比べて、偽の `blocked` を返す。
この罠は 2026-09-17 に `honden-review-check` で実測した。
2026-09-21 には、PR #749 を honden の作業木から調べ、honden の main の HEAD と比べる形で再発した。
そのため、cwd にかかわらず、Step 1 で取った PR の `headRefOid` を `--head` に必ず渡す。

未解決の High と Medium が残っていれば、終了コードは 1 になる。
ただし、有効な summary の JSON を取れない exit 1 は、通信障害などによるもので、`blocked` ではない。
隣の `honden-review-check` と同じく、次の語で報告する。

| exit | JSON | 報告 |
|---:|---|---|
| 0 | 有効 | `mergeable` |
| 1 | 有効 | `blocked`。未解決、未検証、古い SHA を列挙する |
| 1 | 無効 | `判定不能: task 側未読` |
| 2 | 問わない | 設定の不足か入力の不正。stderr で見分ける |
| 3 | 問わない | 認証の失敗（401） |
| 4 | 問わない | 権限の不足（403） |
| 5 | 問わない | 対象が無い（404） |

`/honden-review` の総合判定は、この task の側の要約に添える形で伝える。

```
レビュー指摘を task へ入れた（R1 / <head SHA の先頭 7 桁>）
  high 2 / medium 3 / low 1 / nit 0
マージ可否: 未解決の High/Medium が 5 件（task review summary が 1 を返した）
  <指摘一覧への URL>
```

---

## 失敗した時の扱い

| 起きたこと | 扱い |
|---|---|
| `honden review check` が件数の違いで止まる | レビューの出力を数え直す。申告のほうが正しいとは限らない |
| `severity must be one of` | `critical` を書いている。💥 は `high` へ潰す |
| head SHA が弾かれる | 短縮した SHA を渡している。`--json headRefOid` で取り直す |
| 同じ head SHA のラウンドが既にある（Step 2 と submit の直前の検査） | 二度目の投入である。`task review resolve` で個々の指摘を動かす |
| 同じ head で新しい指摘を見つけた | head が動くのを待ち、次の round で出す。待てない時は `/external-to-honden` で利用者へ送り、盤の外に残す |
| `task review submit` が非ゼロで返り、読み返すと同じ head の round がある | submit は再実行しない。`task review resolve` で個々の指摘を動かす |
| `task review submit` が非ゼロで返り、読み返しても同じ head の round が無い（配列として読めた） | 同じコマンドを再実行してよい |
| `task review submit` が非ゼロで返り、rounds の読み返し自体が失敗する | 弾かれたかは分からない。exit を報告し、利用者に相談する |
| `task review submit` が非ゼロで返り、rounds は返ったが JSON 配列ではない | 弾かれたかは分からない（「再実行してよい」には落とさない） |
| `task review submit` は成功したが、投入後の `rounds` が失敗するか、JSON 配列ではない | submit は再実行しない。rounds の読み取りだけを再実行する |
| `task review submit` は成功したが、読み返すと round が増えていないか、head が違う | submit は再実行しない。rounds の読み取りだけを再実行する。念のため、投入前に照合した連携先が投入後に差し替わっていないかを、一覧で確かめる |
| 投入の直前（Step 6）で head が動いたか、取り直せない | **まだ投入していない。** 再レビューしてから投入する（取り直せない時は、動いたかが分からないので、通さずに止める） |
| 判定の直前（Step 7）で head が動いたか、取り直せない | **投入はもう済んでいる。** 新しい head は未レビューなので `mergeable` とは言えない。submit は再実行しない（取り直せない時は、head の取り直しだけを再実行する） |
| `task` CLI が無い | 投入はあきらめ、レビューの結果を会話に残したまま利用者に伝える |

## 投稿の範囲と鍵の権限

- GitHub へインラインコメントを投稿しない。
  PR に置くのは bot の要約 1 本だけ、というのが仕様である（koyori-app/task #623）。
  要約は task の側のジョブが書く。
- レビュー専用の鍵には `write:review` だけを持たせる。
  タスクを書き換える権限を、レビュー用の鍵に渡さない。
- この手順は、task につながっている時だけ意味を持つ。
  つながっていなければ、`/honden-review` の出力をそのまま残せばよい。
  投入できないことを、レビューが失敗したことにしない。
