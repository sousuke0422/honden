---
name: honden-review-check
user-invocable: true
description: |
  GitHub PR の review state と task の review findings、rounds、merge summary を照合し、食い違いと次の処置を日本語で報告する。
  「レビュー状況確認」「マージできるか確認」「PR の指摘確認」「honden-review-check」「二つの盤を照合」で起動。
  Do NOT use for: コードレビューそのもの（honden-review を使う）、指摘の新規投入（honden-review-to-task を使う）、finding の状態変更、PR の merge。
allowed-tools: Bash, Read, Grep
argument-hint: "[PR番号] [--project project]"
---

# honden-review-check

## North Star

GitHub と task の両方を読み、レビューの現在地と次の処置を一度に示す。

GitHub は review decision と review history を持つ。
task は finding の本文、状態、検めた SHA、review round を持つ。
片方だけでは merge 可否を判定できない。

この skill は読み取り専用である。
review の投稿、finding の登録や状態変更、PR の merge は行わない。

## 引数

- `$0`：PR 番号。必須。
- `--project project`：task の project key または UUID。省略時は `task auth whoami --json` と `task projects list --json` から一意に定められる場合だけ補う。
- `--repo owner/name`：対象 repo。省略時は cwd の repo を使う。対象 repo の木の外で実行するときは必ず渡す。

PR 番号が無ければ、番号を一度だけ尋ねる。
project が複数候補から一意に定まらなければ、候補を示して project を尋ねる。
推測した project で照合を続けない。

## 二つの盤

GitHub と task は同じ情報を複製しているのではない。
GitHub の review 本文が外部連絡だけの場合、finding の中身は task にしか残らない。

2026-09-17 に PR #688 を実測した。
GitHub の review history には `CHANGES_REQUESTED` があり、本文は `DM` だった。
task の R1 には HIGH、verified の「Guest は Web UI から許可されたプロジェクトへ到達できない」があった。
両方を読んで初めて、何が指摘され、直され、検証されたかが分かる。

現在の GitHub decision が `APPROVED` でも、過去の `CHANGES_REQUESTED` と task の未解決 finding が消えたとは限らない。
現在値と履歴を分けて報告する。

## 照合手順

### 1. 対象 repo と引数を固定する

対象 PR の repo の worktree で実行する。

```bash
pr="$0"                # 引数で受けた PR 番号
project="…"            # --project で受けた project key または UUID
repo="${REPO_ARG:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"  # --repo が優先。無ければ cwd の repo
git rev-parse --show-toplevel
git rev-parse HEAD     # 報告の「repo HEAD」欄の記録用。比較には使わない
```

`git rev-parse HEAD` は cwd の checkout を写すだけで、PR の head とは限らない。
記録用に留め、merge 判定の比較対象には使わない。
比較に使う SHA は Step 3 で PR 自身から取る（`$head_sha`）。

`task review summary` は `--head` を省くと cwd の `git rev-parse HEAD` を比較対象にする。
別 repo や別 SHA の checkout で実行すると、無関係な SHA と review round の SHA を
比較して `blocked` になる。この罠は旧陣で 2026-09-17 に実測した。
ゆえに `--head` は省かず、常に `$head_sha`（Step 3 で取る PR の headRefOid）を渡す。
cwd がどこであっても手順は変わらない。

### 2. task の認証を先に確かめる

```bash
task --version
task auth whoami --json
```

task CLI v0.1.24 以降の `auth whoami` は PAT で動き、scopes、allowed_project_ids、
**`tenant_id`、期限**を返す（2026-09-24 実測・task 0.1.26。返る鍵は id / name /
user_id / username / scopes / allowed_project_ids / expires_at / tenant_id）。
ただし **whoami を打つには依然 `TASK_TENANT` が要る**——`env -u TASK_TENANT
task auth whoami --json` は exit 2。2026-09-23 までは `tenant_id` 鍵は載らなかった。
#786 を含む **task CLI のリリース**を入れれば後者は消える見込みだが、
**merge は版の公開ではない**——2026-09-24 実測の最新 release tag は **v0.1.26** のままで、
その版は #786 を含まない。確かめ手: `task --version` と同じ `env -u TASK_TENANT` の命
（**0.1.26 では exit 2**。版が出たら tag 名をここへ書き換えてよい）。
`write:review` の有無と対象 project への到達可否を、review command より先に確認する。

