/**
 * 箱の中の bash を物差しにして、解き手（bin/honden-parse）が取り出す argv を検める試験。
 *
 * 一、箱と記録係の陽性対照（命が走らぬ・shell を呼び直せぬ・網に出られぬ・家と repo が見えぬ・
 *     外した組み込みが効かぬ）。ここが通らねば、群れは箱へ渡さぬ
 * 二、#56 の群れの全件で、bash が exec しようとした argv と解き手の argv を比べ、違う件と、その分け
 *     （test/fixtures/guard-bash-oracle.jsonl）が記録どおりであること
 * 三、判じに効く読み違いの件が、#56 の群れに入っておること
 *
 * 箱（bubblewrap と利用者の名前空間）が作れぬ環境では、撃たずに飛ばす（落ちぬ）。
 * 記録を書き換えるのは `bun run test:guard-bash-oracle --update`（分けは引き継ぎ、新しい件は「未分類」）。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { realRunner } from '../src/parse';
import { probe } from './guard-bash-oracle/box';
import { runControls } from './guard-bash-oracle/controls';
import { loadEntries, mismatch, runOracle, shape } from './guard-bash-oracle/oracle';
import { loadCases } from './guard-corpus/harness';

const ROOT = join(import.meta.dir, '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'guard-corpus.jsonl');
const RECORD = join(ROOT, 'test', 'fixtures', 'guard-bash-oracle.jsonl');
const why = probe();

describe('記録の形（箱を要さぬ）', () => {
  const entries = loadEntries(RECORD);

  test('全ての違いに分けと訳があり、未分類が無い', () => {
    expect(entries.filter((e) => e.class === '未分類').map((e) => e.cmd)).toEqual([]);
    expect(entries.filter((e) => e.why === '').map((e) => e.cmd)).toEqual([]);
  });

  test('判じに効く読み違いは、#56 の群れに入っておる', () => {
    const corpus = new Set(loadCases(CORPUS).map((c) => c.cmd));
    const impact = entries.filter((e) => e.impact);
    expect(impact.length).toBeGreaterThan(0);
    expect(impact.every((e) => e.class === '解き手の読み違い')).toBe(true);
    expect(impact.filter((e) => !corpus.has(e.cmd)).map((e) => e.cmd)).toEqual([]);
  });
});

describe.skipIf(why !== undefined)(`箱の中の bash を物差しにする${why ? `（飛ばす: ${why}）` : ''}`, () => {
  const controls = runControls();

  test.each(controls.map((c) => [c.name, c] as const))('陽性対照: %s', (_name, c) => {
    expect(c.ok, `緩めた箱: ${JSON.stringify(c.loosened)}\n記録係の箱: ${JSON.stringify(c.boxed)}`).toBe(true);
  });

  test('群れの全件で、bash と解き手の argv の違いが記録どおり', () => {
    // 陽性対照が一つでも落ちれば、群れは箱へ渡さぬ
    expect(controls.every((c) => c.ok)).toBe(true);
    const diffs = runOracle(loadCases(CORPUS), realRunner(ROOT));
    const m = mismatch(diffs, loadEntries(RECORD));
    // 落ちた時に中身が見えねば直せぬ。増えた件と替わった件の今の違いを添える
    const now = diffs
      .filter((d) => m.added.includes(d.cmd) || m.changed.includes(d.cmd))
      .map((d) => JSON.stringify({ cmd: d.cmd, ...shape(d) }))
      .join('\n');
    expect(m, `違いが記録と食い違う。正しい変化なら bun run test:guard-bash-oracle --update で書き換え、分けを付ける\n${now}`).toEqual({
      gone: [],
      added: [],
      changed: [],
    });
  }, 120_000);
});
