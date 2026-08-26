/**
 * ファイルへ差分を当てる。
 *
 * ## なぜ要るか
 *
 * `str.replace(a, b)` は、当てはまる所を**全部**書き換える。
 * 「a が在るか」は確かめられても、「a が一つだけか」は確かめない。
 * 二箇所に在れば黙って両方直す。
 *
 * この実装を書いておる間、将軍自身がその形で何十回も編集した
 * （`assert a in t; t = t.replace(a, b)`）。害は出なかったが、
 * **出なかったのは運であって、道具が守ったのではない。**
 *
 * 差分なら、当てる前に「思っておる中身か」を検められる (src/patch.ts)。
 * その厳しさをファイルにも効かせる。
 *
 * ## 全部当たるか、何も書かないか
 *
 * 複数のファイルにまたがる差分で、途中まで書いて止まると、
 * 半端な状態がディスクに残る。**全部当ててから、まとめて書く。**
 *
 * ## 無い所には当てない
 *
 * 差分の宛先が実在せぬなら断る。新しいファイルは差分で作らない——
 * 「空に対する差分」を許すと、書き間違えた宛先が新しいファイルとして生まれる。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseUnified, applyHunks } from './patch';

export interface PatchFileResult {
  ok: boolean;
  message?: string;
  out?: string;
  /** 当たった先と、行数の増減。 */
  changed?: { path: string; before: number; after: number }[];
}

export interface Options {
  /** 差分の中の相対パスを解く基点。既定は cwd。 */
  root?: string;
  /** 書かずに、当たるかどうかだけ見る。 */
  dryRun?: boolean;
}

export function patchFiles(diff: string, opts: Options = {}): PatchFileResult {
  const root = resolve(opts.root ?? process.cwd());

  const parsed = parseUnified(diff);
  if (!parsed.ok) return { ok: false, message: `${parsed.message}\n  何も書いておらぬ。` };

  const staged: { path: string; text: string; before: number; after: number }[] = [];

  for (const fp of parsed.patches) {
    // 宛先が木の外へ出ておらぬか。
    //
    // `../` を辿らせると、差分ひとつで木の外を書き換えられる。
    // 差分は人が手で書くものゆえ、書き間違いも起きる。
    const target = resolve(root, fp.field);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        ok: false,
        message: `宛先が木の外を指しておる: ${fp.field}\n  木の中だけを当てられよ。何も書いておらぬ。`,
      };
    }

    if (!existsSync(target)) {
      return {
        ok: false,
        message:
          `宛先が無い: ${fp.field}\n` +
          '  差分で新しいファイルは作らぬ。書き間違えた宛先が、\n' +
          '  新しいファイルとして生まれてしまうゆえ。何も書いておらぬ。',
      };
    }
    if (statSync(target).isDirectory()) {
      return { ok: false, message: `宛先がディレクトリである: ${fp.field}` };
    }

    const original = readFileSync(target, 'utf8');
    const got = applyHunks(original, fp.hunks, fp.field);
    if (!got.ok) return { ok: false, message: got.message };

    staged.push({
      path: target,
      text: got.text,
      before: original.split('\n').length,
      after: got.text.split('\n').length,
    });
  }

  const changed = staged.map((s) => ({ path: relative(root, s.path), before: s.before, after: s.after }));

  if (opts.dryRun) {
    return {
      ok: true,
      changed,
      out: [
        '  当たる。まだ書いておらぬ (--dry-run)',
        ...changed.map((c) => `    ${c.path}  ${c.before} 行 → ${c.after} 行`),
      ].join('\n'),
    };
  }

  // ここまで来た時点で全部当たっておる。まとめて書く。
  for (const s of staged) writeFileSync(s.path, s.text);

  return {
    ok: true,
    changed,
    out: [
      `  ${staged.length} 本へ当てた。`,
      ...changed.map((c) => `    ${c.path}  ${c.before} 行 → ${c.after} 行`),
    ].join('\n'),
  };
}
