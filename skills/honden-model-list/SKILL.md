---
name: honden-model-list
user-invocable: true
description: |
  模型のクラス（Opus、Sonnet、Sol など）ごとの向き不向きと Bloom の上限の目安を示し、
  今の顔ぶれを honden roster から引いて、各者にクラスを添えて出す。
  「模型一覧」「どの模型が使える」「模型を比べて」「capability_tiers をどう書く」と言われた時に使う。
  Do NOT use for: 模型や CLI を実際に替える時（honden-model-switch を使え）。
  値段や購読の枠を調べる時（各社の公式の料金の頁を引け。この skill は載せない）。
allowed-tools: Bash, Read
---

# /honden-model-list（模型のクラスと今の顔ぶれ）

## 芯

模型の名は版ごとに変わるが、各社の **クラス**（同じ位置づけの模型の系）は版をまたいで残る。
この skill は向き不向きをクラスで述べ、版の表を持たない。
今の顔ぶれも書き込まず、使う時に `honden roster` から引く。
表に書き込んだ物は、模型が一つ増えるたびに古くなるからである。

値段、購読の段、枠の数、ベンチマークの数は載せない。
要る時は、下の出所の頁（各社の公式の文書）をその場で引く。

## 手順

### 一、今の顔ぶれを引く

```bash
honden roster
```

一行が一人で、名と役と CLI と模型が並ぶ。
模型の欄を下の「名からクラスへの写し」に掛け、各行にクラスと Bloom の目安を添えて出す。
様（待機か働きか）も要る時は `honden status` を併せて引く。

### 二、制限の表と突き合わせる

honden は `config/settings.yaml` の `capability_tiers` を **能力に制限のある模型の表** として読む。
表に無い模型は制限なし（L6 まで振ってよい）として扱う（`src/routing.ts` の `maxBloomOf`）。
任を振る時、その者の模型の `max_bloom` が任の Bloom に足りなければ、honden は振らずに断る（`src/dispatch.ts`）。

ゆえに、顔ぶれの模型がクラスの目安より上の段を持つと困る時だけ、`capability_tiers` に載せて `max_bloom` を下げる。
目安は出発点であって、決めるのは人である。
その布陣の任で試してから詰める。

### 三、出す形

```
名        役      CLI     模型                 クラス     Bloom の目安  capability_tiers
<名>      worker  claude  claude-<クラス>-…    Sonnet     L5            載っておらぬ（制限なし）
<名>      worker  codex   gpt-…-<クラス>       Sol        L5〜L6        max_bloom: 6
<名>      worker  cursor  composer-…           その他     人が試す      載っておらぬ（制限なし）
<名>      worker  <CLI>   <知らぬ名>           不明       -             載っておらぬ（制限なし）
```

クラスが不明の行は、目安を空けたまま「不明」と出す。推し量りで埋めない。
「その他」の行は、目安の欄に「人が試す」と出す。

## 名からクラスへの写し

模型の名の形でクラスを決める。
当てる前に、名を二段で整える。

1. `/` を含む名は、最後の段だけを残す。opencode の名は `provider_id/model_id` の形で、`/` が二つ入ることもある（`<provider>/<vendor>/<model>` など）。先頭の provider の名は、下の表の一行で使うので控えておく
2. 名の末に付いた努力の段と速さの印を、付いておるだけ落とす。cursor の名に付く印は `-none`、`-minimal`、`-low`、`-medium`、`-high`、`-xhigh`、`-max`、`-fast`、`-thinking` である

整えた名を下の表に、上の行から順に当てる。大文字と小文字は分けない。
どの形にも当たらぬ名は **クラス不明** とする。

