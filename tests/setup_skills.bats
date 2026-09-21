#!/usr/bin/env bats
# 棚の skill を案件へ繋ぐ仕度（scripts/setup_skills.sh）。
#
# 主眼——**案件が己の実体を持っておれば触らぬ**。仕度が黙って壊すのが一番の事故。

load helpers

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  PROJ="$BATS_TEST_TMPDIR/proj"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$PROJ" "$HOME"
}

@test "名を並べずに呼ぶと一覧だけ見せ、何も繋がぬ" {
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ"
  [ "$status" -eq 0 ]
  [[ "$output" == *"honden-coder"* ]]
  [ ! -e "$PROJ/.claude/skills" ]
}

@test "名指しで繋がる。近道（vendor）は実体へ解いて繋ぐ" {
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" honden-coder skill-creator
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/skills/honden-coder" ]
  [ -f "$PROJ/.claude/skills/honden-coder/SKILL.md" ]
  # skill-creator は棚では近道だが、繋ぎは実体（vendor/…）を指す
  tgt=$(readlink -f "$PROJ/.claude/skills/skill-creator")
  [[ "$tgt" == */skills/vendor/skill-creator ]]
}

@test "--all で棚の全部が繋がる" {
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" --all
  [ "$status" -eq 0 ]
  [ -L "$PROJ/.claude/skills/japanese-tech-writing" ]
  [ -L "$PROJ/.claude/skills/honden-remote-ssh" ]
}

@test "**案件が己の実体を持っておれば触らぬ**" {
  mkdir -p "$PROJ/.claude/skills/honden-coder"
  echo mine > "$PROJ/.claude/skills/honden-coder/SKILL.md"
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" honden-coder
  [ "$status" -eq 0 ]
  [[ "$output" == *"触らぬ"* ]]
  [ ! -L "$PROJ/.claude/skills/honden-coder" ]
  run cat "$PROJ/.claude/skills/honden-coder/SKILL.md"
  assert_output "mine"
}

@test "--unlink は link だけ外し、実体は外さぬ" {
  bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" honden-coder >/dev/null
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" --unlink honden-coder
  [ "$status" -eq 0 ]
  [ ! -e "$PROJ/.claude/skills/honden-coder" ]
  mkdir -p "$PROJ/.claude/skills/mine"; echo x > "$PROJ/.claude/skills/mine/SKILL.md"
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" --unlink mine
  [[ "$output" == *"棚に無い"* ]] || [[ "$output" == *"触らぬ"* ]]
  [ -e "$PROJ/.claude/skills/mine/SKILL.md" ]
}

@test "棚に無い名は飛ばして続ける" {
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" no-such honden-coder
  [ "$status" -eq 0 ]
  [[ "$output" == *"棚に無い"* ]]
  [ -L "$PROJ/.claude/skills/honden-coder" ]
}

@test "**既定の繋ぎ先は honden 自身**（陣の session の cwd ゆえ）" {
  # 実 repo を汚さぬよう、棚ごと写した贋の根で確かめる
  FAKE="$BATS_TEST_TMPDIR/root"; mkdir -p "$FAKE/scripts"
  cp "$ROOT/scripts/setup_skills.sh" "$FAKE/scripts/"
  cp -r "$ROOT/skills" "$FAKE/skills"
  run bash "$FAKE/scripts/setup_skills.sh" honden-coder
  [ "$status" -eq 0 ]
  [ -L "$FAKE/.claude/skills/honden-coder" ]
}

@test "--codex は各人段へ skill ごとに繋ぎ、Claude 側を触らぬ" {
  run bash "$ROOT/scripts/setup_skills.sh" --codex honden-coder skill-creator
  [ "$status" -eq 0 ]
  [ -L "$HOME/.agents/skills/honden-coder" ]
  [ -f "$HOME/.agents/skills/honden-coder/SKILL.md" ]
  [ -L "$HOME/.agents/skills/skill-creator" ]
  [[ "$(readlink -f "$HOME/.agents/skills/skill-creator")" == */skills/vendor/skill-creator ]]
  [ ! -e "$ROOT/.claude/skills/honden-coder" ]
}

@test "--codex --all は棚の直下と vendor の近道を各人段へ並べる" {
  run bash "$ROOT/scripts/setup_skills.sh" --codex --all
  [ "$status" -eq 0 ]
  [ -L "$HOME/.agents/skills/honden-coder" ]
  [ -L "$HOME/.agents/skills/find-skills" ]
  [ -L "$HOME/.agents/skills/japanese-tech-writing" ]
  [[ "$(readlink -f "$HOME/.agents/skills/find-skills")" == */skills/vendor/find-skills ]]
}

@test "--codex は実体を上書きせず、二度目は同じ link を保つ" {
  mkdir -p "$HOME/.agents/skills/honden-coder"
  echo mine > "$HOME/.agents/skills/honden-coder/SKILL.md"
  run bash "$ROOT/scripts/setup_skills.sh" --codex honden-coder
  [ "$status" -eq 0 ]
  [[ "$output" == *"触らぬ"* ]]
  run cat "$HOME/.agents/skills/honden-coder/SKILL.md"
  assert_output "mine"

  rm -r "$HOME/.agents/skills/honden-coder"
  bash "$ROOT/scripts/setup_skills.sh" --codex honden-coder >/dev/null
  first="$(readlink -f "$HOME/.agents/skills/honden-coder")"
  run bash "$ROOT/scripts/setup_skills.sh" --codex honden-coder
  [ "$status" -eq 0 ]
  [[ "$output" == *"繋ぎ済み"* ]]
  [ "$(readlink -f "$HOME/.agents/skills/honden-coder")" = "$first" ]
}

@test "--codex --unlink は己の link だけ外し、旧 namespace を巻き込まぬ" {
  legacy="$BATS_TEST_TMPDIR/legacy-skills"
  mkdir -p "$legacy" "$HOME/.codex/skills"
  ln -s "$legacy" "$HOME/.codex/skills/shogun"
  bash "$ROOT/scripts/setup_skills.sh" --codex honden-coder >/dev/null

  run bash "$ROOT/scripts/setup_skills.sh" --codex --unlink honden-coder
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.agents/skills/honden-coder" ]
  [ -L "$HOME/.codex/skills/shogun" ]
  [ "$(readlink -f "$HOME/.codex/skills/shogun")" = "$legacy" ]

  run bash "$ROOT/scripts/setup_skills.sh" --codex --unlink shogun
  [ "$status" -eq 0 ]
  [ -L "$HOME/.codex/skills/shogun" ]
}

@test "--project と --codex の曖昧な併用は書く前に拒む" {
  run bash "$ROOT/scripts/setup_skills.sh" --project "$PROJ" --codex honden-coder
  [ "$status" -ne 0 ]
  [[ "$output" == *"併用できぬ"* ]]
  [ ! -e "$PROJ/.claude/skills/honden-coder" ]
  [ ! -e "$HOME/.agents/skills/honden-coder" ]
}
