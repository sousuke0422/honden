# honden

<!-- AGENTS.md と同じ中身。claude は CLAUDE.md、codex は AGENTS.md を自ずと読むゆえ、
     どちらから入っても同じ道標に当たるようにしてある。片方だけ直すな。 -->

多エージェント運用の差配層。**正本は SQLite 一つ**（`~/.honden/honden.db`）で、
`queue/*.yaml` も `dashboard.md` も無い。

## まず一言

```
honden brief
```

役と CLI は正本から引かれる。persona・運び方・禁じ手が出る。
（部品は `instructions/` に一系統で置いてある。**生成物は作らぬ**——
出す時に組めば、割れようが無い。）

## 受け手の作法

`inbox_notice unread=N …` が届いたら:

```
honden inbox read          # 己に届いておる報せを読む
honden inbox ack --all     # 読んだらすぐ既読にする（着手の印。処理は ack の後）
```

既読にできるのは己の分だけである。他人の分を既読にすれば、相手は永久に気づけぬ。

**急ぎの報せ**（範囲の増減など）は honden のほとんどの副命令の出力に
`⚠ 急ぎの未読` として一行載る（`inbox` 系と `nudge` には載らぬ）。
作業の節目で honden を叩けば気づける。

## 様子を見る

```
honden status        # 布陣一枚（誰が居り、何を握り、何が未読か）
honden cmd list      # 動いておる司令
honden decisions     # 殿の裁可を待っておるもの
```

## 禁じ手

破壊的な命は**門が機械で止める**（`honden guard check --cmd "…"` で先に問える）。
止められた命に正当な理由があるなら `honden guard appeal` で将軍へ直訴せよ。
紋様で捕まらぬ類（分解・難読化・意図）は訓戒の領分である——`honden brief` に書いてある。

門が生きておるかは `honden guard selftest` で確かめられる。
**据えただけでは効かぬことがある**——hook の設定を書き換えると信頼が切れ、黙って飛ぶ。

## 道具の出力を鵜呑みにするな

**フィルタを通った表示を、証拠として文書へ転記するな。**

SHA・commit の確認は `git rev-parse <ref>` か `git rev-list -1 <ref>` を使え。
`git log` の表示を根拠に tip・基準 commit・commit 数を報告へ書いてはならぬ。

**理由（実測・cmd_706）**: `rtk git log` は `--merges` 指定が無いと
**merge commit を黙って除外する**。`-N` の件数指定は除外後に適用されるゆえ
**件数が合ってしまい、欠落に気づく手掛かりが残らぬ**。
`git log -1 <merge_sha>` ですら別の commit を返す。PR merge 運用の repo では
main の tip はほぼ常に merge commit ゆえ、「`git log` で tip 確認」は**系統的に誤る**。

| 信用できる | `rev-parse` / `rev-list` / `show` / `cat-file` / `--merges` を明示した `git log` |
|---|---|
| 汚れておる | `--merges` 無しの `git log`（tip 確認・基準の選定・commit 数の勘定・系譜の推論） |

**表示件数が期待どおりでも、欠落しておらぬ証にはならぬ。** 件数はフィルタの後で揃う。
履歴の完全性が要る場面では `GIT_REAL=/usr/bin/git` で実体を直に叩け（token は失う。常用はせぬ）。

これは git に限らぬ。**道具の出力は観測であって事実ではない**——
何かを「無い」「変わらぬ」「通った」と報告する前に、
その道具が**在る物を見せられる**ことを確かめよ（陽性対照）。