| 名の形（整えた後） | クラス |
|---|---|
| 文を書かぬ模型（名に `embedding`、`image`、`tts`、`realtime`、`live` を含む物、`veo-*`、`lyria-*`） | 対象外（最初に当てる） |
| `claude-fable-*`、`claude-*-fable` | Fable |
| `claude-mythos-*`、`claude-*-mythos` | Mythos |
| `claude-opus-*`、`claude-*-opus` | Opus |
| `claude-sonnet-*`、`claude-*-sonnet` | Sonnet |
| `claude-haiku-*`、`claude-*-haiku` | Haiku |
| `gpt-*-astra` | Astra |
| `gpt-*-sol` | Sol |
| `gpt-*-terra` | Terra |
| `gpt-*-luna` | Luna |
| `gpt-*-mini` | mini |
| `gpt-*-nano` | nano |
| `gemini-*flash-lite*` | Flash-Lite（`flash` より先に当てる） |
| `gemini-*flash*` | Flash |
| `gemini-*pro*` | Pro |
| `composer-*` | その他（cursor の自前の模型） |
| `grok-*`、`cursor-grok-*` | その他（xAI の Grok） |
| `deepseek-*`、`glm-*`、`kimi-*`、`qwen*`、`minimax-*`、`mimo-*`、`longcat-*`、`muse-spark-*` | その他（opencode などで使える他社の模型） |
| `gpt-<版>` だけでクラスの語を持たぬ名 | 不明 |
| `gpt-*-codex*`、`codex-mini-*` | 不明（旧い codex 系。各社がクラスとしての文を出しておらぬ） |
| `auto` | 不明（cursor が呼ぶたびに模型を選ぶ。クラスが定まらぬ） |
| provider が `opencode-go` か `opencode` の名で、上のどれにも当たらぬ物 | その他（OpenCode Go と OpenCode Zen が出す模型） |

`claude-*-opus` の形（版がクラスの語より前に来る形）は、cursor の一覧に旧い模型として残っておる。
**その他** は、確かに在る模型だが既存のクラスへ写せぬ物を一括りにする。
その他の向き不向きと Bloom の目安は、確かな事が言えぬので、人が試して決める。
不明とは分けて扱う（不明は、名の形を知らぬ物である）。

この写しには限りが二つある。

- Anthropic は、名からクラスを推さず、Models API が返す `line` の欄を読むよう求めておる（models overview の頁）。名の形で当てるのは、鍵を持たずに読める近道にすぎない。迷えば `line` を見る
- OpenAI の Sol は、世代によって段が違う。5.6 の世代では最上位（flagship）で、6 の世代では Astra の下に入る。同じ世代の中での並びは Astra、Sol、Terra、Luna の順である

## クラスの向き不向き

向き不向きは各社の公式の位置づけの文に拠る。
Bloom の目安は、その文から引いた見立てであって、各社が出した数ではない。

### Anthropic（Claude Code）

| クラス | 公式の位置づけ | 向く仕事 | 向かぬ仕事 | Bloom の目安 |
|---|---|---|---|---|
| Fable | 「For demanding reasoning and long-horizon agentic work」 | 新しい設計、長い自律の仕事、難しい判じ | 量の多い軽い仕事（重さに見合わぬ） | L6 |
| Mythos | Fable と同じ性質で、検めを受けた organization だけが使える | Fable と同じ | Fable と同じ | L6 |
| Opus | 「For long-running agentic coding and knowledge work」 | 長く続く実装、調べ物、設計の検め | 一行の書き換えのような軽い仕事 | L6 |
| Sonnet | 「The best combination of speed and intelligence」 | 日々の実装、レビュー、差配 | 前例の無い大きな設計の決め | L5 |
| Haiku | 「For high-volume, latency-sensitive tasks such as classification, extraction, and routing」 | 分類、抜き出し、振り分け、定型の変換 | 原因の分からぬ不具合の追い、設計 | L3 |

出所: https://platform.claude.com/docs/en/about-claude/models/overview 、https://platform.claude.com/docs/en/about-claude/models/choosing-a-model

### OpenAI（Codex CLI）

| クラス | 公式の位置づけ | 向く仕事 | 向かぬ仕事 | Bloom の目安 |
|---|---|---|---|---|
| Astra | 「Our most capable model for complex work across code, apps, and research」 | 難しい設計、深い調べ物 | 量の多い軽い仕事 | L6 |
| Sol | 「Near-Astra performance for complex work at a lower cost than Astra」 | 複雑な実装、長く繰り返す仕事 | 世代の最上位を要する判じ（Astra の在る世代では） | L5〜L6 |
| Terra | 「balances intelligence and cost」 | 中ほどの実装と調べ | 前例の無い設計 | L4 |
| Luna | 「Our most efficient model for focused, high-volume tasks, including summarization, extraction, and focused coding」 | 要約、抜き出し、狭い範囲の実装 | 広い設計、原因の追い | L3 |
| mini | 版の札は「coding, computer use, and subagents」向けの小さい模型 | 下請けの細かい仕事 | 判じの重い仕事 | L3 |
| nano | 版の札は「simple high-volume tasks」向け | 定型の大量の仕事 | 判じの要る仕事 | L2 |

