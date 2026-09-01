#!/usr/bin/env bats
# 顔ぶれ差し替えの入口（configure-agents.sh）。
#
# 見るのは入口の仕事だけ——場所を合わせ、bin/honden へ渡し、無ければ言う。
# 差し替えの中身は test/rosteredit.test.ts と test/rosterset.test.ts が受け持つ。

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  T="$(mktemp -d "${BATS_RUN_TMPDIR:-/tmp}/honden-cfg.XXXXXX")"
  cat > "$T/settings.yaml" <<'YAML'
cli:
  agents:
    shogun:
      type: claude
      model: claude-opus-5   # 残るべき注釈
    karo:
      type: cursor
      model: auto
    ashigaru1:
      type: claude
      model: claude-fable-5
    gunshi:
      type: claude
      model: claude-sonnet-5
YAML
}

@test "旗で下見すると、変わる所を見せて書かぬ" {
  [ -x "$ROOT/bin/honden" ] || skip "bin/honden が無い（bun run build）"
  run bash "$ROOT/configure-agents.sh" --settings "$T/settings.yaml" --db "$T/h.db" \
      --karo claude:claude-sonnet-5 --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"karo"*"cursor auto"*"claude claude-sonnet-5"* ]]
  [[ "$output" == *"書いておらぬ"* ]]
  grep -q "type: cursor" "$T/settings.yaml"
}

@test "旗で --yes なら書き、注釈は残り、名簿へ写る" {
  [ -x "$ROOT/bin/honden" ] || skip "bin/honden が無い（bun run build）"
  run bash "$ROOT/configure-agents.sh" --settings "$T/settings.yaml" --db "$T/h.db" \
      --karo claude:claude-sonnet-5 --yes
  [ "$status" -eq 0 ]
  grep -q "# 残るべき注釈" "$T/settings.yaml"
  grep -A1 "^    karo:" "$T/settings.yaml" | grep -q "type: claude"
  run "$ROOT/bin/honden" roster --db "$T/h.db"
  [[ "$output" == *"karo"*"claude"*"claude-sonnet-5"* ]]
}

@test "端末でなく旗も無ければ、旗の使い方を教えて非 0" {
  [ -x "$ROOT/bin/honden" ] || skip "bin/honden が無い（bun run build）"
  run bash "$ROOT/configure-agents.sh" --settings "$T/settings.yaml" --db "$T/h.db" </dev/null
  [ "$status" -ne 0 ]
  [[ "$output" == *"--workers"* ]]
}

@test "bin/honden が無ければ仕度を案内して非 0（黙って進まぬ）" {
  run env HONDEN_BIN="$T/no-such-honden" bash "$ROOT/configure-agents.sh" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"first_setup.sh"* ]]
}

@test "三つの入口が揃って追跡されている（片方だけ落ちると Finder/Windows で起きぬ）" {
  cd "$ROOT"
  for f in configure-agents.sh configure-agents.command configure-agents.bat; do
    git ls-files --error-unmatch "$f" >/dev/null 2>&1 || git ls-files --others --exclude-standard | grep -qx "$f" || {
      echo "$f が追跡から漏れておる"; return 1; }
  done
}
