/**
 * 門の判じを群れで撃ち、記録（golden）と比べる。
 *
 *   bun scripts/guard-corpus.ts            repo の群れ（test/fixtures/guard-corpus.jsonl）を撃つ
 *   bun scripts/guard-corpus.ts --update   記録を今の判じで書き換える（攻撃の形が通す側に
 *                                          変わっておれば断る）
 *
 * 手元の群れ（repo の外。実際に打たれた命の履歴など）:
 *
 *   HONDEN_GUARD_CORPUS=<file> bun scripts/guard-corpus.ts [--update]
 *
 *   <file> は命の字の JSON 配列か、群れと同じ一行一件の JSON。記録は
 *   HONDEN_GUARD_CORPUS_GOLDEN（既定は <file>.golden.jsonl）に置く。これも repo の外に置け。
 *   JSON 配列の履歴には印が無いゆえ、記録の無い件は無害な形（benign）として撃つ。
 *   一行一件の JSON は入力の kind と expect を保持する。既存の記録があれば
 *   その expect を使い、kind が入力と食い違えば書き換えずに断る。
 *
 * **食い違いは命の全文を出す。** 手元の群れの命には、秘密・手元の道・人の名が混じりうる。
 * 出力を貼る先に気をつけよ。
 *
 * 終わりの値: 0 食い違い無し（または書き換えた）/ 1 食い違いあり、または書き換えを断った / 2 旗の誤り
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeStructured } from '../src/guard';
import { realRunner } from '../src/parse';
import { type Case, diffCount, formatDiff, loadCases, parseCases, runCases, tag, updated, writeCases } from '../test/guard-corpus/harness';

const ROOT = join(import.meta.dir, '..');
export const PUBLIC_CORPUS = join(ROOT, 'test', 'fixtures', 'guard-corpus.jsonl');

const args = process.argv.slice(2);
const update = args.includes('--update');
const unknown = args.filter((a) => a !== '--update');
if (unknown.length > 0) {
  console.error(`知らぬ旗: ${unknown.join(' ')}（使えるのは --update だけ）`);
  process.exit(2);
}

/** 印のある入力を保持し、既存の記録を期待値の正本にする。 */
function localCases(corpusPath: string, goldenPath: string): Case[] {
  const text = readFileSync(corpusPath, 'utf8');
  let input: Case[];
  const trimmed = text.trimStart();
  const labeled = !trimmed.startsWith('[');
  if (!labeled) {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) throw new Error(`${corpusPath} が命の字の配列でない`);
    input = arr.map((cmd) => ({ kind: 'benign', cmd }));
  } else {
    input = parseCases(text, corpusPath);
  }
  const golden = existsSync(goldenPath) ? loadCases(goldenPath) : [];
  const byCmd = new Map(golden.map((c) => [c.cmd, c]));
  return [...new Map(input.map((c) => [c.cmd, c])).values()].map((c) => {
    const recorded = byCmd.get(c.cmd);
    if (!recorded) return c;
    if (labeled && recorded.kind !== c.kind) {
      throw new Error(`${corpusPath}: kind が記録と食い違う（入力 ${c.kind} / 記録 ${recorded.kind}）。記録は書き換えぬ`);
    }
    return recorded;
  });
}

const localPath = process.env.HONDEN_GUARD_CORPUS;
const goldenPath = localPath ? (process.env.HONDEN_GUARD_CORPUS_GOLDEN ?? `${localPath}.golden.jsonl`) : PUBLIC_CORPUS;
const cases = localPath ? localCases(localPath, goldenPath) : loadCases(PUBLIC_CORPUS);

const run = realRunner(ROOT);
const started = performance.now();
const { actual, diff } = runCases(cases, (cmd) => tag(judgeStructured(cmd, run)));
const ms = performance.now() - started;
console.error(`撃った: ${cases.length} 件（${(ms / 1000).toFixed(1)} 秒）  記録: ${goldenPath}`);

const n = diffCount(diff);
if (n > 0) console.log(formatDiff(diff));

if (update) {
  const u = updated(cases, actual, diff);
  if (!u.ok) {
    console.error(`書き換えを断った: 攻撃の形が ${u.refused.length} 件、通す側に変わった。門が緩んでおる`);
    process.exit(1);
  }
  writeCases(goldenPath, u.cases);
  console.error(`記録を書き換えた（食い違い ${n} 件）`);
  process.exit(0);
}
if (n > 0) {
  console.error(`食い違い ${n} 件。正しい変化なら --update で記録を書き換えよ`);
  process.exit(1);
}
console.error('食い違い無し');
