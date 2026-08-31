# 借り物である

このディレクトリのものは、こちらが一から書いたものではない。
三つの Apache-2.0 の成果を混ぜ、こちらの好みを足して仕立てたものである。

```
出所 1  https://github.com/gemini-cli-extensions/code-review
        skills/code-review-commons/SKILL.md ほか
版      dd1a10d2c9d0  2026-03-10
免許    Apache License 2.0

出所 2  https://github.com/anthropics/claude-plugins-official
        plugins/code-review/commands/code-review.md
版      aecd4c852f10  2026-02-20
免許    Apache License 2.0

出所 3  https://github.com/openai/codex
        codex CLI に同梱のレビュー手順
版      d58d0e5841e0  2026-08-31
免許    Apache License 2.0
```

三つとも Apache-2.0 なので、守るべき条件は一つで足りる。
免許の全文を `LICENSE` に置いた（Apache-2.0 §4.1）。

## 何を借り、何がこちらのものか

**借りているのは、指摘を絞る規則である。**
これらは同じ考えに別々に至ったものではない。
項目が一つずつ対応しており、日本語へ移し替えたものである。

| こちらの `SKILL.md` | 出所 |
|---|---|
| 「確認せよ」「検討せよ」「検証せよ」など検証系の曖昧な指示は禁止 | 出所 1: `DO NOT ... Tell the user to "check," "confirm," "verify," or "ensure" something` |
| `+`/`-` 行以外の pre-existing な問題は対象外 | 出所 1: `comments must refer only to lines beginning with + or -` / 出所 2: `Pre-existing issues` |
| 確信度 80% 以上の指摘のみ出力する | 出所 2: `Filter out any issues with a score less than 80` |
| lint、型エラー、フォーマットは指摘しない（CI が検出する） | 出所 2: `Issues that a linter, typechecker, or compiler would catch ... run separately as part of CI` |
| nitpick（命名の好みやスタイル議論）は対象外 | 出所 2: `Pedantic nitpicks that a senior engineer wouldn't call out` |
| `// intentional` 等で意図的に無視されている問題は対象外 | 出所 2: `explicitly silenced in the code (eg. due to a lint ignore comment)` |
| 変更されていないファイルの問題は対象外 | 出所 2: `Real issues, but on lines that the user did not modify` |
| 重大度で分類する | 出所 1: `CRITICAL / HIGH / MEDIUM / LOW` |

こちらのものは次のとおりである（Apache-2.0 §4.2 の「変えた箇所」に当たる）。

- **五段階への組み替え**：出所 1 は四段階である。ここでは 🟡 Low-Medium を足して五段階にし、各段の基準を日本語で書き下ろした
- **🔵 Low の範囲を狭める節**：「挙動の欠陥を 🔵 に入れない」「復旧できる、発生頻度が低い、自然に直るは、実バグを 🔵 に落とす理由にならない」。出所のいずれにも無い
- **出力の形**：総合判定、指摘、良い点、PR 内で既修正、仕様による意図的設計の順。後ろ二節は出所のいずれにも無い
- **総合判定の基準表**：`REQUEST CHANGES`、`APPROVE with Comments`、`APPROVE`
- 日本語であること。ペルソナ由来の口調を禁じる一行
- honden へ写す折に変えた所。名（`shogun-review` から `honden-review`）、honden に無いスキルへの参照、`honden-review-to-task` への案内
- 前書きへ `user-invocable: true` を足した。手で発火させるための欄で、既定に頼らず明に書く（出なかった時期がある。殿の実測 2026-08-31）

## なぜ `vendor/` に置かないか

追うべき上流が無いからである。

`vendor/` は、一つの上流から丸ごと借り、版を控えて追従できるものの置き場である（`find-skills` がそれ）。
こちらは三つの成果を混ぜ、こちらの重大度と出力の形を足したもので、戻る先も取り直す先も無い。
今後も手を入れて育てる。

`vendor/` に置けば「触るな、上流の物だ」と読まれる。
それは逆の誤りを招く。
直すべき所を直さなくなる。

そして Apache-2.0 は改変を許している。
編んだからといって免許に触れるわけではない。
保つべきは表示と、「変えた」と述べることだけである。
つまり `vendor/` が設けられた区別（変えてよいか否か）は、ここには当たらない。

それでも免許は残る。
honden 自体は MIT だが、このディレクトリは Apache-2.0 である。
混ぜて MIT と名乗ってはならない。
Apache-2.0 の成果を MIT へ付け替えることはできないからである。
そこで `NOTICE.md` と `LICENSE` を `SKILL.md` の隣に置く。
**見分けは置き場ではなく、隣の紙で付ける。**

## 経緯

同じ誤りを繰り返さないために書き残す。

写す前、こちらは git の履歴から出所を調べ、「上流（yohey-w）に無く、こちらにのみ在り、外来の断りも無いので我らの物」と結論した。
誤りであった。

元の `shogun-review` は旧 repo の白名簿から漏れて一度も追跡されておらず、履歴そのものが存在しなかった。
無い履歴を「何も出てこない、つまり外来ではない」と読んだのが誤りである。
**沈黙を陰性の証拠として扱った。**

出所は殿の証言で判明した。
git に無いものは、git では確かめられない。
