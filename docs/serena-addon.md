# Serena をアドオンとして入れる

Serena はアドオンである。**標準でも必須でもない。**
入れずとも honden は立つ——honden の芯は `.serena/` を一切読まぬ。
この書は手順を残すものであって、導入を勧めるものではない。

## 上流

[oraios/serena](https://github.com/oraios/serena)。無料・OSS。
LSP を背にした symbol 単位の読み書きを MCP server として提供する。

手順は上流の書に従う（2026-09-21 に当たった。同日、`serena --help` と
`serena setup --help` の実測でも命と副命令の在る無しを確かめてある）:

- <https://oraios.github.io/serena/02-usage/010_installation.html>
- <https://oraios.github.io/serena/02-usage/030_clients.html>

世に出回る記事の `claude mcp add serena -- uvx --from git+…` の形は
古い。写さぬこと。

## 入れ方

```bash
# 入れる
uv tool install -p 3.13 serena-agent

# 初期化（言語サーバの背骨を使う場合）
serena init
```

客（client）ごとに繋ぐ。我らで使いうるのは三つだが、繋ぎ方は二通りある。

Claude Code と Codex は `serena setup` が受ける:

```bash
serena setup claude-code   # Claude Code
serena setup codex         # Codex
```

Cursor は `serena setup` の対象に無い（受けるのは claude-code・codebuddy・
codex・grok の四つ——`serena setup --help` で実測）。上流は Cursor を
「MCP を受ける IDE 系の客」として扱う。`~/.cursor/mcp.json` の
`mcpServers` へ手で書く:

```json
{
  "mcpServers": {
    "serena": {
      "command": "serena",
      "args": ["start-mcp-server", "--project-from-cwd", "--context", "ide"]
    }
  }
}
```

`--context` は `start-mcp-server` の旗である（`setup` には付かぬ）。
IDE 系の客には上流が `ide` の context を勧めておる——道具の重なりを
減らすためである。`scripts/setup_addons.sh` の cursor の繋ぎも
この形（`~/.cursor/mcp.json` へ `--context ide` で書き足す）である。

外す時:

```bash
uv tool uninstall serena-agent
```

初回の activate で `.serena/project.yml`（案件の設定）が生まれる。

### Claude Code で使う時の註

上流自身が、Opus 系の模型では道具への従いが著しく落ちると註しておる。
上流の挙げる逃げ道
`claude --system-prompt="$(serena prompts print-cc-system-prompt-override)"`
は、我らの指示書とぶつかる恐れがあり**未検**である。使うなら先に検めよ。

## 版に載る物と載らぬ物

| 載る（追跡する） | 載らぬ（各人の物） |
|---|---|
| `.serena/.gitignore` | `.serena/cache/` |
| `.serena/project.yml` | `.serena/project.local.yml` |
| `.serena/memories/*.md` | |

区分は Serena 自身の `.serena/.gitignore` に従う——それが `/cache` と
`/project.local.yml` を退けており、残り（設定と覚え）は版に載せてよい造りである。
根の白名簿も同じ区分を名指しで開けてある。

手元だけ設定を変えたい時は `.serena/project.local.yml` に書く。
`project.yml` を上書きでき、版には載らぬ。

## 起こすたび browser が開くのを止める

既定では起動のたび dashboard が browser で開く。
`~/.serena/serena_config.yml`（各人の全体設定）で止められる:

```yaml
web_dashboard: false
# dashboard 自体は残し、勝手に開くのだけ止めるなら:
# web_dashboard_open_on_launch: false
```

## 入れぬ者に何も起きぬ

- honden の芯（`src/`・`scripts/`）に `.serena/` への参照は無い。
  入れた者と入れぬ者で honden の振る舞いは変わらぬ。
- `.serena/cache/` と `project.local.yml` は追跡されぬゆえ、
  入れた者の手元の状態が版を汚すことも無い。

## 効き目について

このリポジトリでは Serena の効き目（トークン削減など）を測っておらぬ。
外部の記事が削減率を数で謳うことがあるが、それは書き手の見立てであり、
我らの実測ではない。数が要るなら、まず測ること。