`403` を直ちに「PAT が偽」と結論しない。
scope、tenant、project authorization の不足でも拒否されるため、先に `whoami` の事実を読む。
`whoami` を先に置く理由は、PAT 403 の原因調査に日数を費やした事例を 2026-09-17 に実測したためである。

### 3. GitHub の盤を読む

`repo` は Step 1 の `owner/name`、`pr` は `$0` を使う。

```bash
gh pr view "$pr" --repo "$repo" \
  --json number,title,state,url,headRefOid,reviewDecision,reviews,isDraft,mergeable,mergeStateStatus,statusCheckRollup
head_sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid -q .headRefOid)
gh pr view "$pr" --repo "$repo" --json url -q .url   # $repo と一致することを目で突き合わせる
```

以降、`--head` にはこの `$head_sha` だけを渡す。
PR 自身の headRefOid を唯一の比較対象と定めることで、
SHA の比較は checkout した木に依らない。
`$repo` は `--repo` を省くと cwd から取るため、対象 repo の木の外では `--repo` を必ず渡す。

`url` が `$repo` と食い違えば「判定不能: repo 不一致」で止める。
別 repo の同番号 PR を黙って読む事故をここで塞ぐ。

次を分けて記録する。

- PR の現在 state と head SHA
- 現在の reviewDecision
- review ごとの state、commit SHA、reviewer、submittedAt、本文
- isDraft、mergeStateStatus、statusCheckRollup の各 check の結論

reviewDecision だけで過去の `CHANGES_REQUESTED` を捨てない。

GitHub 側のマージ条件は最終判定に含める。
最初に `state` を見る。他の欄より先である。
閉じた PR は `mergeable=MERGEABLE`・`mergeStateStatus=CLEAN` を返したままのことがあり
（この repo の閉じた PR で実測・2026-09-20）、state を後回しにすると誤って肯定が出る。

肯定してよいのは `state` が `OPEN`、かつ `mergeable` が `MERGEABLE`、
かつ `mergeStateStatus` が `CLEAN` の時だけである。
それ以外の値は次の表で倒す。値を見て迷わない。

| 取った値 | 倒し先 | 意味 |
|---|---|---|
| `state=MERGED` | マージ済み（判定終了） | 既に取り込まれている。mergeable とも blocked とも言わず、レビュー可否は答えない |
| `state=CLOSED` | blocked（再オープンが要る） | 開き直さなければ merge できない。普通の blocked と次の手が違うため分けて出す |
| `mergeable=CONFLICTING` | blocked | マージ競合 |
| `mergeStateStatus=DIRTY` | blocked | マージ競合 |
| `mergeStateStatus=BLOCKED` | blocked | 保護規則が塞いでいる（承認不足など。check が全部通っていても塞がる） |
| `mergeStateStatus=UNSTABLE` | blocked | 必須 check の失敗か実行中（`statusCheckRollup` でどれかを特定する） |
| `mergeStateStatus=DRAFT` / `isDraft=true` | blocked | draft |
| `mergeStateStatus=BEHIND` | blocked | base から遅れている |
| `mergeStateStatus=HAS_HOOKS` | blocked | pre-receive hook 待ち |
| `mergeable=UNKNOWN` / `mergeStateStatus=UNKNOWN` | 判定不能 | GitHub がまだ判じていない。少し待って同じ取得をやり直す |

`BLOCKED` はそれ自体が止め条件である。
check の結論だけを読んで「通っているから良し」とするのは誤りで、
承認不足で `BLOCKED` のまま check は全部通る形が現にある。

`UNKNOWN` を blocked に寄せるのも誤りである。
GitHub はマージ可能性を遅延計算するため、取得直後は `UNKNOWN` が返ることがある。
判定不能とし、少し待って取り直す手を示す。

判定名について三つを決めてある。
判定名は `mergeable` のまま残す。
材料の側に上の四項目を足す。
理由は、この書の起動語に「マージできるか確認」があり、名を review-gate-clear へ
逃がすと、読む者が期待する物と書が答える物が離れるためである。

### 3b. インラインの thread を読む

review 本文の外、行に付いたコメントは `reviews` に出ない。
別口で取り、未解決の thread を判定に含める。

