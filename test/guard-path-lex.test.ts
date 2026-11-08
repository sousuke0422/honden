import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { patchTargets, realRunner } from '../src/parse';

const root = join(import.meta.dir, '..');
const run = realRunner(root);
const tag = (cmd: string) => {
  const v = judgeStructured(cmd, run);
  return v.permission === 'deny' ? `deny:${v.rule}` : 'allow';
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const cases: { id: string; lang: string; flag: string; source: string; expect: string }[] =
  readFileSync(join(import.meta.dir, 'fixtures/guard-source-literals.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('Python literal correction and conservative legacy language scans', () => {
  for (const c of cases) test(c.id, () => {
    expect(tag(`${c.lang} ${c.flag} ${quote(c.source)}`)).toBe(c.expect);
  });
});

const reviewCases: { id: string; cmd: string; expect: string }[] =
  readFileSync(join(import.meta.dir, 'fixtures/guard-source-review.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
describe('independent review probes never lose executable calls', () => {
  for (const c of reviewCases) test(c.id, () => {
    expect(tag(c.cmd)).toBe(c.expect);
  });
});

const pythonCases: { id: string; cmd: string; expect: string; category: string }[] =
  readFileSync(join(import.meta.dir, 'fixtures/guard-python-source.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
describe('Python source execution descends or rejects unknown source', () => {
  for (const c of pythonCases) test(`${c.category}:${c.id}`, () => {
    expect(tag(c.cmd)).toBe(c.expect);
  });
});

describe('patch path normalization', () => {
  const plain = readFileSync(join(import.meta.dir, 'fixtures/guard-patches/plain.diff'), 'utf8');
  const fixture = (target: string) => plain.replace(/(?<=a\/|b\/)\S+(?=\n| )/g, target);
  for (const target of ['bin//honden', '.claude//settings.json']) {
    test(`protected repeated separators: ${target}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'guard-path-lex-'));
      const path = join(dir, 'change.diff');
      writeFileSync(path, fixture(target));
      try {
        for (const cmd of [`git apply ${path}`, `patch -p1 < ${path}`, `cat ${path} | git apply`]) {
          expect(tag(cmd)).toBe('deny:D012');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  test('normalizes in-repository dot segments in all headers', () => {
    expect(patchTargets('diff --git a/x/../bin//honden b/x/../bin//honden\nrename from bin//honden\ncopy to bin//honden'))
      .toEqual(['a/bin/honden', 'b/bin/honden', 'bin/honden']);
  });
  test('escaping the repository fails closed for file and stdin patches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-path-lex-'));
    const path = join(dir, 'outside.diff');
    writeFileSync(path, fixture('../../outside'));
    try {
      for (const cmd of [`git apply ${path}`, `patch -p1 < ${path}`, `cat ${path} | git apply`]) {
        expect(tag(cmd)).toBe('deny:D000');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
