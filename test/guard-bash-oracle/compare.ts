/**
 * 群れの各件で、箱の中の bash が exec しようとした argv（物差し）と、解き手（bin/honden-parse）が取り出した
 * 単純命令の argv を比べる。
 *
 * - 解き手の側: 上の層の単純命令に、命令置換の中身を解き直した単純命令を足す（深さ 3 まで）。heredoc の中身は
 *   命令位置に入らぬゆえ足さぬ。語は引用を剥いだ値（`value`）で比べる
 * - 物差しの側: 記録係が eval に渡した一件目を除いた、全ての単純命令（関数の中・置換の中・eval の中を含む）
 * - bash の xtrace は複合命令の頭（`[[ … ]]`・`case … in`・`for … in …`・`select`・`(( … ))`）も件として出す。
 *   これは単純命令ではないゆえ比べから除き、`compound` に別に置く
 * - 比べは argv の集まり（重なりは一つに畳む）で行う。並びは比べぬ
 */
import { type Parsed, parseCommand, type Runner } from '../../src/parse';
import { record } from './box';
import { parseTrace } from './xtrace';

export interface Compared {
  cmd: string;
  /** 物差しだけに在る argv（bash は exec しようとしたが、解き手は取り出さなかった） */
  onlyBash: string[][];
  /** 解き手だけに在る argv（解き手は取り出したが、bash は exec しようとしなかった） */
  onlySolver: string[][];
  bash: string[][];
  solver: string[][];
  /** bash の xtrace が出した複合命令の頭（比べぬ） */
  compound: string[][];
  /** 解き手が解けなかった（門は拒みに倒す） */
  solverError?: string;
  /** 物差しが時限で殺された（記録は途中まで） */
  timedOut: boolean;
  /** 記録の行を語に戻せなかった物 */
  unreadable: string[];
}

function solverArgv(p: Parsed, run: Runner, depth: number, out: string[][]): void {
  if (!p.ok) return;
  for (const c of p.commands) if (c.argv.length > 0) out.push(c.argv.map((w) => w.value));
  if (depth <= 0) return;
  for (const s of p.substitutions) solverArgv(parseCommand(s, run), run, depth - 1, out);
}

const key = (argv: string[]) => JSON.stringify(argv);

const COMPOUND_HEADS = new Set(['[[', 'case', 'for', 'select', '((']);

function uniq(list: string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const a of list) seen.set(key(a), a);
  return [...seen.values()];
}

export function compare(cmd: string, run: Runner): Compared {
  const parsed = parseCommand(cmd, run);
  const solver: string[][] = [];
  solverArgv(parsed, run, 3, solver);
  const box = record(cmd);
  const { traced, unreadable } = parseTrace(box.stdout);
  // 一件目は記録係の `eval "$case_text"` そのもの
  const all = traced.slice(1).filter((t) => t.argv.length > 0).map((t) => t.argv);
  const compound = all.filter((a) => COMPOUND_HEADS.has(a[0]!));
  const bash = all.filter((a) => !COMPOUND_HEADS.has(a[0]!));
  const s = uniq(solver);
  const b = uniq(bash);
  const sk = new Set(s.map(key));
  const bk = new Set(b.map(key));
  return {
    cmd,
    onlyBash: b.filter((a) => !sk.has(key(a))),
    onlySolver: s.filter((a) => !bk.has(key(a))),
    bash: b,
    solver: s,
    compound: uniq(compound),
    ...(parsed.ok ? {} : { solverError: parsed.reason }),
    timedOut: box.timedOut,
    unreadable,
  };
}
