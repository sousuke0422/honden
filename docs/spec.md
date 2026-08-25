# いまの仕様

2026-08-26 時点。shogun（現行）と honden（後継）が並走している段の整理。

## 全体の位置関係

```
殿
 └ 将軍 ── 家老 ── 足軽 1〜7（上限 7・環境ごとに増減）
            └ 軍師（品質確認）
```

正本は 2 つある。移行の途中なので当然そうなる。

| | 正本 | 書き手 | 読み手 |
|---|---|---|---|
| **shogun**（現行） | `queue/**.yaml` | 全エージェントが直に編集 | grep と目視 |
| **honden**（影） | `~/.honden/honden.db` | `honden` CLI だけ | CLI と全文検索 |

honden は**影の段**にあり、shogun 側の YAML へ一切書かない。取り込みは一方通行。
書き手が 2 人になると、後から書いたほうが相手を潰すため。

## shogun 側（現行・稼働中）

```
CLAUDE.md / AGENTS.md / .github/copilot-instructions.md   338 行 × 3（同内容・CLI 別）
instructions/{shogun,karo,gunshi,ashigaru}.md             2098 行
instructions/*_at.md（aki-tweak 拡張）                     667 行
instructions/generated/                                   24 本 19112 行（build_instructions.sh が生成）
skills/                                                   36 本
lib/ + scripts/                                           6978 行（bash）
```

規範の中身は 3 本の md に同じものが入っている。CLI ごとに読む先が違うため。
2026-08-25 に `Tool Output Trust` を足したときも 3 本へ同時に入れ、機械照合した。

### 動いている主な仕組み

- `inbox_watcher.sh` — inotify で inbox の変化を検知し、pane へ合図（`inboxN`）
- `lib/stale_task_detect.sh` — `assigned` の沈黙検知（4 層・500 行余り）
- `lib/cli_adapter.sh` — CLI 差の吸収、bloom→モデルの推薦
- `switch_cli.sh` — agent の CLI/モデルをライブ切替

### 既知の欠陥（bash 側は直さず honden で解く）

`docs/decisions.md` の「配達層を書き直すときに持ち込む要件」に根拠つきで記録済み。

- `is_valid_cli_type` に `cursor` が無く、cursor 3 体が `codex` に化ける。cursor 専用の 5 分岐が到達不能
- nudge の抑制が「未読件数が同じとき」にしか効かない。件数は常に動くので効かない
- `inboxN` の N が足軽番号 1〜7 と衝突する
- busy 判定の文字列に試験が 1 本も無い
- `queue/shogun_to_karo.yaml` ほか 3 本が YAML として parse できない（grep で読めるので誰も気づかなかった）

## honden 側（影・今日から使える）

```
src/    2989 行（TypeScript / Bun）
test/   2339 行・209 件
```

### 表

| 表 | 何を持つか |
|---|---|
| `cmd` / `cmd_acceptance` | 司令と受け入れ条件（順序つき） |
| `task` | 持ち場。**貸与**（holder / leased_at / lease_until）を持つ |
| `inbox` | 受け渡し |
| `report` / `report_check` | 報告と検査項目。verdict は 4 値、外れた値は `legacy` へ |
| `roster` | 顔ぶれ。環境の `settings.yaml` の `cli.agents` から入れ替える |
| `model_limit` | 能力に制限があるモデルだけの一覧。表に無ければ制限なし |
| `doc` / `doc_fts` | 取り込んだ本文と全文検索（`Intl.Segmenter` で切る） |
| `source` / `import_issue` | 取り込み元の sha256 と、読めなかったものの記録 |
| `ledger` | 追記専用。全ての書き込みが落ちる |

### 命令

```
honden roster sync --settings <settings.yaml>
honden roster
honden import [--root PATH] [--sub queue,saytask]
honden search <語> [--limit N]
honden route <1-6> [--role worker] [--providers ...]
honden cmd new <<'EOF' … EOF                     将軍だけ
honden task assign --agent X --cmd_id Y --title Z [--bloom L4]
honden task assign … --bypass --reason "…"        将軍だけ・理由必須
honden lease
honden lease release <agent> [--force --reason "…"]
honden inbox write <宛先> <本文> <種別> <差出人>   旧 inbox_write.sh と同じ並び
honden inbox write --to A --from B --type T --body 本文
honden inbox write <<'EOF' … EOF
honden inbox read [--agent X] [--all]
honden inbox ack <id...> | --all                  自分のだけ
honden inbox unread [agent]
```

### 型で守っているもの

| 守り | 由来した事故 |
|---|---|
| 司令の番号は正本が振る | `cmd_668` の二重採番。grep が入れ子の 36 件を拾えなかった |
| 受け入れ条件が空なら弾く | `cmd_705` が条件を満たさぬまま done になった |
| 名乗りは環境から取る | `from` が自己申告で、足軽3号が karo を名乗れた |
| 既読は自分のものだけ | 他人の分を既読にすると相手が永久に気づけない |
| 生きた貸与は横取りできぬ | worktree を足軽と同時に触り merge commit を生んだ |
| 指揮系統（将軍→家老→足軽） | 文で書いてあるだけで止める者が無かった |
| 名簿に無い者へは送れぬ | 足軽 2 体の環境で ashigaru5 が通ってしまう |
| 能力の足りぬ者へは振れぬ | composer-2.5 は L4 まで |
| pragma の順序（busy_timeout が先） | 順序を誤ると 8 プロセス中 7 つが即死し 1400 件消える |

### 迂回の作法

指揮系統も貸与も、常道が塞がったときの道を持つ。四つを課す。

1. 明示（`--bypass` / `--force`）
2. 理由が必須。空も、短すぎるものも、長くても中身の無いものも弾く
3. 別の action として台帳に残す（`task.assign.bypass` / `lease.release.force`）
4. **迂回した時の相手の様子を併せて記録する**

4 つ目が肝。「本当に倒れていたか」を後から検められるし、
迂回の回数そのものが「常道が壊れている」という指標になる。

### 合図の形

```
inbox_notice unread=3 report_received=2 cmd_new=1 urgent=1
```

受け取るのは人ではなく各 CLI の裏のモデル。ASCII の key=value で揃える。
`urgent` は cmd 系と `clear_command` が混じるときだけ 1。

## まだ無いもの

- **報告路**（足軽 → 軍師 → 家老）。`report` 表はあるが書き口が無い
- **受け入れ条件の門**。`cmd done` が無く、条件を検めて閉じる経路が無い
- **書き戻し**（正本 → `queue/**.yaml`）。切り替えの日を決めるまで入れない
- **配達層**（watcher / nudge の送出）。bash 側のまま
- **判断蒸留**（kagemusha の submodule は pin 済みだが未接続）

## 並走の段をどう終えるか

書き戻しを入れた日が切り替えの日になる。その日に併せて要るもの。

- `scripts/inbox_write.sh` を honden への薄い包みに差し替える
- `skills/external-to-shogun` の Step 3（本文の事前検査）を落とす。honden では要らない
- CLAUDE.md の inbox 節と nudge の記述を書き換える
- 配達層を honden 側へ移す（上の「既知の欠陥」がここで解ける）
