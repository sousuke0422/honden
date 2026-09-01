# 借り物である

このディレクトリのものは、こちらが書いたものではない。

```
出所    https://github.com/yohey-w/multi-agent-shogun
        skills/skill-creator/SKILL.md
版      fc018a77871154d7ac6db586f9f36e9d1160c231  2026-03-12T08:28:22+09:00
免許    MIT License（Copyright (c) 2026 yohey-w）
```

上流の `LICENSE` をそのまま隣に置いた（`LICENSE`）。
根の `LICENSE` にも yohey-w の表示は並べてあるが、借り物は借り物として自分の紙を持つ。

honden は上流の流れを汲む物で、`config/opencode-permissions.yaml` など
一字も違わず引き継いだ品がある（根の `NOTICE`）。
この書もその一つだが、skill は棚ごと他所へ繋いで使う前提ゆえ、
根の紙に頼らず `skills/vendor/` の作法（版を控えて追える）で置く。

中身は取得したまま変えていない。
**変えたのは、frontmatter に `user-invocable: true` を一行足したことだけである。**
この書は `argument-hint` を持ち、名指しで呼ばれる前提である。
宣していなければ「呼べないのに呼ぶつもりの書」になる（`skills/README.md`）。

## 借り物を置く時の作法

- 中身は変えない。変えるなら、何をどう変えたかをここへ書く
- 免許と出所と版を残す。版が無いと、後から「いつのものか」が辿れない
- 上流は現状維持を宣言している。取り込み直す折はこの版と突き合わせる
