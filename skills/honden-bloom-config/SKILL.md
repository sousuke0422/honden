---
name: honden-bloom-config
user-invocable: true
description: |
  問いに答えてもらい、capability_tiers と available_cost_groups の草稿を組む wizard。
  契約しておるプランと枠の優先を AskUserQuestion で選ばせ、今の顔ぶれ（honden roster）の模型をクラスに写して草稿を出す。
  「capability_tiers を組んで」「ルーティングの設定」「模型の割り振りを決めたい」「bloom config」と言われた時に使う。
  Do NOT use for: config/settings.yaml へ書き込むこと（書くのは人。この skill は草稿を出すだけ）。
  模型や CLI を替えること（honden-model-switch を使え）。
allowed-tools: Bash, Read, AskUserQuestion
---

# /honden-bloom-config（問いで capability_tiers の草稿を組む）

## 芯

honden は、任の難しさを Bloom の段（L1 から L6）で受け、その段に足りる者へだけ振る。
足りるかどうかを決めるのが `config/settings.yaml` の **capability_tiers** である。
この表は「能力に制限のある模型」だけを挙げ、表に無い模型は制限なし（L6）として扱われる（`src/routing.ts` の `maxBloomOf`）。
振り先は「足りる中で最も軽い順」に選ばれる（同じ所の `recommend`）。

この wizard は、問いで枠の事情を聞き、今の顔ぶれの模型にクラスの目安を当てて、表の草稿を出す。
**草稿を `config/settings.yaml` へ書くのは人である。** skill は書かない。

## 手順

**表を先に出さない。** 必ず先に問う。

### 一、今の顔ぶれを引く

```bash
honden roster
```

各行の模型を、`honden-model-list` の「名からクラスへの写し」でクラスに写す。
クラス不明の模型は、そのまま「不明」として控えておく（後の警告に使う）。

### 二、Q1: Claude のプラン（AskUserQuestion）

```
question: "Claude のプランを教えてください。"
header: "Claude"
options:
  - label: "Max 20x"
    description: "Opus、Sonnet、Haiku の各クラスが使える。枠は三つの中で最も多い。枠の量と値段、版ごとに使える模型は公式の頁で確かめる"
  - label: "Max 5x"
    description: "同上で、枠は Max 20x より少なく Pro より多い"
  - label: "Pro"
    description: "Opus、Sonnet、Haiku の各クラスが使える。枠は標準"
  - label: "Free か、なし"
    description: "上位のクラスが使えぬ。L6 に振れる者が居なくなりうる"
```

各プランの値段と、どのクラスがどの版まで使えるかは https://claude.com/pricing で確かめる。
選択肢の説明に値段や版の名を書かない（古くなるのが早い）。

### 三、Q2: ChatGPT（OpenAI）のプラン（AskUserQuestion）

```
question: "ChatGPT（OpenAI）のプランを教えてください。"
header: "ChatGPT"
options:
  - label: "なし（Claude だけで回す）"
    description: "Claude の枠だけ。構成が簡単になる"
  - label: "Plus"
    description: "Codex CLI が使える。使えるクラスと枠は公式の頁で確かめる"
  - label: "Pro"
    description: "Plus より枠が多く、Plus に無いクラスを含むことがある。公式の頁で確かめる"
```

値段と使えるクラスは https://chatgpt.com/pricing で確かめる。

### 四、Q3: 枠の優先（両方を使う時だけ）

Q1 が Free でもなしでもなく、かつ Q2 が Plus か Pro の時だけ問う。
顔ぶれに両方の側の模型が居なければ、問わずにその旨を伝える。

#### Q3a: L1 から L3 の仕事（量の多い実装、雛形の当てはめ）をどちらの枠で回すか

```
question: "L1 から L3 の仕事は、どちらの枠を先に使いますか？"
header: "L1-L3"
options:
  - label: "ChatGPT の枠を先に (Recommended)"
    description: "Luna などの軽いクラスで量を捌き、Claude の枠を L5 と L6 に残す"
  - label: "Claude の枠を先に"
    description: "Haiku で量を捌き、ChatGPT の枠を L4 に残す"
```

#### Q3b: L4 の仕事（分析、デバッグ、レビュー）をどちらの枠で回すか（Q2 が Pro の時だけ）

```
question: "L4 の仕事は、どちらの枠を先に使いますか？"
header: "L4"
options:
  - label: "ChatGPT の枠を先に (Recommended)"
    description: "Terra や Sol などのクラスで L4 を捌き、Claude の枠を温める"
  - label: "Claude の枠を先に"
    description: "Sonnet で L4 も捌き、ChatGPT の枠を軽い仕事に寄せる"
```