```bash
gh api --paginate "repos/$repo/pulls/$pr/comments"

q='query($owner:String!,$name:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$pr){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved isOutdated comments(first:1){nodes{path body}}}}}}}'
after=""; threads="[]"; threads_incomplete=0
while :; do
  page=$(gh api graphql -f query="$q" -f owner="${repo%%/*}" -f name="${repo##*/}" \
    -F pr="$pr" ${after:+-f after="$after"}) || { threads_incomplete=1; break; }
  threads=$(jq -c --argjson t "$threads" '$t + .data.repository.pullRequest.reviewThreads.nodes' <<<"$page")
  hasNext=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$page")
  after=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$page")
  [ "$hasNext" = "true" ] || break
done
[ "${hasNext:-true}" = "true" ] && threads_incomplete=1   # 失敗 break は前頁の真が残る。印で上書きする
```

`gh api graphql --paginate` は reviewThreads のような入れ子の接続には効かない。
`pageInfo` を読み、`hasNextPage` が真のあいだ `after` に `endCursor` を渡して回す。
偽になれば止まり、`endCursor` はページごとに進むため無限には回らない。

取得に失敗すると `threads_incomplete=1` の印が立つ。
`threads` を空にする形は採らない。空にすると「取れなかった」と「ほんとうに一件も無い」が
同じ顔になるためである。輪の後の一行は、失敗 break で `hasNext` に前の頁の真が
残ったままでも、判定が印の側で上書きされることを保証する。

未解決（`isResolved` が false）の thread の列挙は、
`threads_incomplete` が立っていないときだけ行う。
件数と path を記録し、merge 可否より先に列挙する。
印が立っているときは列挙せず、「判定不能: GitHub 側未読（thread を読み切れていない。
`threads` に残っているのは途中までの頁である）」と理由を添えて報じる。
途中までの一覧を全部の顔で出すこと、列挙せずに黙ることの両方を塞ぐ。

### 4. task の盤を読む

```bash
summary_json=$(task review summary --project "$project" --pr "$pr" --repo "$repo" --head "$head_sha" --json)
summary_exit=$?
task review list --project "$project" --pr "$pr" --repo "$repo" --json
task review rounds --project "$project" --pr "$pr" --repo "$repo" --json
```

exit code を読む前に、`$summary_json` が有効な JSON かを確かめる（`jq -e . >/dev/null` 等）。
blocked と結論してよいのは「exit=1、かつ有効な summary の JSON を取れ、
その中身がゲート不成立を示す」場合だけである。
JSON を取れていない exit=1 は通信障害等の失敗であり、task 側未読として
「片方しか読めない場合」の形式で「判定不能」と報告する。

`summary` の exit code は次の意味で扱う。

| exit | 意味 | 見分け方 | 次の処置 |
|---:|---|---|---|
| 0 | mergeable | — | 二つの盤に未解決が無いことを確認して merge 候補と報告する |
| 1 | 二義: ゲート不成立（blocked）と、通信障害・HTTP 500 等の未分類の失敗 | 有効な summary の JSON を取れたかで分ける | JSON 有: blocked として未解決 finding、未検証 finding、古い review SHA を列挙する。JSON 無: 判定不能・task 側未読と報告する |
| 2 | 二義: 鍵・設定が無い、と引数の検証に落ちた | stderr か JSON の中身で「設定不足」と「入力不正」を分ける | 設定不足: 不足した設定名を示す。入力不正: 誤った引数を示す。いずれも task 側は未読と報告する |
| 3 | 鍵が偽（401） | — | `task auth whoami` の結果とともに認証更新を求める |
| 4 | 権限不足（403） | — | scope、project authorization を whoami の事実で、tenant は環境の値で照合する |
| 5 | 対象が無い（404。project に限らぬ） | stderr で何が見つからなかったかを読む | project key、tenant、allowed_project_ids、PR 番号を照合する |

この表は 2026-09-18 に task CLI v0.1.24 の `review summary` で実測した物である。
exit=3 はレビューの契約一覧には無いが実測では在る。実測を正とする。
`403`、`blocked`、鍵不在を同じ「読めない」に丸めない。

exit code の数だけで blocked と断じない。
exit=1 は「有効な summary の JSON を取れ、その中身がゲート不成立を示す」時に限り blocked とする。
JSON が取れていない exit=1 は task 側未読であり、結論は「判定不能」である。
死んだ接続先でも exit=1 が返ることを 2026-09-18 に実測した
（stderr は `error sending request for url (…)`、JSON 無し）。
この形を blocked と読めば、通信障害のたびに偽の指摘を報告することになる。

