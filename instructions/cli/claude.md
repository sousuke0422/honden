# Claude Code Tools

This section describes Claude Code-specific tools and features.

## Tool Usage

Claude Code provides specialized tools for file operations, code execution, and system interaction:

- **Read**: Read files from the filesystem (supports images, PDFs, Jupyter notebooks)
- **Write**: Create new files or overwrite existing files
- **Edit**: Perform exact string replacements in files
- **Bash**: Execute bash commands with timeout control — this is also how `honden` is called
- **Glob**: Fast file pattern matching with glob patterns
- **Grep**: Content search using ripgrep
- **Task**: Launch specialized agents for complex multi-step tasks
- **WebFetch**: Fetch and process web content
- **WebSearch**: Search the web for information

## Tool Guidelines

1. **Read before Write/Edit**: Always read a file before writing or editing it
2. **Use dedicated tools**: Don't use Bash for file operations when dedicated tools exist (Read, Write, Edit, Glob, Grep). Bash is for running commands — `honden` chief among them
3. **Parallel execution**: Call multiple independent tools in a single message for optimal performance
4. **Avoid over-engineering**: Only make changes that are directly requested or clearly necessary
5. **正本 is not a file**: 司令・任・報せ はことごとく SQLite 一つ（`~/.honden/honden.db`）に在る。`queue/*.yaml` も `dashboard.md` も**無い**。Read や Grep で探すな。`honden` で引け。探して見つからぬのは、消えたのではなく最初からそこに無いゆえである

**急ぎの報せは向こうから来る。** `honden` のどの副命令の出力にも `⚠ 急ぎの未読` の一行が横乗せされる。見えたら手を止めて `honden inbox read` せよ。

## Task Tool Usage

The Task tool launches specialized agents for complex work:

- **Explore**: Fast agent specialized for codebase exploration
- **Plan**: Software architect agent for designing implementation plans
- **general-purpose**: For researching complex questions and multi-step tasks
- **Bash**: Command execution specialist

Use Task tool when:
- You need to explore the codebase thoroughly (medium or very thorough)
- Complex multi-step tasks require autonomous handling
- You need to plan implementation strategy

## 覚えの持ち越し

**honden は Memory MCP を使っておらぬ。** 正本は SQLite 一つで、repo 内に MCP の
設定は無い。セッションを跨いで残すものは、それぞれ置き場が決まっておる:

| 残すもの | 置き場 |
|---|---|
| 何を決め、なぜそう決めたか | `docs/decisions.md`（追記のみ。消さぬ） |
| 誰が何をしたか | 台帳（`honden` が自ずと刻む） |
| 役の作法・禁じ手 | `instructions/` の部品（`honden brief` が組んで出す） |
| 殿の裁可を待つもの | `honden decision raise` → `honden decisions` |

**「この CLI には Memory MCP が無い」と書くな。** 手で構成すれば全 CLI で動き、
違うのは呼び名だけである（Claude: `mcp__memory__read_graph` /
Cursor: `mcp_memory_read_graph` / Codex: `mcp__memory.read_graph`）。
能力の差と構成の差を取り違えた記述が一度出回り、殿の確定で正された。
honden が使っておらぬのは「無いから」ではなく、**正本を一つに寄せたから**である。

## Model Switching

Ashigaru models are set in the environment's `settings.yaml` and applied at startup.
正本はそれを `honden roster sync --settings <settings.yaml>` で写し取る。写した後は:

```bash
honden roster                  # 誰がどの CLI・どのモデルで座っておるか
honden route 4 --role worker   # L4 を振れる者（足りる中で軽い順）と、切り替えれば足りる者
```

Runtime switching is rarely needed (Gunshi handles L4+ tasks instead).

**honden の inbox に `model_switch` の種別は無い。** 受け取り手が処理を知っておる種別は
`report_received` / `report_completed` / `task_assigned` / `cmd_new` / `cmd_update` /
`clear_command` / `guard_appeal` / `guard_grant` の八つのみ。新しい文字列を発明すれば相手は黙り込む。
モデルを真に差し替えるなら、それは環境の `settings.yaml` を書き換えて `honden roster sync` を打ち直す仕事であって、報せで済ませるものではない。

For Ashigaru: You don't switch models yourself. Karo manages this.

## /clear Protocol

For Karo only: send a context reset to ashigaru:

```bash
honden inbox write --to ashigaru{N} --type clear_command --from karo \
  --body "任を確かめ、作業を始めよ。"
```

`clear_command` は**上役（commander）だけが撃てる**。足軽から足軽へは撃てぬ——相手の文脈が消えるゆえ、やり直させたいなら家老へ回し、新しい任として振り直すのが常道である。布陣の外（`TMUX_PANE` が無い所）からも撃てぬ。

`clear_command` は急ぎの種別ゆえ、受け手のどの `honden` 出力にも `⚠ 急ぎの未読` として載る。**受け手が自分で `/clear` を打つ。** 別筋として、沈黙が続けば `honden nudge` の段が上がり、三段目で CLI ごとの文脈消しが自動で飛ぶ（claude・copilot・kimi は `/clear`、cursor は `/new-chat`、codex・opencode と未知の CLI は `/new`——codex は `/clear` で CLI ごと落ちるゆえ）。

For Ashigaru: After `/clear`, recover with 名乗り → `honden inbox read` → `honden lease`。
Do NOT run `honden brief` for the first task (cost saving)。task_assigned の報せと lease に要るものは載っておる。

## Compaction Recovery

All agents: Follow the Session Start / Recovery procedure. Key steps:

1. Identify self: `tmux display-message -t "$TMUX_PANE" -p '#{@agent_id}'`
   （`honden` も同じ pane の `@agent_id` から名乗りを取る。**pane の番号で自分を数えるな。**食い違えば `honden` が「名乗りが食い違っておる」と言う。黙って片方を採ってはならぬ）
2. `honden brief` — 指示書はこれで出る。**生成物は無い**（役は名乗りから、CLI は名簿から引く。`--role X` で明示もできる）
3. Rebuild state from the 正本: `honden inbox read` → `honden lease`（自分の持ち場と期限）→ `honden cmd show <cmd_id>`（受け入れ条件と覆い具合）。読んだ報せはすぐ `honden inbox ack --all` で既読にする（着手の印。処理は ack の後。ack は「読んだ」であって「済んだ」ではない）
5. Review forbidden actions, then start work
   （禁じ手は `honden brief` の common/forbidden_actions.md に載る。撃つ前に迷えば `honden guard check --cmd '<命令>'`。門に弾かれたなら `honden guard appeal --cmd '<命令>' --reason "…"` で直訴せよ。自分で迂回するな）
