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

### 1. 対象 repo と HEAD を固定する

対象 PR の repo の worktree で実行する。

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
gh repo view --json nameWithOwner -q .nameWithOwner
```

`task review summary` は既定で cwd の `git rev-parse HEAD` を比較対象にする。
別 repo で実行すると、その repo の HEAD と review round の SHA を比較して `blocked` になる。
この罠は旧陣で 2026-09-17 に実測した。

対象 repo の worktree へ移れない場合は、`--head` に対象 PR の40桁 head SHAを明示する。
別 repo の HEAD をそのまま使わない。

### 2. task の認証を先に確かめる

```bash
task --version
task auth whoami --json
```

task CLI v0.1.24 以降の `auth whoami` は PAT で動き、scopes、allowed_project_ids、tenant、期限を返す。
`write:review` の有無と対象 project への到達可否を、review command より先に確認する。

`403` を直ちに「PAT が偽」と結論しない。
scope、tenant、project authorization の不足でも拒否されるため、先に `whoami` の事実を読む。
`whoami` を先に置く理由は、PAT 403 の原因調査に日数を費やした事例を 2026-09-17 に実測したためである。

### 3. GitHub の盤を読む

`repo` は Step 1 の `owner/name`、`pr` は `$0` を使う。

```bash
gh pr view "$pr" --repo "$repo" \
  --json number,title,state,headRefOid,reviewDecision,reviews
```

次を分けて記録する。

- PR の現在 state と head SHA
- 現在の reviewDecision
- review ごとの state、commit SHA、reviewer、submittedAt、本文

reviewDecision だけで過去の `CHANGES_REQUESTED` を捨てない。

### 4. task の盤を読む

```bash
task review summary --project "$project" --pr "$pr" --repo "$repo" --head "$head_sha" --json
summary_exit=$?
task review list --project "$project" --pr "$pr" --repo "$repo" --json
task review rounds --project "$project" --pr "$pr" --repo "$repo" --json
```

`summary` の exit code は次の意味で扱う。

| exit | 意味 | 次の処置 |
|---:|---|---|
| 0 | mergeable | 二つの盤に未解決が無いことを確認して merge 候補と報告する |
| 1 | blocked | 未解決 finding、未検証 finding、古い review SHA を具体的に列挙する |
| 2 | 鍵または設定が無い | 不足した設定名を示し、task 側は未読と報告する |
| 3 | 鍵が偽で 401 | `task auth whoami` の結果とともに認証更新を求める |
| 5 | project が無い | project key、tenant、allowed_project_ids を照合する |

この表は 2026-09-17 の task CLI 実測に基づく。
`403`、`blocked`、鍵不在を同じ「読めない」に丸めない。

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
- 判定: mergeable / blocked / 判定不能

### 読めなかった盤

- 無し、または盤名、失敗したコマンド、exit code、理由

### GitHub

- 現在の state と reviewDecision
- review history: state、SHA、reviewer、日時、本文要旨

### task

- whoami: tenant、scopes、allowed_project_ids、期限
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
