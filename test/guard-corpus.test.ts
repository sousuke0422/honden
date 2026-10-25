/**
 * 門の判じを群れで撃ち、記録（golden）と比べる試験。
 *
 * 群れと記録は test/fixtures/guard-corpus.jsonl に一行一件で置く。食い違いが出れば、
 * 止める側に変わった物と通す側に変わった物を分けて落ちる。正しい変化なら
 * `bun run test:guard-corpus --update` で記録を書き換え、差分を PR に載せる。
 * 攻撃の形が通す側に変われば、その書き換えも断る。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { realRunner } from '../src/parse';
import { type Case, diffCount, formatDiff, loadCases, parseCases, runCases, serialize, tag, updated } from './guard-corpus/harness';

const ROOT = join(import.meta.dir, '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'guard-corpus.jsonl');
const run = realRunner(ROOT);

describe('公開の群れの判じが記録どおり', () => {
  const cases = loadCases(CORPUS);

  test('群れは攻撃の形と無害な形の両方を持ち、全ての件に記録がある', () => {
    expect(cases.filter((c) => c.kind === 'attack').length).toBeGreaterThan(100);
    expect(cases.filter((c) => c.kind === 'benign').length).toBeGreaterThan(100);
    expect(cases.filter((c) => c.expect === undefined).map((c) => c.cmd)).toEqual([]);
  });

  test('群れの file は並べ直した形のまま（差分が一件ずつ読める）', () => {
    expect(readFileSync(CORPUS, 'utf8')).toBe(serialize(cases));
  });

  test('全ての件の判じが記録と食い違わぬ', () => {
    const { diff } = runCases(cases, (cmd) => tag(judgeStructured(cmd, run)));
    expect(diff.attackToAllow, formatDiff(diff)).toEqual([]);
    expect(diffCount(diff), `門の判じが記録と食い違う:\n${formatDiff(diff)}`).toBe(0);
  }, 60_000);
});

describe('食い違いの分け方（贋の判じで縛る）', () => {
  const cases: Case[] = [
    { kind: 'attack', expect: 'deny:D001', cmd: 'a1' },
    { kind: 'attack', expect: 'deny:D006', cmd: 'a2' },
    { kind: 'benign', expect: 'allow', cmd: 'b1' },
    { kind: 'benign', expect: 'deny:D007', cmd: 'b2' },
    { kind: 'benign', expect: 'deny:D005', cmd: 'b3' },
    { kind: 'benign', cmd: 'b4' },
  ];
  const judgeWith = (m: Record<string, string>) => (cmd: string) => m[cmd] ?? 'allow';

  test('止める側・通す側・札の替わり・記録なしに分ける', () => {
    const { diff } = runCases(cases, judgeWith({ a1: 'deny:D001', a2: 'allow', b1: 'deny:D006', b2: 'allow', b3: 'deny:D000', b4: 'allow' }));
    expect(diff.toDeny.map((x) => x.cmd)).toEqual(['b1']);
    expect(diff.toAllow.map((x) => x.cmd)).toEqual(['a2', 'b2']);
    expect(diff.attackToAllow.map((x) => x.cmd)).toEqual(['a2']);
    expect(diff.ruleChanged.map((x) => x.cmd)).toEqual(['b3']);
    expect(diff.unrecorded.map((x) => x.cmd)).toEqual(['b4']);
    expect(diffCount(diff)).toBe(5);
    const text = formatDiff(diff);
    expect(text).toContain('攻撃の形が通す側に変わった物');
    expect(text).toContain('止める側に変わった物');
    expect(text).toContain('通す側に変わった物');
  });

  test('攻撃の形が通す側に変われば、記録の書き換えを断る', () => {
    const { actual, diff } = runCases(cases, judgeWith({ a1: 'allow', a2: 'deny:D006', b2: 'deny:D007', b3: 'deny:D005' }));
    const u = updated(cases, actual, diff);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.refused.map((x) => x.cmd)).toEqual(['a1']);
  });

  test('無害な形の変化と、攻撃の形が止める側へ変わるのは書き換えられる', () => {
    const { actual, diff } = runCases(cases, judgeWith({ a1: 'deny:D000', a2: 'deny:D006', b1: 'deny:D006', b2: 'allow', b3: 'deny:D005' }));
    const u = updated(cases, actual, diff);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.cases.find((c) => c.cmd === 'b1')?.expect).toBe('deny:D006');
      expect(u.cases.find((c) => c.cmd === 'a1')?.expect).toBe('deny:D000');
      expect(u.cases.find((c) => c.cmd === 'b4')?.expect).toBe('allow');
    }
  });

  test('読めぬ行・同じ命の二度書き・知らぬ印は拒む', () => {
    expect(() => parseCases('{"kind":"x","cmd":"a"}')).toThrow('kind');
    expect(() => parseCases('{"kind":"benign","cmd":"a"}\n{"kind":"attack","cmd":"a"}')).toThrow('二度');
    expect(() => parseCases('not json')).toThrow('JSON');
    expect(() => parseCases('{"kind":"benign","expect":"maybe","cmd":"a"}')).toThrow('expect');
  });
});

describe('手元の群れ（repo の外）を同じ仕組みで撃てる', () => {
  const script = join(ROOT, 'scripts', 'guard-corpus.ts');
  const sh = (env: Record<string, string>, ...args: string[]) =>
    Bun.spawnSync(['bun', script, ...args], { env: { ...process.env, ...env }, cwd: ROOT });

  test('記録を作り、次は食い違い無しで通り、記録を書き換えれば落ちる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-corpus-'));
    try {
      const corpus = join(dir, 'history.json');
      writeFileSync(corpus, JSON.stringify(['ls -la', 'git status', 'rm -rf /']));
      const env = { HONDEN_GUARD_CORPUS: corpus };

      expect(sh(env).exitCode, '記録が無ければ記録なしとして落ちる').toBe(1);
      expect(sh(env, '--update').exitCode).toBe(0);
      const golden = join(dir, 'history.json.golden.jsonl');
      expect(loadCases(golden).find((c) => c.cmd === 'rm -rf /')?.expect).toBe('deny:D001');
      expect(sh(env).exitCode).toBe(0);

      writeFileSync(golden, readFileSync(golden, 'utf8').replace('"expect":"deny:D001"', '"expect":"allow"'));
      const r = sh(env);
      expect(r.exitCode).toBe(1);
      expect(new TextDecoder().decode(r.stdout)).toContain('止める側に変わった物');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
