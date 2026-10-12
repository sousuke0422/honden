---
name: honden-model-switch
user-invocable: true
description: |
  布陣の一人の CLI と模型を差し替え、立て直した後に門が生きておるかまで確かめる。
  scripts/switch_cli.sh を包み、前に待機と持ち場を確かめ、後に honden guard selftest を打つ。
  「模型を替えて」「CLI を替えて」「<名> を Sonnet に」「立て直して」と言われた時に使う。
  Do NOT use for: 模型の向き不向きを調べるだけの時（honden-model-list を使え）。
  人の裁可の無い差し替え（この skill は裁可を伺う所までで止まる）。
argument-hint: "<名> [--type <CLI>] [--model <模型>]"
allowed-tools: Bash, Read
---

# /honden-model-switch（一人の CLI と模型を差し替える）

## 芯

差し替えは、一人の CLI を抜けさせて新しい命で起こし直す操作である。
抜けさせる時に、その者が手にしていた文脈は消える。
働いておる者を替えれば、手の途中の仕事が失われる。
ゆえに、この skill は替える前に相手が待機であることを確かめ、替えた後に門が生きておることを確かめる。

**模型や CLI を替えるのは、人（殿）の裁可を要す事である。**
この skill は自ら替えを決めない。
裁可が無ければ、下の「三」の dry-run の結果を添えて伺い、そこで止まる。

## 使う物

| 物 | 役目 |
|---|---|
| `bash scripts/switch_cli.sh <名> [--type <CLI>] [--model <模型>] [--dry-run]` | 差し替えの本体。使い方は `--help` で出る |
| `honden status` | その者の様（待機か働きか）と未読 |
| `honden lease` | その者の持ち場（空きか、握っておるか） |
| `honden roster` | 今の顔ぶれ。名と役と CLI と模型が一行ずつ出る |
| `honden guard selftest` | 門が CLI ごとに生きておるか |

`switch_cli.sh` が裏で行うことは次のとおりである（script の頭の註と本文に在る）。

1. pane を名乗り（`@agent_id`）で探す。番号で数えない
2. `--type` か `--model` を渡した時だけ `config/settings.yaml` のその者の節を書き換え、`honden roster sync` で正本へ移す
3. 今の CLI を、CLI ごとの抜け方で抜けさせる（codex は Escape から、cursor は `/quit`）
4. シェルが戻るのを最大 15 秒待つ。戻らねば次の命を打たずに止まる
5. 新しい命で起こし、終わりに `honden guard selftest` を打つ

`--dry-run` は 2 より前で抜ける。設定も pane も触らない。

## 手順

### 一、顔ぶれを引く

```bash
honden roster
```

名は決め打ちしない。替える相手の名と、今の CLI と模型を、この出力から読む。
相手が出力に無ければ、布陣に居ないか名を誤っておる。そこで止まる。

### 二、相手が待機で、握りが無いことを確かめる

```bash
honden status
honden lease
```

- `honden status` の様が「待機」であること。「働き」なら替えない
- `honden lease` の持ち場が「空き」であること。「働いておる」なら、任を握ったままである。替えない
- その者に未読が積もっておれば、読ませて片付けてから替える。立て直すと、読んだはずの文脈が消える

どれかに当たれば、替えずに「いつ替えられるか」を報せて止まる。

### 三、dry-run で打つ命を見る

```bash
bash scripts/switch_cli.sh <名> --type <CLI> --model <模型> --dry-run
```

出力の二行を読む。

- 「今の CLI と模型 → 先の CLI と模型」の行。替える向きが裁可どおりか
- 「打つ命」の行。足軽ごとの env の前置き（`CODEX_HOME='…'` など）が付いておれば、ここに出る

`switch_cli.sh` は模型の名を検めない。
知らぬ名を渡しても dry-run は通り、立て直した後に CLI の側で落ちる。
名は、その CLI の公式の模型の一覧か、`honden-model-list` の写しの規則で確かめてから渡す。

裁可がまだなら、ここで dry-run の出力を添えて伺い、止まる。

### 四、替える（裁可の後）

```bash
bash scripts/switch_cli.sh <名> --type <CLI> --model <模型>
```

今の設定のまま立て直すだけなら、`--type` も `--model` も付けない。
その時は `settings.yaml` を書き換えない。

「シェルが戻らぬ」で止まった時は、続けて打ち直さない。
前の CLI の入力欄に命が刺さるおそれがある。
pane を人が見て、手で抜けさせてから、もう一度二から始める。

### 五、門と顔ぶれを確かめる

```bash
honden guard selftest
honden roster
```

- `honden guard selftest` で、替えた先の CLI の行が「生きておる」であること。script も終わりに打つが、ここで改めて読む
- 「効いておらぬ」か「信頼の記録が無い」と出れば、その者へ任を振らない
- `honden roster` で、その者の CLI と模型が替わっておること

新しい CLI では、人が二つの許しを与える要がある。

- CLI の初回の信頼の画面（作業の dir を信頼するか、など）
- hook の信頼。codex は対話で `/hooks` を開き、門の hook を信頼する。信頼の無い hook を codex は黙って飛ばす

二つが済むまで、門は「据わっておるが効いておらぬ」状態になりうる。
済んだ後に `honden guard selftest` をもう一度打つ。

## 足軽ごとの env

`config/settings.yaml` の `cli.agents.<名>.env` に書いた env（例 `CODEX_HOME`）は、立て直しても残る。
`switch_cli.sh` は起こす命を組むたびに `honden config env <名>` から前置きを引き、出陣の時と同じ口を通る。

CLI を替えても、env の欄は消えない。
替えた先の CLI に要らぬ env（codex 用の `CODEX_HOME` を claude で起こす、など）が残っておれば、人が settings から外す。
env の欄が誤っておれば、`switch_cli.sh` は抜けさせる前に止まる。

## 何人かを替える時

一人ずつ替える。
名は `honden roster` から引き、決め打ちの並びを書かない。
一人ごとに二から五を通す。
まとめて抜けさせると、どれが新しい命で起きたかが分からなくなる。

## 触らぬ物

- 門の本体と hook の設定。替えた後に効いておらぬと出ても、この skill の中で書き換えない。人へ上げる
- 正本（DB）を手で書くこと。名簿は `settings.yaml` から `roster sync` で移る
