import { describe, expect, test } from 'bun:test';
import { probe } from './guard-bash-oracle/box';
import { runControls } from './guard-bash-oracle/controls';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mismatch, serializeEntries, toEntries, updateRecord, type Entry } from './guard-bash-oracle/oracle';
import type { Compared } from './guard-bash-oracle/compare';

const why = probe();
describe.skipIf(why !== undefined)('oracle executable controls', () => {
  const controls = why === undefined ? runControls() : [];
  for (const id of ['REEXEC-ORACLE', 'REEXEC-PROC']) {
    test(id, () => {
      const c = controls.find((c) => c.name === id)!;
      expect(c.loosened.includes('MARK'), id + ' positive marker').toBe(true);
      expect(c.boxed.marks.includes('END'), id + ' completion marker').toBe(true);
      expect(c.ok, id + ' marks=' + JSON.stringify(c.boxed.marks)).toBe(true);
    });
  }
});

describe('unreadable measurements are never compared or updated', () => {
  const cases: { id: string; cmd: string; onlyBash: string[][]; onlySolver: string[][]; fragment: string }[] =
    JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/guard-oracle-unreadable.json'), 'utf8'));
  for (const c of cases) {
    const diff: Compared = { cmd: c.cmd, onlyBash: c.onlyBash, onlySolver: c.onlySolver,
      bash: [], solver: [], compound: [], timedOut: false, unreadable: [c.fragment] };
    const recorded: Entry[] = c.onlyBash.length === 0 ? [] : [{ cmd: c.cmd, class: '物差しの限り',
      why: 'test record', impact: false, onlyBash: c.onlyBash, onlySolver: c.onlySolver }];
    test(c.id + ' comparison and diagnostics', () => {
      expect(() => mismatch([diff], recorded)).toThrow(c.fragment);
      expect(() => toEntries([diff], recorded)).toThrow(c.cmd);
    });
    test(c.id + ' CLI --update refuses the measurement', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oracle-cli-test-'));
      const fixtures = join(dir, 'test/fixtures');
      const scripts = join(dir, 'scripts');
      mkdirSync(fixtures, { recursive: true });
      mkdirSync(scripts);
      const path = join(fixtures, 'guard-bash-oracle.jsonl');
      const before = serializeEntries(recorded);
      writeFileSync(path, before);
      writeFileSync(join(fixtures, 'guard-corpus.jsonl'), JSON.stringify({ cmd: c.cmd, kind: 'benign' }) + '\n');
      const actualScripts = join(import.meta.dir, '../scripts');
      const source = readFileSync(join(actualScripts, 'guard-bash-oracle.ts'), 'utf8')
        .replace(/from '(\.\.[^']+)'/g, (_, relative) => `from ${JSON.stringify(resolve(actualScripts, relative))}`);
      const main = join(scripts, 'oracle.ts');
      writeFileSync(main, source);
      const oraclePath = join(import.meta.dir, 'guard-bash-oracle/oracle.ts');
      const preload = join(dir, 'preload.ts');
      writeFileSync(preload, `import { mock } from 'bun:test';
const original = await import(${JSON.stringify(oraclePath)});
mock.module(${JSON.stringify(oraclePath)}, () => ({ ...original, runOracle: () => [${JSON.stringify(diff)}] }));
mock.module(${JSON.stringify(join(import.meta.dir, 'guard-bash-oracle/box.ts'))}, () => ({ probe: () => undefined }));
mock.module(${JSON.stringify(join(import.meta.dir, 'guard-bash-oracle/controls.ts'))}, () => ({ runControls: () => [] }));
`);
      try {
        const result = Bun.spawnSync([process.execPath, '--preload', preload, main, '--update']);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(c.cmd);
        expect(result.stderr.toString()).toContain(c.fragment);
        expect(readFileSync(path, 'utf8')).toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    test(c.id + ' --update preserves bytes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oracle-record-test-'));
      const path = join(dir, 'record.jsonl');
      const before = serializeEntries(recorded);
      writeFileSync(path, before);
      try {
        expect(() => updateRecord(path, [diff], recorded)).toThrow(c.fragment);
        expect(readFileSync(path, 'utf8')).toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