### 五、答えを型に写す

| Claude | ChatGPT | 型 |
|---|---|---|
| Free か、なし | なし | A-Free |
| Pro か Max | なし | A |
| Free か、なし | Plus | B |
| Free か、なし | Pro | C |
| Pro か Max | Plus | D |
| Pro か Max | Pro | E |

型は、説明の文と警告の出し分けに使う。
草稿の中身は型ではなく、次の「六」の決まりで顔ぶれから組む。

### 六、草稿を組む

顔ぶれの模型ごとに、次の決まりで値を決める。

1. クラスの Bloom の目安（`honden-model-list` の表）を `max_bloom` に置く。目安に幅（L5〜L6 など）があれば、低い側を置く
2. Q3a で先にしなかった側の、目安が L3 以下のクラスの `max_bloom` を一段下げる（L3 なら L2 へ）。振り先は軽い順に選ばれるので、下げた側には L3 が回らなくなる
3. Q3b で先にしなかった側の、目安が L4 のクラスの `max_bloom` を L3 へ下げる。L4 の仕事は、残った側の上のクラスへ回る
4. 目安が L6 のクラスは、載せなくても制限なしで同じ働きになる。`cost_group` を書きたい時だけ `max_bloom: 6` で載せる
5. クラス不明の模型は載せない。載せぬ模型は制限なし（L6）で振られるので、警告に出す
6. 表の鍵には、`honden roster` に出た模型の名をそのまま使う。値はクラスで決め、名は今の版に当てる
7. `cost_group` の名は、人が `available_cost_groups` に宣する名に揃える。草稿では置き字にしておく

出す形（置き字は人が埋める）:

```yaml
available_cost_groups:
  - <Claude の枠の名>
  - <ChatGPT の枠の名>

capability_tiers:
  <顔ぶれの Haiku クラスの模型の名>:
    max_bloom: 3        # Haiku: 分類、抜き出し、振り分け
    cost_group: <Claude の枠の名>
  <顔ぶれの Sonnet クラスの模型の名>:
    max_bloom: 5        # Sonnet: 日々の実装とレビュー
    cost_group: <Claude の枠の名>
  <顔ぶれの Luna クラスの模型の名>:
    max_bloom: 3        # Luna: 要約、抜き出し、狭い実装
    cost_group: <ChatGPT の枠の名>
```

註にはクラスと向く仕事だけを書く。
値段やベンチマークの数は書かない。

### 七、出す物

1. 型の説明（なぜこの組み方か、一、二文）
2. `available_cost_groups` と `capability_tiers` の草稿（写せる code block）
3. 差配の役の推し（クラスで書く）
   - 家老: 目安が L5 以上のクラス
   - 軍師: 顔ぶれの中で最も上のクラス（Fable、Opus、Astra、または Astra の無い世代の Sol など）
   - 役の模型を替えるのは `honden-model-switch` を通し、殿の裁可を取る
4. 隙の警告
   - 草稿を当てた後で、L1 から L6 の各段について、振れる働き手（`role` が worker）が一人も居ない段を挙げる。表に無い模型は L6 まで振れるとして数える
   - Q1 が Free かなしで、顔ぶれに目安 L6 のクラスが居ない時は「L6 に振れる者が居らぬ」と出す
   - クラス不明の模型が居れば「制限なしで振られる。人が目安を決めよ」と出す
5. 次の段（下の「八」）

### 八、人が当てる

草稿を当てるのは人である。

1. 人が `config/settings.yaml` の `available_cost_groups` と `capability_tiers` に草稿を写し、置き字を埋める
2. 正本へ移す

   ```bash
   honden roster sync --settings config/settings.yaml
   ```

   顔ぶれと制限の表が一度に移る
3. 各段に振れる者が居るかを確かめる

   ```bash
   honden route 1 --role worker
   honden route 4 --role worker
   honden route 6 --role worker
   ```

   段ごとに「足りる中で軽い順」に候補が出る。誰も出ない段が隙である

## 書かぬ物

- 値段、購読の段の値段、ベンチマークの数、版ごとの表。古くなるのが早く、各社の頁が正である
- 今の顔ぶれの決め打ち。`honden roster` が正である
- 考え（thinking）の切り替え。CLI と版ごとに口が違い、この表の役目ではない
