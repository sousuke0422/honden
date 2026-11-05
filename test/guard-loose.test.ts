import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { realRunner } from '../src/parse';

const run = realRunner(join(import.meta.dir, '..'));
// Preserve cmd_360's inputs and IDs using the existing guard-corpus JSONL convention.
const fixtures = readFileSync(join(import.meta.dir, 'fixtures/guard-loose.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as {
    kind: 'control' | 'attack'; id: string; cmd: string; expect?: string;
  });
const cases = {
  controls: fixtures.filter((c) => c.kind === 'control'),
  attack: fixtures.filter((c) => c.kind === 'attack'),
};

// Assertions expose IDs only. Fixture text is input to the judge, never executed.
describe('loose shell inputs', () => {
  test('controls establish the parser and policy baseline first', () => {
    expect(cases.controls.length).toBe(8);
    for (const c of cases.controls) {
      const got = judgeStructured(c.cmd, run).permission === 'deny' ? 'blocked' : 'passed';
      expect({ id: c.id, got }).toEqual({ id: c.id, got: c.expect ?? 'missing expectation' });
    }
  });
  test('every attack is rejected, and F11 reaches a policy rule', () => {
    expect(cases.attack.length).toBe(57);
    for (const c of cases.attack) {
      const verdict = judgeStructured(c.cmd, run);
      expect({ id: c.id, permission: verdict.permission }).toEqual({ id: c.id, permission: 'deny' });
      if (c.id.startsWith('F11-')) {
        expect({ id: c.id, structural: verdict.rule === 'D000' }).toEqual({ id: c.id, structural: false });
      }
    }
  });
});