### 5. finding の状態と SHA を照合する

finding の状態は次の五つである。

- `open`：未着手または未修正
- `fixed`：修正済みだが再検証前
- `verified`：修正を再検証済み
- `deferred`：別作業へ繰り延べ
- `rejected`：理由を記録して棄却

古い SHA に対する review round しか無ければ、枝へ commit を積んだ後も merge 判定は blocked のままになる。
新しい head SHA に対する再レビューを submit し、finding を検証し直す必要がある。
この状態遷移を 2026-09-17 に実測した。

`task review list` は finding ID を各行の先頭に返す。
状態変更コマンドはその ID を位置引数に取る。

```bash
task review resolve --project "$project" --state verified "$finding_id" --note "再検証の根拠"
```

この skill では `resolve` を実行しない。
次の処置として必要なコマンドを示すだけに留める。

`task review rounds` は round 番号、検めた SHA、reviewer、finding 件数を一行単位で読む。
ID と round 出力の形は 2026-09-17 に実測した。

### 6. 二つの盤を突き合わせる

次の食い違いを明示する。

- GitHub は `APPROVED` だが task に `open`、`fixed`、古い SHA の finding が残る
- GitHub は `CHANGES_REQUESTED` だが task の finding は全件 `verified` または終端状態である
- GitHub と task が異なる head SHA を見ている
- GitHub review 本文が外部連絡だけで、具体的 finding は task にだけある
- task round はあるが GitHub review が無い、またはその逆

食い違いがあれば、merge 可否より先に示す。

## 片方しか読めない場合

最初に読めなかった盤と理由を書く。
その後で読めた盤の事実を示す。

片肺では `mergeable`、`blocked`、`指摘なし` のいずれも断定しない。
結論は「判定不能」とし、もう片方を読むための具体的な次手を示す。

```text
判定不能: task 側を読めない
理由: TASK_API_URL / TASK_TOKEN / TASK_TENANT が未設定（task auth whoami exit 2）
GitHub 側で読めた事実: PR #688、head 2522ce…、現在 APPROVED、履歴に CHANGES_REQUESTED 1件
未確認: task findings、review rounds、task merge summary
次手: task の設定を直し、task auth whoami が成功してから三つの review command を再実行する
```

GitHub 側が読めない場合も同じ順序で書く。
task の findings が空でも「指摘なし」と書かない。
GitHub の review history を読めていないためである。

## 出力形式

出典の取得時刻を UTC の ISO 8601 で一度記録する。

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

次の順で日本語報告を返す。

```markdown
## Review check

- 対象: owner/repo PR #番号
- 取得時刻: YYYY-MM-DDTHH:MM:SSZ
- repo HEAD: 40桁 SHA
- PR head: 40桁 SHA
- 判定: mergeable / blocked / 判定不能 / マージ済み（blocked のうち再オープンが要る物はその旨を添える）

### 読めなかった盤

- 無し、または盤名、失敗したコマンド、exit code、理由

### GitHub

- 現在の state と reviewDecision
- isDraft、mergeStateStatus、必須 check の結論
- 未解決のインライン thread: 件数と path（取れなければ「判定不能」の理由に書く）
- review history: state、SHA、reviewer、日時、本文要旨

### task

- whoami: scopes、allowed_project_ids、**tenant_id**、期限（打つには TASK_TENANT が要る——`env -u TASK_TENANT` で確かめよ）
- summary: exit code と理由
- findings: ID、severity、state、title
- rounds: R番号、SHA、reviewer、件数

### 食い違い

- 無ければ「両盤の head SHA と未解決状態は一致」
- あれば一件ずつ列挙

### 次に行うこと

1. 担当者と完了条件が分かる具体的な処置
```

片肺のときは「読めなかった盤」を省略しない。
両盤を読めたときだけ、未解決が無いことを述べる。

## 発火境界

次は起動対象である。

- 「PR #688 のレビュー状況を二つの盤で確認して」
- 「task の指摘が残っていてマージできるか見て」
- 「honden-review-check 688 --project task」

次は起動対象ではない。

- 「PR #688 をコードレビューして」
- 「この findings.json を task へ投入して」
- 「finding を verified に変えて」
- 「PR を merge して」
