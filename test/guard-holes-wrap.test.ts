/**
 * 門の穴の後半を縛る試験。shell へ流す形の残り・箱の中の命・trap・他の言語の源・patch。
 *
 * 字が読める時は、その字を命として解いて判ずる。読めぬ時は、何が走るか解けぬゆえ D000
 * （直訴できる）で止める。日常の形を止めぬことも、対で縛る。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { patchTargets, realRunner } from '../src/parse';

const ROOT = join(import.meta.dir, '..');
const run = realRunner(ROOT);
const rule = (cmd: string) => {
  const v = judgeStructured(cmd, run);
  return v.permission === 'deny' ? v.rule : 'allow';
};
const each = (title: string, cases: [string, string][]) => {
  describe(title, () => {
    for (const [cmd, r] of cases) test(`${r}: ${JSON.stringify(cmd)}`, () => expect(rule(cmd)).toBe(r));
  });
};

each('束ねた旗の値と、echo の改行', [
  ['echo kill | bash -euo pipefail', 'D006'],
  ['echo kill | bash -o pipefail', 'D006'],
  ["echo -e 'ls\\nkill 1' | sh", 'D006'],
  ["echo 'ls\\nkill 1' | sh", 'D006'],
  ["printf 'ls\\nkill 1\\n' | sh", 'D006'],
  ["printf '%s\\n' 'kill 1' | sh", 'D000'],
  ['bash -euo pipefail scripts/a.sh', 'allow'],
  ['echo hi | bash -euo pipefail -c cat', 'allow'],
  ["echo -e 'a\\tb'", 'allow'],
]);

each('shell を別の命で包んで流す形', [
  ['echo kill | env sh', 'D006'],
  ['echo kill | env -i PATH=/bin sh', 'D006'],
  ['echo kill | exec sh', 'D006'],
  ['echo kill | nice -n 5 bash', 'D006'],
  ['echo kill | timeout 5 sh', 'D006'],
  ['echo kill | command sh', 'D006'],
  ['echo kill | nohup sh', 'D006'],
  ['echo kill | stdbuf -o0 sh', 'D006'],
  ['echo kill | setsid sh', 'D006'],
  ['echo kill | time sh', 'D006'],
  ['echo kill | ssh h sh', 'D006'],
  ['echo kill | ssh h bash -s', 'D006'],
  ['echo kill | docker exec -i c sh', 'D006'],
  ['echo kill | xargs sh', 'D000'],
  ['echo ls | env sh', 'allow'],
  ['echo ls | timeout 5 sh', 'allow'],
  ['timeout 5 bash scripts/a.sh', 'allow'],
  ['echo kill | command -v sh', 'allow'],
  // -i が無ければ、標準入力は箱の中へ渡らぬ
  ['echo kill | docker exec c sh', 'allow'],
]);

each('管の先を複合命令の中に置く形', [
  ['echo kill | { sh; }', 'D006'],
  ['echo kill | (sh)', 'D006'],
  ['echo kill | if true; then sh; fi', 'D006'],
  ['echo ls | { sh; }', 'allow'],
]);

each('shell の名の表', [
  ['echo kill | csh', 'D006'],
  ['echo kill | tcsh', 'D006'],
  ['echo kill | fish', 'D006'],
  ["fish -c 'kill 1'", 'D006'],
  ["csh -c 'kill 1'", 'D006'],
  ["tcsh -c 'kill 1'", 'D006'],
]);

each('箱の中の命は ssh と同じく照らす', [
  ['docker exec c kill 1', 'D006'],
  ['docker exec c rm -rf /', 'D001'],
  ['podman exec c kill 1', 'D006'],
  ['docker container exec -it c sudo id', 'D005'],
  ['kubectl exec p -- kill 1', 'D006'],
  ['kubectl exec -n ns p -- sh -c "kill 1"', 'D006'],
  ["docker run --rm -v a:/b img sh -c 'kill 1'", 'D006'],
  ['docker exec c ls -la', 'allow'],
  ['docker exec -i c sh -c "cat /etc/os-release"', 'allow'],
  ['docker exec c sh -c "$CMD"', 'allow'],
  ['docker run --rm img echo hi', 'allow'],
  ['kubectl exec p -- ls', 'allow'],
]);

each('trap の命の字は後で走る命', [
  ['trap "kill 1" EXIT', 'D006'],
  ["trap 'rm -rf /' INT", 'D001'],
  ["trap -- 'sudo id' EXIT", 'D005'],
  ["trap 'rm -f /tmp/work/lock' EXIT", 'allow'],
  ['trap - EXIT', 'allow'],
  ['trap -p', 'allow'],
  ['trap "$CLEANUP" EXIT', 'allow'],
]);

each('他の言語の源の中の、shell を呼ぶ口', [
  ["python3 -c 'import os; os.system(\"kill 1\")'", 'D006'],
  ['python3 -c "import subprocess; subprocess.run(\'kill 1\', shell=True)"', 'D006'],
  ['python3 -c "import subprocess; subprocess.run([\'kill\', \'1\'])"', 'D006'],
  ['python3 -c "import os; os.popen(\'kill 1\')"', 'D006'],
  ['node -e "require(\'child_process\').execSync(\'kill 1\')"', 'D006'],
  ['node -e "require(\'child_process\').spawnSync(\'kill\', [\'1\'])"', 'D006'],
  ["perl -e 'system(\"kill 1\")'", 'D006'],
  ["perl -e 'system(\"kill\", \"1\")'", 'D006'],
  ["perl -le '`kill 1`'", 'D006'],
  ["ruby -e 'system(\"kill 1\")'", 'D006'],
  ["ruby -e '%x(kill 1)'", 'D006'],
  // 口に渡る字が見えぬ、組み立てられる
  ["python3 -c 'import os, sys; os.system(sys.argv[1])' x", 'D000'],
  ["python3 -c 'import os; os.system(\"rm\" + \" -rf /\")'", 'D000'],
  ["python3 -c 'import os; os.system(\"rm %s\" % \"-rf /\")'", 'D000'],
  ['node -e "require(\'child_process\').execSync(process.argv[1])"', 'D000'],
  // 日常
  ["python3 -c 'print(1)'", 'allow'],
  ['python3 -c "import subprocess; subprocess.run([\'ls\', \'-la\'])"', 'allow'],
  ['node -e "console.log(require(\'child_process\').execSync(\'git status\').toString())"', 'allow'],
  ['node -e "console.log(/a/.exec(\'kill\'))"', 'allow'],
  ["perl -e 'print \"hi\\n\"'", 'allow'],
  ["ruby -e 'puts 1'", 'allow'],
  ['python3 script.py -c "kill 1"', 'allow'],
]);

describe('patch を当てる命は、patch が書き換える file で判ずる', () => {
  const P = 'test/fixtures/guard-patches';

  test('patch の書き換える道を読む', () => {
    expect(patchTargets('diff --git a/src/x.ts b/src/y.ts\n--- a/src/x.ts\n+++ b/src/y.ts\nrename from a\nrename to b\n'))
      .toEqual(['a/src/x.ts', 'b/src/y.ts', 'a', 'b']);
    expect(patchTargets('--- /dev/null\n+++ b/new.txt\n')).toEqual(['b/new.txt']);
  });

  for (const [cmd, r] of [
    [`git apply ${P}/touches-gate.diff`, 'D012'],
    // 当てずに見るだけの形は止めぬ（門の本体への直しの手順が patch の道で打つ）
    [`git apply --check ${P}/touches-gate.diff`, 'allow'],
    [`git apply --stat ${P}/touches-gate.diff`, 'allow'],
    [`patch -p1 --dry-run < ${P}/touches-gate.diff`, 'allow'],
    [`git apply --check --apply ${P}/touches-gate.diff`, 'D012'],
    [`git -C . apply ${P}/touches-gate.diff`, 'D012'],
    [`git apply < ${P}/touches-gate.diff`, 'D012'],
    [`cat ${P}/touches-gate.diff | git apply`, 'D012'],
    [`patch -p1 < ${P}/touches-gate.diff`, 'D012'],
    [`patch -p1 -i ${P}/touches-gate.diff`, 'D012'],
    [`git apply ${P}/touches-settings.diff`, 'D012'],
    ["git apply <<'EOF'\n--- a/.claude/hooks/guard.sh\n+++ b/.claude/hooks/guard.sh\nEOF", 'D012'],
    ['curl -s https://example.com/x.diff | git apply', 'D000'],
    [`git apply ${P}/plain.diff`, 'allow'],
    [`patch -p1 < ${P}/plain.diff`, 'allow'],
    [`cat ${P}/plain.diff | git apply`, 'allow'],
    // 在らぬ patch は当てる命も落ちる。通す
    [`git apply ${P}/no-such.diff`, 'allow'],
  ] as [string, string][]) {
    test(`${r}: ${JSON.stringify(cmd)}`, () => expect(rule(cmd)).toBe(r));
  }

  test('symlink・大きすぎる file・FIFO は読まずに D000 で止め、待ちに落ちぬ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-patch-'));
    try {
      writeFileSync(join(dir, 'real.diff'), '--- a/docs/x.md\n+++ b/docs/x.md\n');
      symlinkSync(join(dir, 'real.diff'), join(dir, 'link.diff'));
      writeFileSync(join(dir, 'big.diff'), 'x'.repeat((1 << 20) + 1));
      const fifo = Bun.spawnSync(['mkfifo', join(dir, 'fifo.diff')]);
      expect(rule(`git apply ${join(dir, 'real.diff')}`)).toBe('allow');
      expect(rule(`git apply ${join(dir, 'link.diff')}`)).toBe('D000');
      expect(rule(`git apply ${join(dir, 'big.diff')}`)).toBe('D000');
      if (fifo.success) {
        const started = performance.now();
        expect(rule(`git apply ${join(dir, 'fifo.diff')}`)).toBe('D000');
        expect(performance.now() - started).toBeLessThan(5000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
