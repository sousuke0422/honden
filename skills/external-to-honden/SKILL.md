---
name: external-to-honden
user-invocable: true
description: |
  布陣の外（standalone セッション）から honden の inbox へ報せを送る手順。
  旧 external-to-shogun の後継。honden が名乗り・本文・書き戻しを引き受けるので、
  手順は 6 段から 3 段に縮む。
  「将軍に送って」「家老へ転送」「inbox で伝えて」「レビュー結果を将軍へ」
  「布陣外から送信」「external-to-honden」で起動。
  Do NOT use for: **稼働中の将軍環境（multi-agent-shogun の本番布陣）への送信**
  — そちらは inbox_write.sh が正本ゆえ、旧 external-to-shogun を使え。
  布陣内エージェント同士の通常の報告（CLAUDE.md の Report Flow に従え）、
  稼働状態の確認（honden lease を直に叩け）。
allowed-tools: Bash
argument-hint: "[target] [message]"
compatibility: |
  honden の CLI が要る。bun があれば `bun src/main.ts`、焼いてあれば `bin/honden`。
  正本の場所は `HONDEN_DB`（既定 ~/.honden/honden.db）。
metadata:
  author: aki
  version: 1.0.0
  # まだ置き換えてはいない。将軍環境が honden へ移るまで両方が現役。
  supersedes: none
---

# external-to-honden — 布陣外から inbox へ送る

## North Star

**送った内容が、送ったとおりに、正しい送信者名で、確実に相手の inbox に載ること。**

旧版と同じ。変わったのは、その保証を**手順ではなく型が担う**ようになったこと。

## 旧版の 6 段が 3 段になった理由

旧 `external-to-shogun` は、`inbox_write.sh` が壊す文字を手順で避けていた。
honden ではその壊れ方が構造的に起こらないので、避ける手順が要らなくなる。

| 旧版の段 | honden では |
|---|---|
| Step 0 自己識別を疑う | **CLI が環境から取る**。`TMUX_PANE` が空なら布陣外として扱い、役職を騙れない |
| Step 1 布陣の状態を確認 | `honden roster` / `honden lease` |
| Step 2 宛先・type・送信者を決める | **CLI が検める**。名簿に無い宛先も、知らぬ type も、騙りも弾く |
| Step 3 本文を事前検査 | **不要**。EOF はシェルが触らぬ |
| Step 4 送信 | `honden inbox write` |
| Step 5 読み戻して検証 | **CLI が自動で返す**。出すのは渡した値ではなく正本の値 |
| Step 6 手動 nudge を通知 | 送信の出力に未読数が載る。`honden inbox unread` でも引ける |

---

## 使う前に — 将軍環境へは使うな

honden の正本と、稼働中の将軍布陣の `queue/inbox/*.yaml` は**別物**である。
honden へ書いても将軍配下の足軽は読まぬし、watcher も動かぬ。

| 送り先 | 使うスキル |
|---|---|
| 稼働中の将軍布陣（multi-agent-shogun） | **`/external-to-shogun`**（旧版・`inbox_write.sh` が正本） |
| honden の環境（本番・試験とも） | このスキル |

**迷ったら旧版を使え。** 将軍環境へ honden で送ると、
エラーも出ずに「送れた」と表示されたまま、誰にも届かない。
honden への切り替えが済むまで、この分岐は残る。

---

## 段 1: どの環境か決める

正本は環境ごとに違う。**間違った環境へ送ると、誰にも届かないまま成功する。**

```bash
export HONDEN_DB=/home/aki/.honden/honden.db   # 本番
# export HONDEN_DB=/home/aki/.honden-test/honden.db   # 試験（scripts/testenv.sh が立てる陣）

honden roster
```

名簿が出なければ、その環境はまだ起きていない。

```
名簿が空である。
  honden roster sync --settings <settings.yaml> で入れられよ。
```

## 段 2: 送る

**短い用件は旗で。長い本文は EOF で。**

```bash
honden inbox write --to karo --from review_session --type report_received \
  --body "レビュー結果" --dry-run
```

```bash
honden inbox write --dry-run <<'EOF'
to: karo
from: review_session
type: report_received
body: |
  長い本文。C:\Users\… も ''' も $HOME も \n も、そのまま通る。
EOF
```

`--dry-run` を外せば書き込む。**まず dry-run で読み取り結果を見るのが安い。**

### 差出人の名

**布陣の外から役職を騙れない。** `TMUX_PANE` が無ければ CLI が弾く。

```
布陣の外から gunshi を名乗ることはできぬ。
  布陣外だと分かる名を使われよ (review_session / external_audit / probe_session など)。
```

外だと分かる名を使う。`review_session` / `external_audit` / `probe_session`。

### type

相手が処理を知っているものだけ。発明すると相手が黙り込む。

`report_received` / `report_completed` / `task_assigned` / `cmd_new` / `cmd_update` / `clear_command` / `guard_appeal` / `guard_grant`

**`clear_command` は布陣の外から撃てない。** 相手のセッションを消すため。

## 段 3: 届いたことを確かめる

送信の出力が、そのまま確認になる。**出しているのは渡した値ではなく、正本に入っている値。**

```
  宛: karo  差出: review_session  種: report_received  未読: はい
  本文 31 文字 / 2 行（渡した本文と一致）
  C:\Users\aki と ''' と $HOME
  → msg_20260826…
  karo への合図: inbox_notice unread=1 report_received=1 urgent=0
```

最後の一行が**そのまま手動投入の文字列**になる。watcher が送る合図と同じ形ゆえ、
相手の受け取り方も同じになる。

反応が無いときは、自分で再送を重ねない。同じ内容が積まれるだけで、届かない原因は解けない。
未読数を数えて**人に手動投入を促す**。

```bash
honden inbox unread karo
#   karo: inbox_notice unread=1 report_received=1 urgent=0
```

---

## 断られたときの読み方

CLI は「駄目だ」ではなく「何が・どう駄目で・どう直すか」を返す。
**落ちたものは全部並ぶ**ので、1 つずつ直して往復する必要はない。

```
受け付けられぬ点が 3 件ござる。直して再度お試しくだされ。

  ● to: 取りうる値の外
      受け取った値: "karou"
      shogun / karo / gunshi / ashigaru1 / ashigaru2 のいずれか。近いのは karo
  ● type: 必須の項目が無い
  ● body: 必須の項目が無い

  書き込みは行っておらぬ。同じ命令をそのまま直して撃ち直してよい。
```

**「書き込みは行っておらぬ」が出ていれば、半端に入っている心配は要らない。**
そのまま直して撃ち直せる。

終了コードは `0` 通った / `2` 入力が受け付けられぬ / `1` それ以外。

## 完了報告に書くこと

- メッセージ ID・宛先・type・送信者・文字数
- 送った先の環境（`HONDEN_DB`）
- 相手の未読数（いつ読まれる見込みか）
- 送らなかった項目があるならその旨

## 旧版との違いで、注意が要るところ

**旧版は本文を書き換えて回避することがあった**（Windows パスを `/mnt/c/…` に直す等）。
honden では要らない。**書き換えたら、それは別の本文になる。**

**旧版の Step 3（事前検査）を残してはならない。** 残すと、通るはずの本文を
避け続けることになる。
