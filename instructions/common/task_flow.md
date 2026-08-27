# Task Flow

## Workflow: Shogun → Karo → Ashigaru

```
殿: 下知
  → 将軍: honden cmd new
  → 家老: honden task assign          （task_assigned が自ずと飛ぶ）
  → 足軽: honden report submit        （軍師の未読が自ずと増える）
  → 軍師: honden report qc            （判定が家老へ自ずと行く）
  → 家老: honden cmd done             （門あり・後述）
  → 将軍: honden cmd list / honden cmd show
```

殿の裁定を要するものだけが横へ抜ける。`honden decision raise`（上役だけ）で挙げ、
将軍が `honden decisions` で見て `honden decide <番号> "<選び>"` で下ろす。
挙げねば誰の目にも触れぬ。

各段の宛先は引数に無い。飛び越えようが無いゆえ、指示書の禁止事項でこれを守らせる要が無い。

## Status Reference (Single Source)

Status is defined per ledger table. **Keep it minimal. Simple is best.**

旧は YAML の種ごとに状態語が散らばっており、「勝手に増やすな」を散文で守らせていた。
正本を一つに寄せた今、表の CHECK が規定外の値を受けぬ。増やせぬゆえ、守らせる要が無い。

Fixed status set (do not add casually):

| 何の状態か | 在る値 | 見る所 |
|---|---|---|
| 司令 (`cmd`) | `pending` / `in_progress` / `done` / `failed` / `cancelled` | `honden cmd list` |
| 任 (`task`) | `idle`（振られておらぬ） / `assigned`（振られた） | `honden lease` / `honden status` |
| 報告 (`report submit`) | `done` / `failed` / `blocked` | `honden cmd show` |
| 検め (`report qc`) | `APPROVED` / `APPROVED_WITH_CONCERNS` / `CHANGES_REQUESTED` / `REJECTED` | `honden cmd show` |
| 個々の検査 (`checks[].result`) | `PASS` / `FAIL` / `WARNING` | `honden cmd show` |
| 裁定 (`decision`) | `open` / `decided` / `expired` / `withdrawn` | `honden decisions` |

Do NOT invent new status values. 弾かれるうえ、**書き込みは何も行われぬ**。
規定外を通したくなったなら、それは状態語が足りぬのではなく、
状態でないものを状態欄へ押し込もうとしておる。

### Command Queue: `cmd` 表

Meanings and allowed/forbidden actions (short):

- `pending`: まだ誰も受けておらぬ
  - Allowed: 家老が `honden cmd list` で見つけ、間を置かず `honden task assign` で振る
  - Forbidden: 受けたつもりで寝かせること。振らねば正本のどこにも跡が残らぬ

- `in_progress`: 受けて動いておる
  - Allowed: 分けて振る・集める・まとめる
  - Forbidden: ゴールを動かすこと。`honden cmd amend` は跡が残り、
    **文言が変わる前に集めた証拠は、変わった後の条件を覆っておらぬものとして数えられなくなる**
  - Forbidden: 条件を満たさぬまま閉じること。`honden cmd done` が門で弾く

- `done`: 覆われ、検められた
  - Allowed: 読むだけ（`honden cmd show <id>` / `honden cmd list --all`）
  - Forbidden: 閉じた司令を書き換えて開け直すこと。`cmd amend` が弾く
    （「閉じた司令を書き換えても誰にも届かぬ」）。新しい司令を書け

- `cancelled`: 意図して止めた
  - Allowed: 読むだけ
  - Forbidden: この司令の下で仕事を続けること。新しい司令を書け

**家老の掟（受けたら間を置かず）**——旧は「読んだ瞬間に `pending → in_progress` へ進めよ、
さもなくば『誰も動いておらぬ』の混乱が起き escalation の見立てが揺れる」であった。
honden で受けた印になるのは**振ること**である。振れば task 表と貸与が動き、
`honden status` に「誰が・何を・いつまで」が出る。混乱の元であった
「見えぬまま時が経つ」が、そこで消える。

### Archive Rule

旧は終端の cmd を archive YAML へ**手で積み替え**させ、
その積み替え漏れを防ぐために正規の状態語一覧まで置いていた。
honden では積み替えぬ。`honden cmd list` が既定で `pending` と `in_progress` だけを出す。

