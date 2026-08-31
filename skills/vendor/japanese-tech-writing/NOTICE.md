# 借り物である

このディレクトリのものは、こちらが書いたものではない。

```
出所    https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d
        japanese-tech-writing/SKILL
版      c7189cdc9c25  2026-07-24T05:09:49Z
免許    Unlicense（公有への献呈）
```

**中身は取得したまま、一字も変えていない。**

## 免許の出所

gist にはライセンスのファイルが無い。作者が**コメントで明示している**。

> ライセンスはUnlicenseです
> c.f. https://gist.github.com/k16shikano/67625f2a7d96e3bbdfae8d571a936063
>
> —— k16shikano, 2026-06-22

参照先の gist には Unlicense の全文と、次の一文がある。

> k16shikanoのpublic gistには、すべてUnlicenseを適用します。

全文を `LICENSE` に写した。**Unlicense は公有への献呈であり、条件を課さない**
—— 表示も、変更の記載も、免許文の同梱も求められていない。

## ならばなぜ NOTICE を置くか

**義務ではなく、辿れるようにするためである。**

`NOTICE.md` を置く理由は二つある。一つは免許が求めるから（`honden-review` の
Apache-2.0 がそれ）。もう一つは、**出所と版を残さないと後から追えなくなる**
から。ここは後者だけである。

追える理由は実際にある。この gist は作者が更新を続けており、2026-07-24 にも
規範が一つ増えた。**版を控えておかないと、何を取り込み損ねているかが分からない。**

## 取り込むときに見た差（記録）

旧環境（multi-agent-shogun）に置いてあった写しと、この版との差は三行だった。

| | |
|---|---|
| 旧環境が足していた `user-invocable: true` | **持ち込まない。** honden の skills はこの欄を使っていない |
| 「辞書型断定で始めない」の一行 | 上流が 2026-07-09 に追加。旧環境の写しには無かった |
| 「イ形容詞の終止に『です』を続けない」の一行 | 上流が 2026-07-24 に追加。同上 |

旧環境の写しは古い版で止まっていた。**取り直したのはそのためである。**

## 次に取り直すとき

```bash
curl -s https://api.github.com/gists/fd287c3133457c4fd8f5601d34aa817d \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['files']['SKILL.md']['content'])"
```

版は同じ応答の `history[0].version` にある。取り直したら、上の表の版と日付を
書き換える。**書き換えを忘れると、この紙が嘘になる。**
