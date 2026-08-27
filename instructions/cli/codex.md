# Codex CLI Tools

This section describes OpenAI Codex CLI-specific tools and features, as they stand under honden.

The 正本 is one SQLite file (`~/.honden/honden.db`). There is no `queue/*.yaml` and no `dashboard.md`.
Everything the old environment read off disk is now read through a honden subcommand.

## Tool Usage

Codex CLI provides tools for file operations, code execution, and system interaction within a sandboxed environment:

- **File Read/Write**: Read and edit files within the working directory (controlled by sandbox mode)
- **Shell Commands**: Execute terminal commands with approval policies controlling when user consent is required
- **Web Search**: Integrated web search via `--search` flag (cached by default, live mode available)
- **Code Review**: Built-in `/review` command reads diff and reports prioritized findings without modifying files
- **Image Input**: Attach images via `-i`/`--image` flag or paste into composer for multimodal analysis
- **MCP Tools**: Extensible via Model Context Protocol servers configured in `~/.codex/config.toml`

## Tool Guidelines

1. **Sandbox-aware operations**: All file/command operations are constrained by the active sandbox mode
2. **Approval policy compliance**: Respect the configured `--ask-for-approval` setting — never bypass unless explicitly configured
3. **SessionStart / PostCompact hook**: `.codex/hooks.json` が起動・resume・/new・圧縮の後に
   名乗りと作法を平文で注ぐ（実測で確かめた形である）。honden に `AGENTS.md` は無い——
   指示書は `honden brief` が出す
4. **Non-interactive mode**: Use `codex exec` for headless automation with JSONL output
5. **名乗りは pane から来る**: `.codex/hooks/session-start.sh` reads `@agent_id` off `$TMUX_PANE` and injects it.
   It is a determined fact, not a guess — do not re-derive it from `HONDEN_AGENT_ID` or from the task text.
   Inside the 布陣, pane wins over the environment variable; when the two disagree honden takes the pane and says so.

## Permission Model

Codex uses a two-axis security model: **sandbox mode** (technical capabilities) + **approval policy** (when to pause).

Note that neither axis is honden's 禁じ手の門. The gate is a separate PreToolUse hook — see **Guard Gate** below.
A command the sandbox would happily run can still be denied by the gate, and the sandbox cannot lift that denial.

### Sandbox Modes (`--sandbox` / `-s`)

| Mode | File Access | Commands | Network |
|------|------------|----------|---------|
| `read-only` | Read only | Blocked | Blocked |
| `workspace-write` | Read/write in CWD + /tmp | Allowed in workspace | Blocked by default |
| `danger-full-access` | Unrestricted | Unrestricted | Allowed |

### Approval Policies (`--ask-for-approval` / `-a`)

| Policy | Behavior |
|--------|----------|
| `untrusted` | Auto-executes workspace operations; asks for untrusted commands |
| `on-failure` | Asks only when errors occur |
| `on-request` | Pauses before actions outside workspace, network access, untrusted commands |
| `never` | No approval prompts (respects sandbox constraints) |

### Shortcut Flags

- `--full-auto`: Sets `--ask-for-approval on-request` + `--sandbox workspace-write` (recommended for unattended work)
- `--dangerously-bypass-approvals-and-sandbox` / `--yolo`: Bypasses all approvals and sandboxing (unsafe, VM-only)

**honden usage**: Ashigaru run with `--full-auto` or `--yolo` according to what the environment records.
Read a single scalar with `honden config get <鍵>`; `honden config` alone shows where the settings file sits and what tier is above it.
The settings path is remembered only through `honden roster sync --settings <settings.yaml>` — there is no general YAML read hole,
because opening one would become the road around honden.

## Memory / State Management

### AGENTS.md (Codex's instruction file)

> **honden では薄い道標に留めてある。** 根の `AGENTS.md` は「`honden brief` を叩け」と
> 受け手の作法だけを書いた一枚で、指示書の本体ではない。本体は `instructions/` の
> 部品一系統であり、`honden brief` が出す時に組む。以下は codex 側の仕組みの説明である。

Codex reads `AGENTS.md` files automatically before doing any work. Discovery order:

1. **Global**: `~/.codex/AGENTS.md` or `~/.codex/AGENTS.override.md`
2. **Project**: Walking from Git root to CWD, checking each directory for `AGENTS.override.md` then `AGENTS.md`

Files are merged root-downward (closer directories override earlier guidance).