| Status | 既定の一覧に出るか | Action |
|---|---|---|
| pending | YES | 何もせぬ |
| in_progress | YES | 何もせぬ |
| done | NO | 何もせぬ（`--all` で出る） |
| cancelled | NO | 同上 |
| failed | NO | 同上 |

済んだものも辿るなら `honden cmd list --all`。個別は `honden cmd show <id>`。

積み替えを人にさせると、忘れた分だけ一覧が濁る。絞り込みなら忘れようが無い。
**掟を人の手数で守らせておったものは、問いの側へ移せば守る要が消える。**

### Ashigaru Task File: `task` 表と貸与

任は YAML では来ぬ。見る口は三つである。

```bash
honden inbox read     # task_assigned の報せ（本文に何をする仕事かが載る）
honden lease          # 自分がいま何を握っておるか・期限はいつまでか
honden status         # 布陣ぜんたい（差配役が見る）
```

Meanings and allowed/forbidden actions (short):

- `assigned`: 始めよ
  - Allowed: 当人が work し、`honden report submit` で納める（`done` / `failed` / `blocked`）
  - Forbidden: 他の者の任に触れること。`report submit` は
    **自分がいま握っておる task_id 以外を弾く**（旧の「他の足軽の YAML を編集するな」を
    番号の照合へ置き換えたもの）

- `idle`: 何も握っておらぬ
  - 旧の placeholder（`task_id: null`）に当たる。表の既定がこれである
  - 「振られておらぬ」であって「手すき」とは限らぬ。pane が居らぬ者は
    `honden status` に**不在**と出る。居らぬと手すきは別物である

報告の status は任の状態とは別である。納める時の三語の意味:

- `done`: 覆った受け入れ条件を**証拠つきで**挙げよ
  - Forbidden: 「済」「OK」だけを並べること。形だけの通過は弾かれる。
    一つも覆っておらぬなら `blocked` か `failed` が正しい
  - 納めれば持ち場と worktree を自ずと手放す
- `failed`: 理由と、詰まりを解く手立てを summary へ書け
  - Forbidden: 黙って倒れること
  - 納めれば持ち場と worktree を自ずと手放す
- `blocked`: 着手したが進めぬ
  - **持ち場は握ったまま残る**——まだ仕掛かっておるゆえ
  - 旧の `blocked`（「前提が無いのでまだ始めるな」）とは別物である。
    始める前の話は下の Pending Tasks を見よ

やり直しで task_id を使い回すこと: 使い回しようが無い。番号は honden が自ら振り、
同じミリ秒に二件振っても別の番号になる（同じ番号にすると二件目が丸ごと落ちる筋があった）。

### Pending Tasks (Karo-managed)

置き場の表は無い。**前提が揃わぬ仕事を先に振るな。**
振れば持ち場が貸与で塞がり、期限が切れるまでその者へ別の仕事が振れぬ。

- Allowed: 前提が済んだ所で `honden task assign` を撃つ
- Forbidden: 揃う前に振っておいて「まだ始めるな」と言い添えること

揃うまでは司令の側に置いたままにせよ。`honden cmd show <id>` に受け入れ条件と、
どこまで覆っておるかが出る。何が済めば振れるのかは、そこで見る。

## Immediate Delegation Principle (Shogun)

**Delegate to Karo immediately and end your turn** so the Lord can input next command.

```
殿: 下知 → 将軍: honden cmd new → END TURN
                        ↓
                  殿: 次の下知を打てる
                        ↓
              家老／軍師／足軽: 背後で動く
                        ↓
              家老: honden cmd done ／ 裁定要は honden decision raise
```

将軍は戻ってきたものを `honden cmd list` と `honden decisions` で見る。
殿が在席の間、家老から将軍への inbox は塞がっておる——**殿がいま打ち込んでおる最中を潰さぬため**である
（protocol.md の Report Flow）。

## Event-Driven Wait Pattern (Karo)

**After dispatching all subtasks: STOP.** Do not launch background monitors or sleep loops.