出所: https://developers.openai.com/codex/models 、https://developers.openai.com/api/docs/models 、https://developers.openai.com/api/docs/guides/model-selection
（mini と nano はクラスとしての公式の文が無く、版の札から引いた。目安は弱い。）

### Google（Gemini）

| クラス | 公式の位置づけ（最新の版の札） | 向く仕事 | 向かぬ仕事 | Bloom の目安 |
|---|---|---|---|---|
| Pro | 「Advanced intelligence, complex problem-solving skills, and powerful agentic and vibe coding capabilities」 | 難しい問いの解き、設計 | 量の多い軽い仕事 | L5〜L6 |
| Flash | 「engineered for long-horizon software engineering, autonomous agents, and complex enterprise workflows」 | 実装、自律の仕事 | 世代の最上位を要する判じ | L4〜L5 |
| Flash-Lite | 「Our fastest, most cost-effective … model for high-throughput execution」 | 大量の定型の処理 | 判じの要る仕事 | L3 |

出所: https://ai.google.dev/gemini-api/docs/models
（Gemini もクラスとしての公式の文は無く、各クラスの最新の版の札から引いた。Flash は版によって位置づけの幅が大きい。）

### cursor（cursor-agent）

cursor は、各社の模型と、cursor の自前の模型の両方を出す。
使える名は `cursor-agent --list-models` で挙がる。

- 各社の模型（Claude、GPT、Gemini など）は、名を整えてから上の表で既存のクラスへ写す
- 自前の模型の束（cursor の言う Cursor Models の pool）は、Composer と Grok から成る。どちらも「その他」とする
  - Composer の公式の位置づけ: 「Composer 2.5 is Cursor's own agentic model. It builds on Composer 2 with stronger intelligence on long agentic tasks」
  - 向き不向きと Bloom の目安は、人が試して決める
- `auto` は、呼ぶたびに cursor が模型を選ぶ。クラスが定まらぬので不明とする

出所: https://cursor.com/docs/models 、https://cursor.com/docs/models/cursor-composer-2-5

### opencode

opencode は、多くの provider の模型を同じ CLI で使う。
名は `provider_id/model_id` の形で、使える名は `opencode models` で挙がる。

- 各社の provider（openai、google など）の模型は、最後の段を上の表で既存のクラスへ写す
- **OpenCode Go** は、opencode の側の購読で、`opencode-go/` の provider として出る。各社の模型の束を含む
  - 既存のクラスに写る物（GPT の Luna など）と、写らぬ物（GLM、Kimi、DeepSeek、Qwen、MiniMax、MiMo、LongCat、Grok、Muse Spark など）が混じる
  - 写らぬ物は「その他」とし、人が試して決める
- `opencode/` の provider（OpenCode Zen）にも、各社の模型と、期間を限った無料の模型が並ぶ。同じく名を整えて当てる
- 手元の模型（LM Studio、llama.cpp など）を自前の provider の名で足せる。名は人ごとに違うので、写しの表には載せない。当たらねば不明である

出所: https://opencode.ai/docs/models/ 、https://opencode.ai/go
（含む模型の顔ぶれは変わる。今の顔ぶれは `opencode models` か公式の頁で確かめる。）

## Bloom の段

| 段 | 名 | 仕事の例 |
|---|---|---|
| L1 | 覚える | 写す、雛形を当てる |
| L2 | 分かる | 要約、説明、訳し |
| L3 | 当てはめる | 決まった型の実装、雛形の生成 |
| L4 | 分ける | 不具合の追い、レビュー、原因の切り分け |
| L5 | 値踏みする | 設計の検め、得失の判じ |
| L6 | 作る | 前例の無い設計、要件の組み立て |

## 書かぬ物

- 版ごとの表、値段、購読の段、枠の数、ベンチマークの数。古くなるのが早く、各社の頁が正である
- 今の顔ぶれの決め打ち。`honden roster` が正である
- 考え（thinking）の切り替えの手順。CLI と版ごとに口が違い、クラスの性質ではない