**Key constraints**:
- Combined size cap: `project_doc_max_bytes` (default 32 KiB, configurable in `config.toml`)
- Empty files are skipped; only one file per directory is included
- `AGENTS.override.md` temporarily replaces `AGENTS.md` at the same level

**Customization** (`~/.codex/config.toml`):
```toml
project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]
project_doc_max_bytes = 65536
```

Set `CODEX_HOME` env var for project-specific automation profiles.

### Session Persistence

Sessions are stored locally. Use `/resume` or `codex exec resume` to continue previous conversations.

### No Memory MCP equivalent

Codex does not have a built-in persistent memory system like Claude Code's Memory MCP. For cross-session knowledge, rely on:

- AGENTS.md (project-level instructions)
- **正本** (`~/.honden/honden.db`) — read it through honden, never around it:
  - `honden inbox read` — what has been sent to you
  - `honden lease` — your 持ち場 and its expiry
  - `honden cmd show <cmd_id>` — the 受け入れ条件 and how far they are covered
  - `honden claim` — who is holding which 場所
  - `honden decisions` — what still waits on 殿
  - `honden search <語>` — pull from what has been imported
- `honden brief [--role X]` — the instruction sheet itself, assembled **at read time**. There is no generated file, so there is nothing to go stale
- MCP servers if configured

**Do not go looking for `queue/tasks/*.yaml`, `queue/reports/*.yaml`, or `dashboard.md`.** They do not exist here.
Your 任 arrives as a `task_assigned` message in the inbox and is held open by `honden lease`.

## Codex-Specific Commands (Slash Commands)

### Session Management

| Command | Purpose | Claude Code equivalent |
|---------|---------|----------------------|
| `/new` | Start fresh conversation within current session | `/clear` (closest) |
| `/resume` | Resume a saved conversation | `claude --continue` |
| `/fork` | Fork current conversation into new thread | No equivalent |
| `/quit` / `/exit` | Terminate session | Ctrl-C |
| `/compact` | Summarize conversation to free tokens | Auto-compaction |

### Configuration

| Command | Purpose | Claude Code equivalent |
|---------|---------|----------------------|
| `/model` | Choose active model (+ reasoning effort) | `/model` |
| `/personality` | Choose communication style | No equivalent |
| `/permissions` | Set approval/sandbox levels | No equivalent (set at launch) |
| `/status` | Display session config and token usage | No equivalent |
| `/hooks` | Grant trust to the repo's hooks | No equivalent — **required, see Guard Gate** |

### Workspace Tools

| Command | Purpose | Claude Code equivalent |
|---------|---------|----------------------|
| `/diff` | Show Git diff including untracked files | `git diff` via Bash |
| `/review` | Analyze working tree for issues | Manual review via tools |
| `/mention` | Attach a file to conversation | `@` fuzzy search |
| `/ps` | Show background terminals and output | No equivalent |
| `/mcp` | List configured MCP tools | No equivalent |
| `/apps` | Browse connectors/apps | No equivalent |
| `/init` | Generate AGENTS.md scaffold | No equivalent |

**Key difference from Claude Code**: Codex uses `/new` instead of `/clear` for context reset. `/new` starts a fresh conversation but the session remains active. `/compact` explicitly triggers conversation summarization (Claude Code does this automatically).

honden's reset command for codex is therefore `/new`, **never `/clear`** — `/clear` terminates the Codex CLI outright.
The same reasoning makes `/new` honden's default for any CLI it does not recognise.

## Compaction Recovery

Codex handles compaction differently from Claude Code:

1. **Automatic**: Codex auto-compacts when approaching context limits (similar to Claude Code)
2. **Manual**: Use `/compact` to explicitly trigger summarization
3. **Recovery procedure**: After compaction or `/new`, AGENTS.md is automatically re-read, and
   `.codex/hooks/session-start.sh` re-injects the 名乗り. Codex holds `SessionStart` (thread start) and
   `PostCompact` (after squeezing) as separate events, so honden wires the same skin to both —
   **the moment context has been thinned is exactly when the 名乗り must be said again.**

### honden Recovery (Codex Ashigaru)

```
Step 1: 名乗り is injected from the pane's @agent_id (never guessed, never taken from env)
Step 2: honden inbox read  → 己に届いておる報せを読む。task_assigned が任である
Step 3: honden lease       → 持ち場と期限を確かめる。任が無ければ待て
Step 4: 他人の持ち場に触れる前に honden claim check <場所> で空きを問え
Step 5: 処理し終えたら honden inbox ack --all で既読にせよ
```

