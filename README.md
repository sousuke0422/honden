# honden

多エージェント運用の差配層。

`multi-agent-shogun` の後継として起こしたが、乗り換えではない。
軍勢はそのまま残し、配管だけを書き換える。

tmux の上に CLI エージェントを何体も並べ、SQLite の正本ひとつを介して働かせる。
受け渡し・キュー・見張り・門は、bash と YAML ではなく型と試験のある層に置いた。

---

## 始め方

### 要るもの

| | | |
|---|---|---|
| tmux | 3.0 以上 | 陣を組む |
| [Bun](https://bun.sh) | 1.2 以上 | CLI を建てる |
| Rust | 1.75 以上 | 芯（見張り）を建てる |
| `flock` `curl` `ps` | util-linux 等 | 生死の確かめと配り |

エージェントの CLI（Claude Code / Codex / Cursor / OpenCode など）は別途入れておく。
honden はそれらを起こす側で、中身は問わない。

### 建てる

```bash
git clone --recurse-submodules https://github.com/sousuke0422/honden
cd honden
bun install
bun run build:all                   # bin/ に 4 つ揃う
```

`build` だけなら CLI（`honden` / `honden-bot`）、`build:core` なら Rust の
二つ（芯 `honden-watch` と門の解析器 `honden-parse`）。cargo の産物は
`bin/` へ移す —— 出陣も門も `bin/` しか見ない。

上書きではなく**置き換える**。陣が立っている間、芯は自分の binary を掴んで
いるので `cp` は `Text file busy` で倒れる。`mv` なら名札を差し替えるだけなので、
走っている側は古い実体を持ったまま生き続け、次に立つときから新しくなる。

芯は依存ゼロで 350 KiB、解析器は 520 KiB。CLI は Bun ごと抱えるので 95 MiB。

### 顔ぶれを入れる

**名簿が空のままでは何も送れない。** 誰が何の CLI でどのモデルを使うかを
`config/settings.yaml` に書き、正本へ写す。

```bash
bin/honden roster sync --settings config/settings.yaml
bin/honden roster                                       # 入ったか確かめる
```

### 出陣

```bash
bash shutsujin_departure.sh              # 陣を組み、CLI を起こし、芯と窓と耳を立てる
bash shutsujin_departure.sh status       # 陣・芯・窓・門の生死
tmux attach -t shogun                    # 本陣（人が座る）
```

窓は `http://127.0.0.1:8788`。**撤収は人の手で** —— エージェントは
D006 によりセッションを畳めない。

---

## 何ができるか

| | 命令 | |
|---|---|---|
| 司令を出す | `honden cmd new` | 受け入れ条件つき。全条件が証拠で覆われるまで閉じられぬ |
| 任を振る | `honden task assign` | 持ち場が重なれば振れぬ（`claim`） |
| 報せる | `honden report submit` → `report qc` | 足軽 → 軍師 → 家老と自ずと流れる |
| 裁定を仰ぐ | `honden decision raise` / `decide` | 殿の裁可待ちは戦況の頭に出る |
| 戦況を見る | `honden dashboard [--serve]` | 生成物は作らぬ。読む時に組む |
| 様子を見る | `honden status` | 「不在」と「待機」を言い分ける |
| 起こす | `honden nudge` | 芯が正本の動きを拾って自ずと叩く |
| 報せを撃つ | `honden notify` | 卓上の通知＋ntfy。二度は撃たぬ |
| 携帯から受ける | `honden ntfy listen` | 殿が床から命じられる |
| 殿の task | `honden say` | 陣の司令とは別物。連続日数を数える |
| 門 | `honden guard check` | 危うい命を止め、直訴と手形で通す |
| 引く | `honden search` / `honden log` | 台帳と取り込んだ物を辿る |
| 切り戻す | `honden export --out` | 正本を旧環境の YAML へ吐く |

`honden help` で全部、`honden help <名>` で一つ。

---

## 通信の形

エージェント同士は直接つながらない。やり取りは正本を経由し、
変化を芯が拾って tmux 越しに起こす。**通信路は正本 1 つだけになる。**

```bash
honden inbox write karo "cmd_048 を書いた。実行せよ。" cmd_new shogun
honden inbox read                     # 自分宛の未読
honden inbox ack --all                # 読んだ分を既読に
```

起こす合図は短い。`inbox3`（未読 3 件）だけを送り、**本文は tmux を通らない**。
エージェントが自分で正本を読む。

これは決めであり、門でも支えている。他人のペインへ手を入れる tmux の副命令
（`send-keys` / `respawn-pane` / `paste-buffer` / `run-shell` など）は D014 で塞いである。
読む側（`capture-pane` / `list-panes`）は塞がない。

---

## 門（guard）

危うい命を止める層。二段で見る。

1. **紋様** —— D001〜D016。再帰的な削除、`git push --force`、`sudo`、
   `.gitignore` を迂回する `git add -f`、秘密鍵の読み出しなど。
2. **構文** —— Rust の解析器（brush-parser）で命を単位へ割る。
   `if`・`for`・`$()`・改行・`{ }` で紋様を跨がせない。
   **解けなかった命は通さない**（fail-closed）。

実物 14,131 通りで測って誤検知は零。それでも堀であって城壁ではない
—— 本当に隔てたければ LXC か systemd container を使う。

止められた側は直訴できる。

```bash
honden guard appeal --cmd "…" --reason "…"     # 配下が申し出る
honden guard grant --agent ashigaru3 --cmd …   # 将軍が一度きりの手形を切る
honden guard charter --agent … --repo … --uses 5 --ttl-min 60   # 許状（複数回）
honden guard denials                            # 同じ紋様が叩かれ続けておらぬか
```

`D001` `D006` `D007` `D008` は**手形でも通らない**。ここだけは絶対域とした。

---

## 携帯から（ntfy）

殿と陣の双方向。SSH も VPN も要らない。

| 向き | |
|---|---|
| 陣 → 携帯 | 裁可待ち・司令の完了・任の失敗・連続日数を撃つ |
| 携帯 → 陣 | 送った文が将軍の inbox へ「申し出」として入る |

```yaml
# config/settings.yaml
notify:
  ntfy:
    base: https://ntfy.example.org     # 省けば https://ntfy.sh
    topic: 長く推測しにくい名
```

合鍵は環境変数から取る（`NTFY_TOKEN`、または `NTFY_USER` と `NTFY_PASS`）。
**設定ファイルには書かない** —— honden は公開しているので、書けばいつか誰かが
そのまま押す。

> **topic は合鍵そのもの。** 知る者は誰でも読め、誰でも書ける。
> 短い名・ありふれた名は honden が起動時に戒める。
> `config/settings.yaml` は `.gitignore` で除外してある。

受け口は**来た文を司令として扱わない**。topic 一枚で届いた文には錨も素性の
確かめも門も通っていないので、将軍の inbox へ入れるだけにする。動くのは将軍で、
その手はすべて門を通る。宛先も将軍に固定してある —— 文で宛先を名乗れるように
すれば、合鍵一枚で足軽へ直に命じられることになる。

出陣は topic が設定されている時だけ耳を立てる。

---

## 殿の task（SayTask）

陣の司令とは別の、人ひとりの一覧。家老を通さない。

```bash
honden say                       # 残りと連続日数
honden say add <<'EOF'
title: 鍵の入れ替え
due: 2026-09-01
EOF
honden say done VF-003
honden say import --from <旧 tasks.yaml>    # 何度打っても同じ
```

済ませた日を連続に数える。**同じ日に二度は数えない** —— 数の嘘を作らないため。

---

## 設定

| | |
|---|---|
| `config/settings.yaml` | 顔ぶれ・CLI・モデル・報せの宛先。**追跡しない**（topic を含むため） |
| `~/.honden/honden.db` | 正本。`--db` か `HONDEN_DB` で移せる |
| `HONDEN_SESSION_SHOGUN` / `HONDEN_SESSION_AGENTS` | セッション名（既定 `shogun` / `multiagent`） |
| `HONDEN_TMUX_SESSION` | 芯の射程。将軍のセッションも含める |
| `HONDEN_DASHBOARD_PORT` / `HONDEN_DASHBOARD_HOST` | 窓の口（既定 8788 / 127.0.0.1） |

```bash
honden config                    # 在り処と上の段
honden config get notify.ntfy.topic
honden paths                     # 正本・合図・錠の道（一箇所で決めている）
```

---

## 困ったとき

| | |
|---|---|
| 合図が届かない | `shutsujin_departure.sh status` で芯を見る。`HONDEN_TMUX_SESSION` に将軍の陣が入っているか |
| 窓が開かない | 口が塞がっていないか（既定 8788）。`X-Honden` を返すのが自分の窓 |
| 携帯へ届かない | `honden notify --dry-run` で撃つ物を見る。topic が設定にあるか |
| 携帯から届かない | 耳の窓（`ntfy`）が陣に立っているか。topic が無ければ立たない |
| 名簿が空と言われる | `honden roster sync --settings …` を先に |
| 門に止められた | `honden guard appeal`。同じ紋様が続くなら `honden guard denials` で誤検知を疑う |
| 正本を壊した | `~/.honden/backups` に出陣ごとの写しがある |

`bun test`（単体）と `bats tests/`（出陣の書）で確かめられる。

---

## なぜ新しく起こしたか

上流の `yohey-w/multi-agent-shogun` は、作者自身が現状維持を宣言している。
2026-08-06 の README 追記で後継として案内されているのは `kagemusha` で、そちらは 10 体の軍勢を畳んで単一エージェントに寄せた設計になっている。

その結論は採らない。
軍勢は実際に成果を出しており、畳む理由がこちらには無い。

一方で、上流に追いつく先が無くなったことで bash と YAML を守る理由も消えた。
それがこのリポジトリの動機になる。

## 何を継ぎ、何を書き換えるか

| | |
|---|---|
| 継ぐ | `instructions/` の役割定義・禁止事項・報告と品質確認の流れ。文章なので移送費用がかからない |
| 継ぐ | tmux による多重化。動いているものを置き換える理由が無い |
| 書き換える | 受け渡し (inbox)・キュー・監視・フック。型と試験のある層へ |
| 借りる | `kagemusha` を submodule で pin。判断蒸留のループだけを使う |

## 動作モデル

出陣 (`shutsujin_departure.sh`) が組み上げる形。数値は桁で書く。実数は機体と
軍勢の数で動くので、比のほうが長持ちする。

```
                        SQLite の正本  ←── 全員がここへ書く
                             │
                        <正本>.signal  ←── 書いた者が触る
                             │ inotify
tmux server                  ▼
├─ session shogun      honden-watch（芯）── tmux send-keys ──┐
│   └─ main    bash → CLI（将軍）  ←──────────────────────────┤
└─ session multiagent                                        │
    ├─ agents  bash → CLI（家老・足軽 N・軍師） ←─────────────┘
    ├─ core    bash（輪）→ honden-watch      ← 合図の芯 (Rust)
    └─ viewer  bash（輪）→ honden dashboard  ← 戦況の窓 (Bun)
```

矢印は二種類ある。ツリーの枝は**親子**、`←──` は**合図**。合図は正本を経て
芯から出るので、親子とは向きも経路も違う。

ペインの数だけ bash が立ち、その上に CLI が 1 体ずつ乗る。セッション名は
既定で `shogun` / `multiagent`、`HONDEN_SESSION_SHOGUN` と
`HONDEN_SESSION_AGENTS` で変えられる。

エージェント同士は直接つながらない。やり取りは正本を経由し、変化を芯が拾って
tmux 越しに起こす。通信路は正本 1 つだけになる。

これは決めであり、門（`honden guard`）でも支えている。他人のペインへ手を入れる
tmux の副命令（`send-keys` / `respawn-pane` / `paste-buffer` / `run-shell` など）は
D014 で塞いである。読む側（`capture-pane` / `list-panes`）は塞がない。

芯の射程は `HONDEN_TMUX_SESSION` で切られる。出陣は将軍のセッションも含めて
渡す——含めないと将軍だけ合図の射程外になり、直訴も夜間の escalation も
静かに届かなくなる。

### 重さの比

| | 桁 | 数 |
|---|---|---|
| honden の芯 (Rust) | 単位 MiB | 1 |
| honden の窓 (Bun) | 数十 MiB | 1 |
| エージェントの CLI | 数百 MiB 〜 1 GiB 超 | 軍勢の数だけ |
| CLI が抱える MCP | 各 数十〜百 MiB | 1 体あたり 2〜4 本 |

**差配層は、差配される側より 2 桁小さい。** 実測では軍勢 9 体の陣で 0.7%
だった。この比は軍勢の数で動く——honden 側はほぼ一定なので、体数が減れば
比は上がる。ここから 2 つ出る。

1. honden 自身の軽量化に伸びしろは無い。効くのは常駐させる軍勢の数と、
   各 CLI が抱える MCP の本数のほう。
2. 旧環境がエージェントごとに立てていた watcher を芯 1 本に畳んだ利得は、
   バイト数ではなく**見張る対象の数**にある。1 本なら生死を 1 つ確かめれば済む。

### 常駐の作法

芯も窓も `while` の輪の中に置く。落ちたら立ち直る。ただし諦め方が違う。

どちらも `@honden` の印がある陣にしか接がない。印の無い同名セッションには
接がず、別の名で立てるよう促して止まる。

- **芯は諦めない。** 芯が黙ると合図が誰にも届かず、しかも静かに止まる。
  気づけない故障なので、立ち直り続けるほうが害が小さい。
- **窓は数回で諦める。** 窓の故障は「頁が開かない」として即座に見える。
  直らない失敗を数秒ごとに刷り続けても誰も救われないので、骸を残して止まる。
  残った窓が記録になる。

### 素性の確かめ方

名前で判断しない。`multiagent` という名のセッションが自分のものとは限らない。

| 確かめたいもの | 見るもの |
|---|---|
| この陣は自分のものか | セッションの `@honden`（値は repo の絶対パス） |
| 窓は生きているか | 応答の `X-Honden` ヘッダ |
| 芯は動いているか | 見張り先（`<正本>.signal`）でプロセスを絞る |

口が塞がっている・その名の window がある・HTTP が何か返す——どれも他人で
成立する。実際、旧環境から引き継ぐつもりだった番号には別のサービスが座って
おり、既定を隣へずらすことになった。

### 撤収

出陣は組めるが、撤収は組まない。エージェントは D006 によりセッションを
畳めないので、畳むのは人の手になる。窓や芯を止めたいときも同じ。

### 測り方

```
bash shutsujin_departure.sh status   # 陣・芯・窓・門の生死
```

プロセスツリーは tmux server を根に辿れば出る。`@honden` の印と
`<正本>.signal` で自分のものだけを絞れる。

## kagemusha との関係

submodule として pin し、fork しない。

kagemusha は kit として設計されていて、実体は kit の外に置く造りになっている
(`PROJECT_ROOT` / `SSOT_DIR` / `QUEUE_FILE` はすべて外を指す)。
写してよいファイルの一覧も `manifests/scaffold.tsv` にデータとして出ている。

こちらの scripts はその作法に沿って組み立てる。

### 借りるもの

- 訂正を材料にした判断蒸留 (訂正はモデルと承認者の差分そのものなので、信号が枯れない)
- 4 層構造 (注入は薄く、参照は深く。薄い正本には行数の予算を置く)
- 閾値で焚く仕組み (材料が薄い日にモデルを焚くと、足りないとは言わずにひねり出す)
- 昇格は人間だけが行う境界

### 借りないもの

- 単一エージェントという前提
- 承認キューを主たる門とする造り (こちらには家老と軍師がいる)

### 持ち込みで弱くならないための注意

kagemusha の `config.env.example` は `AGENT_FLAGS="--dangerously-skip-permissions"` を既定にしている。
cron から無人で走る便にこの旗が付くと、prompt 層の禁止事項が効かない場所を走ることになる。

この既定はこちら側で潰し、便ごとに必要な道具だけを `--allowedTools` で挙げる。

## .gitignore について

shogun から whitelist 方式をそのまま継承している。
`*` ですべてを除外し、公開してよいものだけを明示的に許可する。

追加するファイルは、許可行を足さない限り追跡されない。
`git add -f` で迂回してはならない。

## 名前

本殿。神の座す最奥の殿。

`honmaru` (本丸) とも迷ったが、日本語環境で刀剣乱舞と城郭観光に埋もれるため避けた。
`honden` は romaji では蘭語の「犬たち」と衝突するが、想定する読み手は日本語と英語のみなので採った。

## ライセンス

MIT。上流の `multi-agent-shogun` も `kagemusha` も MIT で揃っている。
