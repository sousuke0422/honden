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
honden cmd show <cmd_id>                          条件と覆い具合
honden cmd done <cmd_id> [--bypass --reason "…"]  家老だけ・門あり
honden report submit <<'EOF' … EOF                足軽 → 軍師へ自動
honden report qc <<'EOF' … EOF                    軍師 → 家老へ自動
```

### 報告の路

現行のまま。変えたのは受け渡しだけ。

```
足軽 ──report_received──> 軍師 ──verdict──> 家老 ──dashboard──> 将軍
```

宛先は命令の引数に無い。撃つ先を選べないので、飛び越えようがない。
現行 `instructions/ashigaru.md` の F001（将軍へ直に報せるな）と
`instructions/karo.md` の `to_shogun: false`（殿の入力を割り込みで潰さぬため）を、
禁止事項の散文から構造へ移した。`cmd done` も将軍の inbox を鳴らさない。

現行は「報告 YAML を書く」と「inbox_write で軍師を起こす」が別の手順で、
前者だけ済ませると報告は在るのに誰も知らない状態になる。
`report submit` は 1 つの取引にまとめた。報告が入れば必ず軍師の未読が増える。

### 受け入れ条件の門

現行の検めは `instructions/karo.md` の
「Don't: Mark cmd as done if any acceptance_criteria is unmet」という一行だけで、
守っているかを確かめる者が居ない。材料は既に揃っている——足軽の報告 YAML には
`acceptance_check:` が並んでいる。足りないのは、その並びと cmd の条件を
突き合わせる所だった。

| 決め | 理由 |
|---|---|
| 条件は**番号**で引く | 文言で照合すると、写し違いや言い換えで別物になる |
| 証拠は「済」だけでは通さぬ | 後から検める者が辿れぬ。形だけの通過で門が開く |
| `done` だけが覆う義務を負う | `blocked` / `failed` に証拠を出させると嘘が書かれる |
| 残りは司令ぜんたいで数える | 自分の分だけ引くと、他の者が覆った条件まで残りに出る |
| FAIL つき APPROVED は弾く | 検査を集めても判定に結ばねば、検めていないのと同じ |
| 同じ仕事を二度は検めぬ | 判定が二つ残ると、門がどちらを見るか決まらない |

閉じるには**全条件が証拠つきで覆われ、かつ軍師が是**（`APPROVED` か
`APPROVED_WITH_CONCERNS`）であること。どちらも欠ければ、何が足りぬかを並べて断る。

### 型で守っているもの

| 守り | 由来した事故 |
|---|---|
| 司令の番号は正本が振る | `cmd_668` の二重採番。grep が入れ子の 36 件を拾えなかった |
| 受け入れ条件が空なら弾く | `cmd_705` が条件を満たさぬまま done になった |
| 名乗りは環境から取る | `from` が自己申告で、足軽3号が karo を名乗れた |
| 既読は自分のものだけ | 他人の分を既読にすると相手が永久に気づけない |
| 生きた貸与は横取りできぬ | worktree を足軽と同時に触り merge commit を生んだ |
| 指揮系統（将軍→家老→足軽） | 文で書いてあるだけで止める者が無かった |
| 報告の宛先は選べぬ | F001（将軍へ直に報せるな）が禁止事項の散文だった |
| 未達の条件があれば閉じられぬ | karo.md の「done にするな」を守る者が居なかった |
| 「済」だけの証拠を弾く | 並べれば覆ったことになってしまう |
| 足軽は自分の仕事を自分で是とできぬ | 検めの意味が消える |
| 他人の仕事の報告は書けぬ | cmd_020 の regression（足軽5が足軽2の仕事を実行） |
| 名簿に無い者へは送れぬ | 足軽 2 体の環境で ashigaru5 が通ってしまう |
| 様態を切り替えられるのは将軍 | 足軽が自分の合図を通したくて自律へ移せる |
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

### 配達層

```
       書いた側                 常駐する芯                  飛ばす側
  honden inbox write  ──touch──> core/watch  ──spawn──> honden nudge
  honden report submit          (Rust・1 本)              (TS・都度)
        …                        3.6 MiB
                                 何も起きねば 0 起動
```

芯が見張るのは `<正本>.signal` の一点だけ。正本そのものは見張らない
（手が正本へ書くので、帰還ループになる。実測 6 秒 27 回）。

芯と手の約束は一行。手は最後の行に `{"next_wake_ms": N}` を出す。
出さねば既定の網（`--fallback-ms`）で起きる。読めぬ時に「今すぐ」とは解さない。

飛ばす側 (`honden nudge`) が決めること。

| 決め | 現行の出所 |
|---|---|
| 段 L1 (0〜2 分) 素の合図 / L2 (2〜4 分) 立て直し / L3 (4 分〜) 文脈消し | CLAUDE.md の escalation 表 |
| Copilot・Kimi は L2 で先に Escape×2 + Ctrl-C | 同上 |
| 文脈消しの命令は CLI ごと (claude=/clear, codex=/new) | 同上 |
| 文脈消しは 5 分に一度まで | 同上 |
| **将軍へ撃つかは殿が在席かで決まる** | karo.md の `to_shogun: false`（殿の入力を潰すゆえ） |

段は覚えず、時刻の差から毎回計算する。覚えと実際がずれた時に
どちらが正しいか決まらなくなるゆえ。

### 運用の様態

```
honden mode                            いまどちらか
honden mode autonomous --until 08:00   殿が席を外される
honden mode attended                   殿が席に戻られた
```

| | attended（既定） | autonomous |
|---|---|---|
| 将軍への合図 | 撃たぬ | **撃つ（前提）** |
| 家老 → 将軍の inbox | 開かぬ（dashboard を通す） | **開く（escalation の路）** |
| ほかの者 | 変わらぬ | 変わらぬ |

切り替えられるのは**将軍だけ**。読むのは誰でもよい。

一回きりの明示は様態とは別に置く。

```
honden nudge --wake-shogun --reason "殿の明示: この件だけ裁定を仰げ"
```

効くのはその一回だけで、正本の様態は動かない。台帳には `nudge.wake_shogun` として
別の名で残る。様態の切り替えで代用すると、一件のために自律へ移し、
そのまま殿が席へ戻られる——**戻し忘れが常態化する**。

撃たぬのは将軍が特別だからではなく、**殿がいま打ち込んでおる最中を潰す**ゆえ。
殿が席を外しておられる間——夜間や仕事中——は潰す入力が無く、
起こすのが常道になる。起こさねば家老からの escalation が誰にも届かず、
パイプラインが朝まで止まる (memory: shogun_night_autonomous_escalation)。

**撃つ側と書く側を同じ様態で判ずる。** 片方だけ開くと、書けるのに誰も起きぬ、
あるいはその逆になる。

期限を切れる。戻し忘れると、朝になって殿が打ち込んでおる最中に合図が飛ぶ——
**守ろうとしたものを自分で壊す**ので、自分で戻れるようにした。
期限なしの自律には断りを添える。

ペインは名簿へ持たせず、tmux の `@agent_id` から引く。
書き写すと組み替えで静かに古くなり、**別人のペインへ打ち込む**
（現行で一度起きている: incident_watcher_pane_misroute_2026_06_19）。

| | 現行 (bash) | 芯 1 本 |
|---|---|---|
| プロセス数 | 20 | 1 |
| RSS 合計 | 61.8 MiB | 3.6 MiB |
| 何も起きぬ 60 秒の起動 | 72 回 | 0 回 |

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
