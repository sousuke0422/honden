# Communication Protocol

## Mailbox System (honden inbox write)

Agent-to-agent communication goes through the one ledger (`~/.honden/honden.db`).
正本は一つで、`queue/inbox/*.yaml` へ**書き戻す道は無い**
（書き手が二人になれば、どちらが正か分からなくなる）。
読む側は `honden import` で旧環境の YAML を取り込める——影として入り、実運用の行を上書きせぬ。

```bash
honden inbox write <target_agent> "<message>" <type> <from>
# 旗でも同じ
honden inbox write --to <target> --type <type> --from <from> --body "<message>"
```

並び順は旧 `inbox_write.sh` と同じにしてある。既存の呼び出しと手癖がそのまま生きるゆえ。
長い本文は EOF 側が向いておる——シェルが引用符に手を入れぬ。

```bash
honden inbox write <<'EOF'
to: karo
from: shogun
type: cmd_new
body: |
  cmd_048を書いた。実行せよ。
EOF
```

並び順・旗・標準入力は、どれか一つを使う。二つ以上渡すと弾かれる。
黙って片方を優先すると、どちらが効いたのか撃った側に分からぬゆえ。

Examples:
```bash
# Shogun → Karo
honden inbox write karo "cmd_048を書いた。実行せよ。" cmd_new shogun

# Ashigaru → Gunshi
honden inbox write --to gunshi --type report_received --from ashigaru5 \
  --body "足軽5号、任務完了。品質チェックを仰ぎたし。"

# Karo → Ashigaru
honden inbox write --to ashigaru3 --type task_assigned --from karo \
  --body "任を受けよ。honden inbox read で読め。"
```

`type` は相手が処理を知っておるものだけ。新しい文字列を発明すると相手が黙り込む。
在るのはこれだけである:

`report_received` / `report_completed` / `task_assigned` / `cmd_new` / `cmd_update` /
`clear_command` / `guard_appeal` / `guard_grant`

Delivery is handled by the resident watch, which calls `honden nudge`.
**Agents NEVER call tmux send-keys directly.**

名簿が空のままでは送れぬ。誰が居るのか分からぬまま送ることはできぬゆえ、
まず `honden roster sync --settings <settings.yaml>` で入れること。

### Who may send what

指揮系統は散文ではなく、宛先の検めとして道具に置いてある。

- **足軽 → 将軍は通らぬ**（`src/cli.ts` の routing が塞ぐ）。軍師へ回せ: `honden report submit`。
  軍師が検め、家老が裁く。
- **足軽 → 足軽も通らぬ。** 足軽同士の調整は家老の役目である。重なりを見つけたなら
  `honden peek <agent> --reason "…"` で検めよ——家老へは自ずと報せが行く。
- **`clear_command` を撃てるのは上役だけ**（shogun/karo/gunshi）。相手の文脈が消えるゆえ。
  やり直させたいなら家老へ回し、新しい仕事として振り直すのが常道である（Redo Protocol）。
- **家老 → 将軍は、殿が在席の間は開けておらぬ**（後述の Report Flow）。
- **布陣の中では、`from` が pane の名乗りと一致しておらねばならぬ。**
  名乗りを引数に任せると、名乗りは検査にならぬ——足軽3号が karo を名乗れてしまう。
  名乗りは pane の `@agent_id` から引く。pane 番号（`honden-agents:agents.N`）で相手を呼ばぬこと。
- **布陣の外（`TMUX_PANE` が無い）からは役職を騙れぬ。** `review_session` /
  `external_audit` のような、外だと分かる名を `from` に使え。
  外から `clear_command` は撃てぬ。

## Delivery Mechanism

Two layers:

1. **Message persistence**: `honden inbox write` は正本へ取引の中で入れる。Guaranteed.
   書いた行を読み戻して、宛 / 差出 / 種 / 未読 / 本文の文字数と行数 /
   渡した本文と一致するか、を撃った側へ見せる。別に着信確認を取る要は無い。
