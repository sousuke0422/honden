#!/usr/bin/env bats
# 棚の skill を案件へ繋ぐ仕度（scripts/setup_skills.sh）。
#
# 主眼——**案件が己の実体を持っておれば触らぬ**。仕度が黙って壊すのが一番の事故。

load helpers

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  PROJ="$BATS_TEST_TMPDIR/proj"
  mkdir -p "$PROJ"
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
