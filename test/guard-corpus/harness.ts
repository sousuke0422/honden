/**
 * 門の判じを群れで撃ち、記録（golden）と比べる仕組み。
 *
 * # 何を縛るか
 *
 * 門の直しや解き手の上げは、どこかの命の判じを黙って替えうる。試験の一件ずつでは
 * 「替わった命」を全て拾えぬ。群れの全てを撃ち、前の判じと食い違えば落とす。
 *
 * 食い違いは三つに分けて出す。
 *
 * - 止める側に変わった物（通す → 止める）
 * - 通す側に変わった物（止める → 通す）
 * - 札だけ替わった物（止める → 別の札で止める）
 *
 * # 攻撃の印
 *
 * 群れの各件は、攻撃の形（`attack`）か無害な形（`benign`）かの印を持つ。
 * **攻撃の形が通す側に変われば、記録を書き換える旗でも書き換えぬ。** 門が緩んだ
 * 上げを、記録を書き換えて通すことはできぬ。緩める変更なら、群れの件を直に
 * 書き換えて、差分で人に見せること。
 *
 * # 群れの形
 *
 * 一行一件の JSON（`{"kind":…,"expect":…,"cmd":…}`）。`expect` は `allow` か
 * `deny:<札>`。並びは印と命の字の順に揃え、差分が一件ずつ読めるようにする。
 * 新しく足す件は `expect` を書かずに置き、記録を書き換える旗で埋める。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export type Kind = 'attack' | 'benign';

export interface Case {
  kind: Kind;
  /** 記録された判じ。`allow` か `deny:<札>`。まだ記録の無い件は undefined */
  expect?: string;
  cmd: string;
}

export interface Change {
  kind: Kind;
  cmd: string;
  was: string;
  now: string;
}

export interface Diff {
  /** 通す → 止める */
  toDeny: Change[];
  /** 止める → 通す */
  toAllow: Change[];
  /** 止める → 別の札で止める */
  ruleChanged: Change[];
  /** まだ記録の無い件 */
  unrecorded: Change[];
  /** 攻撃の形のうち、通す側に変わった物（toAllow の部分集合）。記録を書き換えても通らぬ */
  attackToAllow: Change[];
}

/** 判じを記録の字へ畳む。 */
export function tag(v: { permission: string; rule?: string }): string {
  return v.permission === 'deny' ? `deny:${v.rule ?? '?'}` : 'allow';
}

export function parseCases(text: string, where = '群れ'): Case[] {
  const out: Case[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`${where} の ${i + 1} 行目が JSON として読めぬ`);
    }
    const c = o as Partial<Case>;
    if (c.kind !== 'attack' && c.kind !== 'benign') throw new Error(`${where} の ${i + 1} 行目の kind が attack でも benign でもない`);
    if (typeof c.cmd !== 'string' || c.cmd === '') throw new Error(`${where} の ${i + 1} 行目に cmd が無い`);
    if (c.expect !== undefined && !/^(allow|deny:\S+)$/.test(c.expect)) {
      throw new Error(`${where} の ${i + 1} 行目の expect が allow か deny:<札> でない`);
    }
    out.push({ kind: c.kind, expect: c.expect, cmd: c.cmd });
  });
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.cmd)) throw new Error(`${where} に同じ命が二度ある: ${JSON.stringify(c.cmd)}`);
    seen.add(c.cmd);
  }
  return out;
}

export function loadCases(path: string): Case[] {
  return parseCases(readFileSync(path, 'utf8'), path);
}

/** 印・命の字の順に並べ、一行一件で書く。鍵の順も固める。 */
export function serialize(cases: Case[]): string {
  const sorted = [...cases].sort((a, b) =>
    a.kind === b.kind ? (a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0) : a.kind === 'attack' ? -1 : 1,
  );
  return sorted.map((c) => JSON.stringify({ kind: c.kind, expect: c.expect, cmd: c.cmd })).join('\n') + '\n';
}

/** 群れの全てを撃ち、記録と比べる。 */
export function runCases(cases: Case[], judge: (cmd: string) => string): { actual: Map<string, string>; diff: Diff } {
  const actual = new Map<string, string>();
  const diff: Diff = { toDeny: [], toAllow: [], ruleChanged: [], unrecorded: [], attackToAllow: [] };
  for (const c of cases) {
    const now = judge(c.cmd);
    actual.set(c.cmd, now);
    const ch: Change = { kind: c.kind, cmd: c.cmd, was: c.expect ?? '（記録なし）', now };
    if (c.expect === undefined) diff.unrecorded.push(ch);
    else if (c.expect === now) continue;
    else if (now === 'allow') {
      diff.toAllow.push(ch);
      if (c.kind === 'attack') diff.attackToAllow.push(ch);
    } else if (c.expect === 'allow') diff.toDeny.push(ch);
    else diff.ruleChanged.push(ch);
  }
  return { actual, diff };
}

export function diffCount(d: Diff): number {
  return d.toDeny.length + d.toAllow.length + d.ruleChanged.length + d.unrecorded.length;
}

/** 食い違いを人が読む形にする。命の全文を出す（手元の群れでは秘密が混じりうる）。 */
export function formatDiff(d: Diff): string {
  const lines: string[] = [];
  const section = (title: string, xs: Change[]) => {
    if (xs.length === 0) return;
    lines.push(`## ${title}（${xs.length} 件）`);
    for (const x of xs) lines.push(`  [${x.kind}] ${x.was} → ${x.now}  ${JSON.stringify(x.cmd)}`);
  };
  section('攻撃の形が通す側に変わった物。記録を書き換えても通らぬ', d.attackToAllow);
  section('止める側に変わった物（通す → 止める）', d.toDeny);
  section('通す側に変わった物（止める → 通す）', d.toAllow);
  section('札だけ替わった物', d.ruleChanged);
  section('まだ記録の無い件', d.unrecorded);
  return lines.join('\n');
}

/**
 * 記録を今の判じで書き換えた群れを返す。**攻撃の形が通す側に変わっておれば断る。**
 */
export function updated(cases: Case[], actual: Map<string, string>, d: Diff): { ok: true; cases: Case[] } | { ok: false; refused: Change[] } {
  if (d.attackToAllow.length > 0) return { ok: false, refused: d.attackToAllow };
  return { ok: true, cases: cases.map((c) => ({ ...c, expect: actual.get(c.cmd) ?? c.expect })) };
}

export function writeCases(path: string, cases: Case[]): void {
  writeFileSync(path, serialize(cases));
}