**名乗りが済むまで inbox を処理するな。** A nudge may land first; ignore it until Step 1 is settled.
Skipping it means mistaking your role and doing another agent's 任.

**Note**: Unlike Claude Code, Codex has no `mcp__memory__read_graph` equivalent.
Recovery relies on the injected 名乗り + AGENTS.md + the 正本 read through honden.

## tmux Interaction

### TUI Mode (default `codex`)

- Codex runs a fullscreen TUI using alt-screen
- `--no-alt-screen` flag disables alternate screen mode (critical for tmux integration)
- With `--no-alt-screen`, send-keys and capture-pane should work similarly to Claude Code
- Prompt detection: TUI prompt format differs from Claude Code's `❯` — pattern TBD after testing

### Non-Interactive Mode (`codex exec`)

- Runs headless, outputs to stdout (text or JSONL with `--json`)
- No alt-screen issues — ideal for tmux pane integration
- `codex exec --full-auto --json "task description"` for automated execution
- Can resume sessions: `codex exec resume`
- Output file support: `--output-last-message, -o` writes final message to file

### send-keys Compatibility

| Mode | send-keys | capture-pane | Notes |
|------|-----------|-------------|-------|
| TUI (default) | Risky (alt-screen) | Risky | Use `--no-alt-screen` |
| TUI + `--no-alt-screen` | Should work | Should work | Preferred for tmux |
| `codex exec` | N/A (non-interactive) | stdout capture | Best for automation |

### Nudge Mechanism

For TUI mode with `--no-alt-screen`:

- `honden nudge` plans the wake-up and sends it. **Agents never call tmux send-keys themselves.**
- The text is `inbox_notice unread=N <type>=<count> … urgent=0|1` — **not** `inbox3`.
  The old form collided with 足軽 numbers (1〜7): `inbox3` was read as 「足軽3号」. `key=value` reads the same to every model.
- Escalation: level 1 is the plain 合図; at 2 min it repeats (copilot / kimi additionally take Escape×2 + Ctrl-C —
  codex takes a plain re-nudge); at 4 min it sends the reset command, `/new` for codex, at most once per 5 minutes.
- **A busy codex refuses `/new` mid-work** (殿実測 2026-08-27). honden defers the reset to a later round and keeps
  firing the plain 合図 meanwhile, leaving no reset mark — so the reset lands on the first round the agent is free.
- Follow-up 確認キー for codex is `Tab`. **仮置きである** — 布陣へ座らせた時に実測で校正せよ.
- Safety (shogun): in attended mode the Shogun pane is never nudged at all (`honden mode [attended|autonomous]`).
  `honden nudge --wake-shogun --reason "…"` is a one-off explicit exception and does not move the 正本.
- After a nudge: `honden inbox read` → process each message by its `type` → `honden inbox ack --all`.
- **急ぎの報せ** (`clear_command` / `cmd_new` / `cmd_update` / `guard_appeal` / `guard_grant`) does not wait for a nudge.
  It rides along on the output of **any** honden subcommand as a single line, `⚠ 急ぎの未読`. Reading that line is not optional.

For `codex exec` mode:

- Each task is a separate `codex exec` invocation
- No nudge needed — task content is passed as argument

### Sending, not just receiving

```bash
honden inbox write --to gunshi --type report_received --from ashigaru5 --body "足軽5号、任務完了。品質チェックを仰ぎたし。"
```

Long bodies go through `EOF` instead — the shell then keeps its hands off the quoting.
Valid `type` values are only: `report_received` / `report_completed` / `task_assigned` / `cmd_new` /
`cmd_update` / `clear_command` / `guard_appeal` / `guard_grant`. Inventing a new string makes the receiver fall silent.

報告の路は現行のまま。足軽 → 軍師 → 家老 → 将軍。宛先を飛び越える道は引数に無い。
`honden report submit` (足軽) goes to 軍師 on its own; `honden report qc` (軍師だけ) goes on to 家老.
家老から将軍への inbox は、**殿が在席の間だけ**塞がる（`src/cli.ts`）。
殿が席を外されておる間は開く——夜間の escalation はこれが無ければ届かぬ。
殿の裁定を要するものは `honden decision raise` で上げ、`honden decisions` で開いておる分を見る。

## MCP Configuration

Codex configures MCP servers in `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
type = "stdio"
command = "npx"
args = ["-y", "@anthropic/memory-mcp"]

[mcp_servers.github]
type = "stdio"
command = "npx"
args = ["-y", "@anthropic/github-mcp"]
```