2. **Wake-up signal**: 二つの経路がある。

   - **優先度1 — 横乗せ (ride-along)**: どの副命令の出力にも、呼び出し主に急ぎの未読が
     あれば一行だけ載る。

     ```
       ⚠ ashigaru3 に急ぎの未読（cmd_update=1）— honden inbox read で確かめよ
     ```

     これが**急報の全 CLI 共通の第一経路**である（殿裁定 2026-08-27）。
     どの CLI も作業中にツールとして honden を叩くゆえ、出力に一行添えれば
     仕掛かりを捨てさせずに届く。send-keys の届き方は CLI ごとにまちまちだが、
     この経路に CLI 差は無い。
     `inbox` 系（見に行く行為そのもの）と `nudge` には載せぬ。
     急ぎ（`clear_command` / `cmd_new` / `cmd_update` / `guard_appeal` / `guard_grant`）
     でなければ載せぬ——毎回うるさくすると読み飛ばしが癖になり、いざの一行まで死ぬ。

   - **優先度2 — push (`honden nudge`)**: 常駐の芯が正本の変化に気づき、短い合図を pane へ撃つ。

The signal is minimal:

```
inbox_notice unread=3 cmd_new=1 report_received=2 urgent=1
```

`inbox3` はもう使わぬ。3 は未読数だが足軽の番号も 1〜7 で同じ範囲になり、
「足軽 3 号」と読み違える事例が実際に出た。先頭を `inbox_notice` にして数を
key=value へ移せば衝突しようがない。type ごとの内訳が付くゆえ、開く前に
「いま手を止めるべきか」が判ずる。

**Agent reads the ledger itself** (`honden inbox read`).
Message content never travels through tmux — only the short wake-up signal.

急ぎの合図の後には、follow-up の確認キーを添え押しする。
cursor は `Enter`（もう一度押すと follow-up がステアリングになり、「完了まで待つ」が
「次のツール呼び出しで読む」へ変わる。作業は中断されぬ）。codex は `Tab`（仮置き。
布陣へ座らせた時に実測で校正せよ）。claude は押さずとも切りのいい所で読む。
押しても急報の第一経路は横乗せのままである。

Safety note (shogun):

- 撃たぬのは将軍が特別だからではない。**殿がいま打ち込んでおる最中を潰す**ゆえである。
  様態が `attended`（既定）の間、将軍の pane へは合図も立て直しも文脈消しも撃たぬ。
- 殿が席を外しておられる間は逆になる。家老が escalation を書けねば、裁ける者が誰も起きず、
  パイプラインが朝まで止まる。`honden mode autonomous --until 08:00` が
  家老→将軍の路と将軍への合図を**同時に**開く。片方だけ開くと、書けるのに誰も起きぬか、
  その逆になる。様態を切り替えられるのは将軍だけである。
- 「この一件だけ起こせ」は `honden nudge --wake-shogun --reason "…"`。
  効くのはその一回だけで、正本には何も残らぬ（様態は動かぬ）。台帳には別の名で残る。
  様態の切り替えで代用すると、戻し忘れが常態化する。

Special case:

- `type: clear_command` → 文脈を消させる報せ。上役だけが撃てる。受け取った側が自分で
  消す（claude/copilot/kimi `/clear`、codex/opencode `/new`、cursor `/new-chat`）。
  cursor に `/clear` は無い。

## Agent Self-Watch Phase Policy (cmd_107)

honden に watcher の旗による段階移行は無い。同じ狙い——読む費えを下げ、
素の合図を鳴らしすぎぬ——は、旗ではなく造りのほうで果たしてある。

- **第一経路が横乗せである**（上記）。push は初めから補助ゆえ、
  「素の合図を殺す」旗を置く要が無い。
- **未読 0 の周では重い読みへ入らぬ。** `honden nudge` は type ごとの件数を数える
  一問だけを引き、本文には触れぬ。
- **段は覚えず、時刻の差から毎回計算する。** 段を持つと、覚えと実際がずれた時に
  どちらが正しいか決まらぬ。覚えるのは「escalation のどこまで来たか」であって
  「何を撃ったか」ではない。
