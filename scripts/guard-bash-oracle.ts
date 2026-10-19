/**
 * 箱の中の bash を物差しにして、#56 の群れの各件で解き手（bin/honden-parse）の argv と比べ、違う件を一覧にする。
 *
 *   bun scripts/guard-bash-oracle.ts            違いの一覧を出し、記録（test/fixtures/guard-bash-oracle.jsonl）と比べる
 *   bun scripts/guard-bash-oracle.ts --update   記録を今の違いで書き換える（分けは引き継ぎ、新しい件は「未分類」）
 *
 * 箱（bubblewrap と利用者の名前空間）が作れねば、撃たずに理由を出して 0 で終わる。
 * 箱の陽性対照が一つでも落ちれば、群れは箱へ渡さずに 1 で終わる。
 * 終わりの値: 0 食い違い無し（または書き換えた・箱が無く飛ばした）/ 1 食い違いあり・陽性対照の落ち / 2 旗の誤り
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realRunner } from '../src/parse';
import { probe } from '../test/guard-bash-oracle/box';
import { runControls } from '../test/guard-bash-oracle/controls';
import { loadEntries, mismatch, runOracle, serializeEntries, toEntries } from '../test/guard-bash-oracle/oracle';
import { loadCases } from '../test/guard-corpus/harness';

const ROOT = join(import.meta.dir, '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'guard-corpus.jsonl');
const RECORD = join(ROOT, 'test', 'fixtures', 'guard-bash-oracle.jsonl');

const args = process.argv.slice(2);
const update = args.includes('--update');
const unknown = args.filter((a) => a !== '--update');
if (unknown.length > 0) {
  console.error(`知らぬ旗: ${unknown.join(' ')}（使えるのは --update だけ）`);
  process.exit(2);
}

const why = probe();
if (why !== undefined) {
  console.log(`箱が作れぬゆえ撃たぬ: ${why}`);
  process.exit(0);
}
const controls = runControls();
for (const c of controls) console.log(`${c.ok ? '通る' : '落ちる'}  陽性対照: ${c.name}`);
if (!controls.every((c) => c.ok)) {
  console.error('陽性対照が落ちた。群れは箱へ渡さぬ');
  process.exit(1);
}

const started = performance.now();
const diffs = runOracle(loadCases(CORPUS), realRunner(ROOT));
const recorded = existsSync(RECORD) ? loadEntries(RECORD) : [];
const entries = toEntries(diffs, recorded);
const ms = Math.round(performance.now() - started);

const j = (list: string[][]) => list.map((a) => JSON.stringify(a)).join(' ');
for (const e of entries) {
  console.log(`[${e.class}${e.impact ? '・判じに効く' : ''}] ${JSON.stringify(e.cmd)}`);
  if (e.onlyBash.length > 0) console.log(`    bash だけ: ${j(e.onlyBash)}`);
  if (e.onlySolver.length > 0) console.log(`    解き手だけ: ${j(e.onlySolver)}`);
  if (e.solverError) console.log('    解き手が解けぬ（門は拒みに倒す）');
  if (e.timedOut) console.log('    物差しが時限で止めた（記録は途中まで）');
  if (e.why) console.log(`    訳: ${e.why}`);
}
console.log(`違う件 ${entries.length}（${ms} ms）`);

if (update) {
  writeFileSync(RECORD, serializeEntries(entries));
  console.log(`記録を書き換えた: ${RECORD}`);
  process.exit(0);
}
const m = mismatch(diffs, recorded);
const n = m.gone.length + m.added.length + m.changed.length;
if (n > 0) {
  console.error(`記録と食い違う: 無くなった ${m.gone.length}・増えた ${m.added.length}・替わった ${m.changed.length}`);
  for (const c of [...m.added, ...m.changed, ...m.gone]) console.error(`    ${JSON.stringify(c)}`);
  process.exit(1);
}