### Key differences from Claude Code MCP:

| Aspect | Claude Code | Codex CLI |
|--------|------------|-----------|
| Config format | JSON (`.mcp.json`) | TOML (`config.toml`) |
| Server types | stdio, SSE | stdio, Streamable HTTP |
| OAuth support | No | Yes (`codex mcp login`) |
| Tool filtering | No | `enabled_tools` / `disabled_tools` |
| Timeout config | No | `startup_timeout_sec`, `tool_timeout_sec` |
| Add command | `claude mcp add` | `codex mcp add` |

## Model Selection

### Command Line

```bash
codex --model codex-mini-latest      # Lightweight model
codex --model gpt-5.3-codex          # Full model (subscription)
codex --model o4-mini                # Reasoning model
```

### In-Session

Use `/model` to switch models during a session (includes reasoning effort setting when available).

### honden

CLI and model per agent live in the 名簿. `honden roster` shows the current 顔ぶれ (id / role / cli / model);
`honden roster sync --settings <settings.yaml>` replaces it wholesale, reading `cli.agents` from the settings file.
`honden route <1-6> [--role worker] [--providers …]` lists who can be given work at that tier.

**There is no `model_switch` message type in honden.** Karo cannot switch a Codex model by inbox —
the 名簿 is the lever, and `/model` in the TUI is the only in-session route.

## Limitations (vs Claude Code)

| Feature | Claude Code | Codex CLI | Impact |
|---------|------------|-----------|--------|
| Memory MCP | Built-in | Not built-in (configurable) | Recovery relies on 名乗り + AGENTS.md + 正本 |
| Task tool (subagents) | Yes | No | Cannot spawn sub-agents |
| Skill system | Yes | No | No slash command skills |
| Dynamic model switch | `/model` via send-keys | `/model` in TUI only | Limited in automated mode; no `model_switch` type in honden |
| `/clear` context reset | Yes | `/new` (TUI only; `/clear` kills the CLI) | Exec mode: new invocation |
| Prompt caching | 90% discount | 75% discount | Higher cost per token |
| Subscription limits | API-based (no limit) | msg/5h limits (Plus/Pro) | Bottleneck for parallel ops |
| Alt-screen | No (terminal-native) | Yes (TUI, unless `--no-alt-screen`) | tmux integration risk |
| Sandbox | None built-in | OS-level (landlock/seatbelt) | Safer automated execution |
| Structured output | Text only | JSONL (`--json`) | Better for parsing |
| Local/OSS models | No | Yes (`--oss` via Ollama) | Offline/cost-free option |
| Hook trust | Implicit | **Explicit, and silently skipped without it** | Gate can vanish without a sound — see below |

## Guard Gate (Codex)

honden の禁じ手の門は、sandbox でも approval policy でもない。別に据わった PreToolUse hook である。

```
.codex/hooks.json   matcher "^(Bash|Shell)$"
  → .codex/hooks/guard.sh          （薄い皮）
    → honden guard hook codex       （判定はここに集約）
```

Allow は沈黙である。deny は `permissionDecision: "deny"` と理由を返す。

- `honden guard check --cmd '<コマンド>'` — judge a command without running it.
- **直訴**: `honden guard appeal --cmd '<コマンド>' --reason '<理由>'` を将軍へ上げる。
  将軍が `honden guard grant`（将軍だけ）で手形を下ろすと、札が inbox へ届く。
  使う時は `HONDEN_OTP=<札>` をコマンドの頭に付ける。一度きり・期限つき。
  **絶対域は appealable ではない。手形でも通らぬ。**
- `honden guard facts --agent <者> --cmd "<命>"` — 検分の材料を正本から集める（JSON）。

**据えただけでは効かぬ。** 静かに門が消える形が三つある:

1. codex は**未信頼の hook を黙って飛ばす**（`codex exec` に信頼の出口が無い）。
   対話で起こして `/hooks` で信頼を与えよ。
2. `hooks.json` を書き換えるとハッシュが変わり、再信頼まで門が飛ぶ。
3. 名簿はセッション開始時に読まれる。据えた後に呼び直すことはできぬ。

いずれも**静かに**消える。`honden guard selftest` は実際に禁じ手を差し出して、
`生きておる` / `**効いておらぬ**` / `据わっておらぬ` を返す——これが陽性対照である。
定期的に叩け。据わっておるのに効いておらぬのが最も危うい。
