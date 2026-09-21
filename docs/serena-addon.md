# Serena をアドオンとして入れる

Serena はアドオンである。**標準でも必須でもない。**
入れずとも honden は立つ——honden の芯は `.serena/` を一切読まぬ。
この書は手順を残すものであって、導入を勧めるものではない。

## 上流

[oraios/serena](https://github.com/oraios/serena)。無料・OSS。
LSP を背にした symbol 単位の読み書きを MCP server として提供する。

## 入れ方（二段）

一段目。Claude Code に MCP server として繋ぐ:

```bash
claude mcp add serena -- uvx --from git+https://github.com/oraios/serena \
  serena start-mcp-server --context ide-assistant --project "$(pwd)"
```

二段目。Claude Code の session 内で初期指示を読み込ませる:

```
/mcp__serena__initial_instructions
```

初回の activate で `.serena/project.yml`（案件の設定）が生まれる。

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