```
振る:   cmd_N を分けて honden task assign        （task_assigned が自ずと飛ぶ）
見回る: honden cmd list → 未着手の司令があれば処理し、然る後 STOP
  → 家老は待機（prompt waiting）
返る:   足軽が honden report submit → 軍師が honden report qc
  → 判定が家老の inbox へ入る
  → 家老が起き、honden inbox read → honden cmd show で見て動く
```

**Why no background monitor**: 常駐の芯が正本の変化に気づいて `honden nudge` を撃ち、
急ぎならどの副命令の出力にも一行が横乗せされる（protocol.md）。
これが真の event-driven である。sleep も polling も要らぬ。

**Karo wakes via**: 軍師の検め、将軍の新しい司令、系の出来事。それ以外は無い。

## "Wake = Full Scan" Pattern

Claude Code cannot "wait". Prompt-wait = stopped.

1. 足軽へ振る
2. 「ここで止める」と言うて処理を終える
3. 軍師の検めが inbox で起こす
4. **報せて来た一件だけを見るな。**動いておる司令を全部通せ——
   `honden cmd list` → 気になるものを `honden cmd show <id>`。
   覆い・未達・検め待ちが一枚で出る
5. 見立ててから動く

## Report Scanning (Communication Loss Safety)

起きたときは理由を問わず、`honden cmd list` を通し、動いておる司令の
`honden cmd show <id>` を見よ。検めを待っておる報告がそこに並ぶ。

**Why**: 旧は報告が YAML に書かれても報せが遅れ、誰も知らぬまま止まる筋があった。
ゆえに報告ファイルを舐めることが安全網だった。honden では報告の書き込みと
軍師の未読が**同じ取引の中に入っており**、書いたのに誰も知らぬ状態が作れぬ。
それでも全体を通すのは別の理由による——**報せて来たものだけを見ると、
来なかったものが永久に見えぬ**ゆえである。

## Foreground Block Prevention (24-min Freeze Lesson)

**Karo blocking = entire army halts.** On 2026-02-06, foreground `sleep` during
delivery checks froze karo for 24 minutes.

**Rule: NEVER use `sleep` in foreground.** 振ったら止めて、起こされるのを待て。

| Command Type | Execution Method | Reason |
|---|---|---|
| Read / Write / Edit | Foreground | Completes instantly |
| `honden` の副命令 | Foreground | 正本を一度引くだけ。すぐ返る |
| `sleep N` | **FORBIDDEN** | inbox の event-driven を使え |
| tmux capture-pane | **FORBIDDEN** | `honden status` で見よ。手で pane を写すと自己観察の輪に入る |

### Dispatch-then-Stop Pattern

```
✅ Correct (event-driven):
  cmd_008 を honden task assign → 止まる（起こされるのを待つ）
  → 足軽 honden report submit → 軍師 honden report qc
  → 家老が起きる → honden inbox read → honden cmd show cmd_008

❌ Wrong (polling):
  honden task assign → sleep 30 → honden status → sleep 30 → …
```

## Timestamps

**正本の時刻は honden が刻む。**手で書く要は無く、書く口も無い。
人へ見せる文・commit・覚え書きに要るときだけ `date` を使え。**推測するな。**

```bash
date "+%Y-%m-%d %H:%M"       # 人に見せるとき
date "+%Y-%m-%dT%H:%M:%S"    # ISO 8601（正本と揃う形）
```

## Pre-Commit Gate (CI-Aligned)

Rule:

- 出す前に、同じ検めを手元で通す
- 通ってから commit する
- `git push` の前は殿へ伺いを立てる

Minimum local checks:

```bash
bun test           # 試験
bunx tsc --noEmit  # 型
```

**旧に在った「指示書の生成物がずれておらぬか」の検めは、honden には無い。**
旧は部品を組んで `instructions/generated/{cli}-{role}.md` を吐いており、
「build を忘れた」と「生成物が部品とずれた」の二軸を別々に見張る要があった。
honden は**出す時に組む**（`honden brief [--role X] [--cli Y]`）。生成物が無い。
無いものはずれぬ。代わりに要るのは「部品が欠けておらぬか」だけで、
これは組み立てが空を返さぬかで分かる。

この task_flow.md も、その部品の一枚である。
