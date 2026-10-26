import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { execUnits, parseCommand, realRunner } from '../src/parse';
const run = realRunner(join(import.meta.dir, '..'));
const tag = (cmd: string) => {
  const v = judgeStructured(cmd, run);
  return v.permission === 'deny' ? `deny:${v.rule}` : 'allow';
};
const cases = readFileSync(join(import.meta.dir, 'fixtures/guard-nested-stream.jsonl'), 'utf8')
  .trim().split('\n').map(s => JSON.parse(s) as { id: string; cmd: string; expect: string });
describe('known streams in wrappers', () => {
  for (const c of cases) test(c.id, () => expect(tag(c.cmd), c.id).toBe(c.expect));
  test('all original and mechanically expanded cases are present', () => expect(cases.length).toBe(56));
});
describe('recursive execution collection boundaries', () => {
  test('the same recovered stream is collected once', () => {
    const p = parseCommand('echo date | sh', run);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    p.substitutions.push(...Array(70).fill(p.substitutions[0]!));
    const scan = execUnits(p, run);
    expect(scan.unresolved).toBeUndefined();
    expect(scan.units.filter(s => s === 'date').length).toBe(1);
  });
  test('distinct substitution executions share the ordinary unit budget', () => {
    const substitutions = Array.from({ length: 70 }, (_, i) => `$(printf safe${i})`).join(' ');
    expect(tag(`printf "%s" "${substitutions}"`)).toBe('deny:D000');
  });
  test('deep script wrappers fail closed', () => {
    let cmd = 'printf ok';
    for (let i = 0; i < 8; i++) cmd = 'bash -c ' + JSON.stringify(cmd);
    expect(tag(cmd)).toBe('deny:D000');
  });
  test('ordinary variable substitutions retain tolerant inspection', () => {
    expect(tag('x=$($TOOL)')).toBe('allow');
    expect(tag("bash -c 'printf ok | cat'")).toBe('allow');
  });
  test('a file inside a wrapper does not consume the outer ordinary budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-stream-file-'));
    const path = join(dir, 'safe.sh');
    writeFileSync(path, Array.from({ length: 40 }, (_, i) => `printf file${i}`).join('\n'));
    const script = Array.from({ length: 50 }, (_, i) => `printf outer${i}`).join('; ') + '; bash < ' + path;
    try {
      const p = parseCommand('bash -c ' + JSON.stringify(script), run);
      const scan = execUnits(p, run);
      expect(scan.units.length).toBeGreaterThan(64);
      expect(scan.unresolved).toBeUndefined();
      expect(tag('bash -c ' + JSON.stringify(script))).toBe('allow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