- 跡は台帳に残る（`nudge.L1` / `nudge.L2` / `nudge.reset` / `nudge.wake_shogun`）。

**Escalation** (when the signal is not processed):

| Elapsed | Action | Trigger |
|---------|--------|---------|
| 0〜2 min | 素の合図（`inbox_notice …`） | Normal delivery |
| 2〜4 min | 立て直しの合図 | copilot/kimi のみ Escape×2 + Ctrl-C を先に打つ。claude/codex/opencode/cursor は素の合図のまま |
| 4 min+ | 文脈を消させる（5 分に一度まで） | claude/copilot/kimi `/clear`、codex/opencode `/new`、cursor `/new-chat`。未知の CLI は `/new` へ倒す |

- 段が上がったなら間を置かずに撃つ。上がっておらぬなら 1 分は撃ち直さぬ。
- 文脈消しが冷ましで塞がれておる間は、段 2 の素の合図へ落とす。黙るのではない。
- 手が塞がっておる者への文脈消しは次の周へ延期する（codex は仕事中の `/new` を拒む・
  殿実測 2026-08-27）。延期の間も素の合図で叩き続け、reset の刻印は残さぬゆえ、
  手すきになった最初の周で文脈消しが届く。
- pane が見つからぬ者へは撃たぬ。布陣に居らぬか、`@agent_id` が付いておらぬ。

## 名乗りは系譜から引かれる

名乗りは環境変数ではなく、**tmux の pane から親を辿って**決まる
（`src/anchor.ts`）。`TMUX_PANE` や `HONDEN_AGENT_ID` を書き換えても変わらぬ。
書き換えた跡があれば、その旨が断りとして出る。

ゆえに:

- 己の pane から他人の名で送ることはできぬ。`--from` は己の名に限る
- 検分や外部監査で**布陣外の名**（`probe_session` / `external_audit` 等）を
  使う用は、**tmux の外**から行うこと。陣の中からは名乗れぬ
- 系譜を切って布陣外を装っても、権は得られぬ——布陣外では役職を振るえぬ

同じ OS ユーザで走る限りこれは堀であって城壁ではない。真の隔離が要る時は
LXC か systemd container を考える。

## Inbox Processing Protocol (karo/ashigaru/gunshi)

横乗せの一行が出たとき、または `inbox_notice unread=N …` を受け取ったとき:

1. `honden inbox read` — 自分の未読が出る
2. type ごとに処理する
3. `honden inbox ack --all` — 既読にする（id を並べて一件ずつでもよい）
4. Resume normal workflow

既読にできるのは自分のものだけ。他人の inbox を既読にすると、その相手は報せが来たことを
永久に知らぬ。自分のものでない id が混じっておれば、**一件も既読にせず**断る——
一部だけ通すと、どこまで済んだのか呼んだ側に分からぬゆえ。

読むだけは他人のものも許す（`honden inbox read --agent <名>`）。将軍や家老が様子を見る筋が
あるため。ただし覗いた跡は台帳に残り、覗いておる間は既読にできぬ。
見ることと、見たことにすることは違う。

### MANDATORY Post-Task Inbox Check

**After completing ANY task, BEFORE going idle:**

1. `honden inbox unread` — 未読の内訳を見る
2. 未読があれば `honden inbox read` して処理し、`honden inbox ack --all`
3. Only then go idle

This is NOT optional. If you skip this and a redo message is waiting,
you will be stuck idle until the next escalation or task reassignment.

## Redo Protocol

When Karo determines a task needs to be redone:

1. 家老が新しい任を振る。task_id は自ずと別のものになる。

   ```bash
   honden task assign --agent ashigaru3 --cmd_id cmd_713 --title "…（やり直し）" \
     [--workspace .worktrees/x] [--branch feat/y]
   ```

   重なれば振れぬ。前の持ち場が残っておるなら、先に
   `honden lease release <agent> --force --reason "…"` で手放させる。
2. 家老が `clear_command` を送る（`task_assigned` ではない）。振った時点で
   `task_assigned` は自ずと飛んでおる。

   ```bash
   honden inbox write --to ashigaru3 --type clear_command --from karo \
     --body "やり直しを振った。文脈を消して受け直せ。"
   ```
