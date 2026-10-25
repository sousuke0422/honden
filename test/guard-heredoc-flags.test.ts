import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { parseCommand, realRunner } from '../src/parse';

const root = join(import.meta.dir, '..');
const run = realRunner(root);
// Policy-sensitive text stays in fixture data and is never executed by these tests.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/heredoc-flags.jsonl'), 'utf8')) as {
  id: string; text: string;
};

describe('heredoc と shell の停止旗', () => {
  test('heredoc 内の命令置換の引用を改めず、表示する引数として扱う', () => {
    const substitution = `printf '%s\\n' "text; ${fixture.text}"`;
    const input = `cat <<EOF\n$(${substitution})\nEOF`;
    const parsed = parseCommand(input, run);
    expect({ id: fixture.id, parsed: parsed.ok }).toEqual({ id: fixture.id, parsed: true });
    if (!parsed.ok) return;
    expect(parsed.substitutions.includes(substitution)).toBe(true);
    expect(judgeStructured(input, run).permission).toBe('allow');
  });

  test.each(['-s -n', '-n -s', '-sn', '-ns'])('標準入力の停止旗を順序によらず読む: %s', (flags) => {
    const input = `bash ${flags} <<< '${fixture.text}'`;
    expect(judgeStructured(input, run).permission).toBe('allow');
  });

  test('標準入力を明示した後の位置引数は実行を止める旗と取り違えぬ', () => {
    for (const flags of ['-s ignored', '-s -- -n']) {
      const input = `bash ${flags} <<< '${fixture.text}'`;
      expect(judgeStructured(input, run).permission).toBe('deny');
    }
  });
});
