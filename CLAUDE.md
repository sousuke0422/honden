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
honden inbox ack --all     # 処理したものを既読にする
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