3. 受け取った足軽が自分で文脈を消す（claude/copilot/kimi `/clear`、
   codex/opencode `/new`、cursor `/new-chat`）→ session reset
4. Agent recovers via the Session Start procedure, reads the new task from
   `honden inbox read` と `honden lease`, starts fresh

Race condition is eliminated: 文脈消しが古い文脈を拭う。Agent は正本を読み直し、
新しい task_id を見つける。

## Report Flow (interrupt prevention)

| Direction | Method | Reason |
|-----------|--------|--------|
| Ashigaru → Gunshi | `honden report submit`（宛先は要らぬ） | Quality check。報告が入れば必ず軍師の未読が増える |
| Gunshi → Karo | `honden report qc`（宛先は要らぬ） | Quality check result。家老へ自動で行く |
| Karo → Shogun/Lord | `honden decision raise`。平時の inbox は塞がっておる | **inbox to shogun FORBIDDEN while attended** — prevents interrupting Lord's input |
| Karo → Gunshi | `honden inbox write` | Strategic task or quality check delegation |
| Karo → Ashigaru | `honden task assign` | 振れば `task_assigned` が自ずと飛ぶ |
| Top → Down | `honden inbox write` | Standard wake-up |

宛先は `report submit` / `report qc` の引数に無い。飛び越えようがないゆえ、
指示書の禁止事項でこれを守らせる要が無い。

**dashboard.md は無い。** 殿の裁定を要するものは decision へ挙げよ（上役だけ）。
挙げねば誰の目にも触れぬ。

```bash
honden decision raise <<'EOF'
question: 32 を入れ直すか
choices: ["いま入れる", "次の区切りまで待つ", "取り下げる"]
fallback: 次の区切りまで待つ
until: 08:00
EOF
```

開いておるものは `honden decisions` で出る。下ろすのは将軍だけ:
`honden decide <番号> "<選び>" [--note "…"]`。

殿が席を外しておられ、様態が `autonomous` の間は、家老 → 将軍の inbox も開く。
戻し忘れの害がまさにこの守りの防ごうとしているものゆえ、`--until` を付けて開けること。

## File Operation Rule

**Always Read before Write/Edit.** Claude Code rejects Write/Edit on unread files.

## Inbox Communication Rules

### Sending Messages

```bash
honden inbox write <target> "<message>" <type> <from>
```

**No sleep interval needed.** No delivery confirmation needed —
`inbox write` が書いた行を読み戻して見せる。続けて何通撃ってもよい。正本は取引で守られておる。

- `--dry-run` は読み取り結果だけ見せて書き込まない。並び順の取り違えはこれで確かめられる。
- `--db PATH` で正本の場所を差し替える（既定 `~/.honden/honden.db`）。
- 追い返されたときは、何が・どう駄目で・どう直すかが返る。落ちたものは全部並ぶ。
  「書き込みは行っておらぬ」と明言されるゆえ、半端に入ったかを確かめ直す要は無い。

### Report Notification Protocol

報せは別に要らぬ。`honden report submit` が軍師の未読を必ず増やす。
書いたのに誰も知らぬ状態を作らぬためである。

```bash
honden report submit <<'EOF'
task_id: subtask_1_x
status: done
summary: |
  何をしたか
acceptance:
  1: "cargo test → job 18 / service 195 / exit 0"
  3: "git log で push しておらぬことを確認"
EOF
```

`status: done` と報せるなら、覆った受け入れ条件を証拠つきで挙げよ。
**「済」だけの証拠は弾く。** 後から検める者が辿れぬゆえ。
一つも覆っておらぬなら `blocked` か `failed` が正しい。

納めれば持ち場と worktree は自ずと手放される（`blocked` は握ったまま——
まだ仕掛かっておるゆえ）。解かねば、その worktree が永久に握られたままになり、
次の仕事が振れなくなる。

軍師は `honden report qc` で検める。判定は家老へ自動で行く。
司令は、全条件が証拠つきで覆われ、軍師が是と言うまで閉じられぬ。
