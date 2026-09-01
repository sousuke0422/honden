# skills

この棚は、他所へまるごと繋いで使う前提で置いてある。

```
skills/
  competitive-survey/       自作
  external-to-honden/       自作
  honden-coder/             自作。旧 shogun-coder の移し。script を隣（scripts/）に持つ
  honden-remote-ssh/        自作。旧 shogun-remote-ssh の移し
  honden-review-to-task/    自作
  honden-review/            派生。Apache-2.0（NOTICE.md と LICENSE が隣に在る）
  vendor/                   借り物。追える上流がある
    find-skills/            MIT（vercel-labs/skills）
    japanese-tech-writing/  Unlicense（k16shikano の gist）
    skill-creator/          MIT（yohey-w/multi-agent-shogun。上流の版を控えてある）
  find-skills -> vendor/find-skills                      近道
  japanese-tech-writing -> vendor/japanese-tech-writing  近道
  skill-creator -> vendor/skill-creator                  近道
```

## 三つに分ける

はじめは「自作」と「借り物」の二つしか無かった。
それでは足りなかった。
混ぜ物から起こした派生を `vendor/` へ入れてしまい、「触るな、上流の物だ」と読ませるところであった（`honden-review`、2026-08-31）。

| | 何か | 置き場 | 手を入れてよいか |
|---|---|---|---|
| **自作** | こちらが書いた | 直下 | よい。免許はこの repo と同じ |
| **派生** | 他所の成果を混ぜ、こちらを足した。戻る先が無い | 直下 | よい。ただし免許は出所のもの |
| **借り物** | 一つの上流から丸ごと。版を控えて追える | `vendor/` | 原則触らない。触ったら NOTICE へ書く |

**置き場を決めるのは「追える上流があるか」である。**
免許が付くかどうかではない。
派生にも免許は付く。

### 見分けは置き場ではなく、隣の紙で付ける

`NOTICE.md` が在れば、それは自作ではない。
直下にあっても同じである。

`NOTICE.md` には出所、版、免許、借りた所と足した所の別を書く。
版を書かないと、後から「いつのものか」が辿れない。
Apache-2.0 のように免許の全文の同梱を求めるものは、`LICENSE` も隣に置く。

**紙を置く理由は二つある。**
一つは免許が求めるから。
もう一つは、出所と版を残さないと後から追えなくなるからである。
Unlicense（公有）のように何も求めない免許でも、後者のために置く。
`japanese-tech-writing` がそれで、上流が更新を続けているため、版を控えていないと取り込み損ねに気づけない。

### 手で呼ぶか、気づかれて回るか

`user-invocable` は、全部に足す欄ではない。
かといって、機械的に決まるものでもない。

| | |
|---|---|
| `argument-hint` を持つ | `user-invocable: true` が要る。引数を取る書は名指しで呼ばれる前提であり、宣していなければ呼べないのに呼ぶつもりの書になる |
| 持たない | 既定では不要。プロンプトから気づかれて自律で回るなら、この欄は要らない |
| 持たないが、手でも呼びたい | 書く。`argument-hint` は「必ず要る」の線であって、「これ以外は書くな」ではない |

三つ目が `japanese-tech-writing` である。
日本語で書くときに気づかれて回る書だが、推敲を頼む折に名指しできないと困るので、引数を取らないまま `user-invocable: true` を入れてある（殿の判断）。

手で呼ぶなら明に書く理由は、既定が版で変わりうるからである。
いまの版では書かなくても出るのかもしれないが、出なかった時期がある（殿の実測 2026-08-31）。

逆に、自律で回るだけの書へ足しても意味はない。
**要らない欄を全部に足すのは、決めたことにならない。**
一度そうやって六つ全部に足し、殿に正された。

### 派生に手を入れたら

`NOTICE.md` の「こちらのもの」へ書き足す。
Apache-2.0 §4.2 は、変えた旨を述べることを求めている。
育てるほど、こちらの分が増えていくのが正しい姿である。

## 近道は相対で貼る

`skills/` を他所へ繋ぐ前提なので、**絶対で貼ると繋いだ先で解けない。**

```bash
cd skills && ln -sfn vendor/find-skills find-skills
```

`.gitignore` は白名簿である。
近道は一本ごとに許可を書く。
`skills/*` を丸ごと開けると、白名簿にした意味が消える。

## 借り物の手順が、この布陣の決めと食い違う時

**消さずに、断りを添えて残す。**
消すと、元の手順を読んだ者が「なぜ違うのか」を辿れなくなる。

`vendor/find-skills/SKILL.md` の頭がその例である。
元の Step 6 は `npx skills add -g -y` を指図しているが、この布陣では D010-AT と D011-AT で禁じている。
手順は残し、頭に「探すのは可、入れるのは STOP-and-report」と置いた。
