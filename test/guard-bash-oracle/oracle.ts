/**
 * 群れの全件で物差し（箱の中の bash）と解き手を比べ、違う件を記録（test/fixtures/guard-bash-oracle.jsonl）と照らす。
 *
 * 記録の一行は、違う件の命の字・違いの中身・その分け（解き手の読み違い・物差しの限り・比べの形の違い）・
 * 判じに効くか。判じに効く読み違いの件は、#56 の群れ（guard-corpus.jsonl）にも、今の門の判じのまま入れてある。
 */
import { readFileSync } from 'node:fs';
import type { Runner } from '../../src/parse';
import type { Case } from '../guard-corpus/harness';
import { compare, type Compared } from './compare';

export const CLASSES = ['解き手の読み違い', '物差しの限り', '比べの形の違い', '未分類'] as const;
export type Class = (typeof CLASSES)[number];

export interface Entry {
  cmd: string;
  /** 違いの分け */
  class: Class;
  /** 分けの訳（同じ訳の件は同じ字にする） */
  why: string;
  /** 判じに効く読み違い（止めるべき命を取りこぼす・無害な命を止める）か */
  impact: boolean;
  onlyBash: string[][];
  onlySolver: string[][];
  solverError?: true;
  timedOut?: true;
}

/** 違いの中身（記録と比べる所） */
export function shape(c: Compared): Pick<Entry, 'onlyBash' | 'onlySolver' | 'solverError' | 'timedOut'> {
  return {
    onlyBash: c.onlyBash,
    onlySolver: c.onlySolver,
    ...(c.solverError ? { solverError: true as const } : {}),
    ...(c.timedOut ? { timedOut: true as const } : {}),
  };
}

export function differs(c: Compared): boolean {
  return c.onlyBash.length > 0 || c.onlySolver.length > 0 || c.solverError !== undefined || c.timedOut || c.unreadable.length > 0;
}

/** 群れの全件を比べ、違う件だけを返す */
export function runOracle(cases: Case[], run: Runner): Compared[] {
  return cases.map((c) => compare(c.cmd, run)).filter(differs);
}

export function loadEntries(path: string): Entry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Entry);
}

/** 分け・命の字の順に並べ、一行一件で書く。鍵の順も固める。 */
export function serializeEntries(entries: Entry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.class === b.class ? (a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0) : CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class),
  );
  return (
    sorted
      .map((e) =>
        JSON.stringify({
          class: e.class,
          impact: e.impact,
          why: e.why,
          cmd: e.cmd,
          onlyBash: e.onlyBash,
          onlySolver: e.onlySolver,
          ...(e.solverError ? { solverError: true } : {}),
          ...(e.timedOut ? { timedOut: true } : {}),
        }),
      )
      .join('\n') + '\n'
  );
}

/** 今の違いを、記録の分けを引き継いで記録の形にする。記録に無い件は「未分類」になる。 */
export function toEntries(diffs: Compared[], recorded: Entry[]): Entry[] {
  const byCmd = new Map(recorded.map((e) => [e.cmd, e]));
  return diffs.map((d) => {
    const old = byCmd.get(d.cmd);
    return {
      cmd: d.cmd,
      class: old?.class ?? '未分類',
      why: old?.why ?? '',
      impact: old?.impact ?? false,
      ...shape(d),
    };
  });
}

/** 記録と今の違いの食い違い（無くなった件・増えた件・中身の替わった件） */
export function mismatch(diffs: Compared[], recorded: Entry[]): { gone: string[]; added: string[]; changed: string[] } {
  const now = new Map(diffs.map((d) => [d.cmd, JSON.stringify(shape(d))]));
  const was = new Map(
    recorded.map((e) => [
      e.cmd,
      JSON.stringify({ onlyBash: e.onlyBash, onlySolver: e.onlySolver, ...(e.solverError ? { solverError: true } : {}), ...(e.timedOut ? { timedOut: true } : {}) }),
    ]),
  );
  return {
    gone: [...was.keys()].filter((k) => !now.has(k)),
    added: [...now.keys()].filter((k) => !was.has(k)),
    changed: [...now.keys()].filter((k) => was.has(k) && was.get(k) !== now.get(k)),
  };
}
