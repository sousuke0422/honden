#!/usr/bin/env bats
# 芯まわりの道が、立てる側と検める側で揃うか。
#
# 出陣は `<正本>.watch.lock`、検めは `<親>/watch.lock` を見ておった。
# 別の file ゆえ、出陣で立てた陣では `honden status` が常に
# 「芯は死んでおる」と出ておった（実測 2026-08-29）。
# 道を二箇所で組めばいつか必ずずれる——組み立てを禁じ、honden に訊かせる。

load helpers

setup() {
  ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
}

@test "出陣も試験の陣も、道を自前で組み立てぬ" {
  # `.watch.lock` や `.signal` を shell 側で綴っておらぬこと。
  run bash -c "grep -nE \"[\\\$]DB\\.(signal|watch\\.lock)|TESTHOME/watch\\.lock\" '$ROOT/scripts/shutsujin.sh' '$ROOT/scripts/testenv.sh' || true"
  assert_output ""
}

@test "両方が honden paths に訊いておる" {
  run bash -c "grep -c 'honden\" paths\\|honden' \"$ROOT/scripts/shutsujin.sh\" | head -1"
  assert_success
  run bash -c "grep -q 'paths signal' '$ROOT/scripts/shutsujin.sh' && grep -q 'paths lock' '$ROOT/scripts/shutsujin.sh' && echo ok"
  assert_output "ok"
  run bash -c "grep -q 'paths signal' '$ROOT/scripts/testenv.sh' && grep -q 'paths lock' '$ROOT/scripts/testenv.sh' && echo ok"
  assert_output "ok"
}

@test "honden paths は三つの道を答える" {
  run "$ROOT/bin/honden" paths --db /tmp/x/honden.db
  assert_success
  assert_output --partial "signal=/tmp/x/honden.db.signal"
  assert_output --partial "lock=/tmp/x/watch.lock"
}
