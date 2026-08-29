/**
 * 叩かれた壁を数える。**数ではなく、散らばりを見る。**
 *
 * 門が拒んだ跡は台帳に残るようになった（`guard.deny`）。だが数を並べても
 * 三つを見分けられぬ——注入された者・心得が不明瞭な者・そして**条そのものが
 * 広すぎる**場合。殿の指摘（2026-08-29）である。
 *
 * 見分けは散らばりで立つ:
 *
 * | 見る軸 | 注入・誤解 | 条の誤り |
 * |---|---|---|
 * | 担い手 | 一人が繰り返す | **多くの者が等しく叩く** |
 * | 命の形 | 同じ形を何度も（目的があるゆえ） | **形は様々で、条だけが同じ** |
 * | 直訴の帰結 | 却下される | **通り続ける** |
 *
 * 条は仕組みの性質である。**皆が等しく叩くなら、それは常道を捕らえておる。**
 * 一人だけが叩くなら、条ではなくその者の話。
 *
 * 誤検知は絵空事ではない。D015 の初稿は `app.pem` を裸で捕らえる形にしており、
 * そのまま出しておれば**決め書きを書く手が己の門に弾かれておった**。防げたのは
 * 通すべき命を並べた陽性対照を試験に書いておったゆえ。
 * **陽性対照は「想像し得た誤検知」を捕らえ、この帳面は「想像し得なかった
 * 誤検知」を捕らえる。** 二つで一組である。
 */
import type { Database } from 'bun:sqlite';

export interface RuleTally {
  rule: string;
  hits: number;
  actors: string[];
  shapes: string[];
  appeals: number;
  grants: number;
  /** 疑う先。`rule` = 条を疑え / `actor` = その者を見よ / `watch` = 様子見 / `quiet` = 材料不足 */
  verdict: 'rule' | 'actor' | 'watch' | 'quiet';
  note: string;
}

/** 判ずるに足る叩きの数。これ未満は数を並べるに留め、疑いを述べぬ。 */
export const MIN_HITS = 3;

const isFlag = (t: string) => t.startsWith('-');
const isPath = (t: string) => /^[~/.]/.test(t) || t.includes('/');

/**
 * 命の「形」。同じ形の繰り返しか、様々な形かを見るための粗い括り。
 *
 * 生の命をそのまま数えると、引数が違うだけで別物に見え、**注入の繰り返しが
 * 「様々な形」に化ける**。道具の名と、その副命令までで括る。
 *
 *   cat ~/.shogun/…/app.pem   → cat            （次は道ゆえ採らぬ）
 *   tmux send-keys -t %9 x    → tmux send-keys （次は副命令ゆえ採る）
 *   rm -rf /                  → rm             （次は旗ゆえ採らぬ）
 */
export function shapeOf(cmd: string): string {
  const t = cmd.trim().split(/\s+/).filter((x) => x !== '');
  if (t.length === 0) return '(空)';
  const head = t[0]!;
  const next = t[1];
  if (next && !isFlag(next) && !isPath(next) && /^[a-z][\w-]*$/i.test(next)) {
    return `${head} ${next}`;
  }
  return head;
}

/** `guard.appeal` / `guard.grant` の detail から条を拾う（`rule=D0XX …`）。 */
export function ruleOf(detail: string | null): string | undefined {
  const m = /(?:^|\s)rule=(\S+)/.exec(detail ?? '');
  return m ? m[1] : undefined;
}

export interface LedgerRow {
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  at: string;
}

/**
 * 条ごとに束ねて、疑う先を添える。
 *
 * 疑いは**材料が足りてから**述べる。一度や二度の拒みで条を疑えば、
 * 門が萎える。
 */
export function tally(rows: LedgerRow[]): RuleTally[] {
  const by = new Map<string, { hits: number; actors: Set<string>; shapes: Set<string>; appeals: number; grants: number }>();
  const get = (rule: string) => {
    let e = by.get(rule);
    if (!e) {
      e = { hits: 0, actors: new Set(), shapes: new Set(), appeals: 0, grants: 0 };
      by.set(rule, e);
    }
    return e;
  };

  for (const r of rows) {
    if (r.action === 'guard.deny') {
      const rule = r.target ?? '規則不明';
      const e = get(rule);
      e.hits++;
      e.actors.add(r.actor);
      e.shapes.add(shapeOf(r.detail ?? ''));
      continue;
    }
    // 直訴と手形は detail に条を持つ。持たぬ古い記録は数えぬ。
    const rule = ruleOf(r.detail);
    if (!rule) continue;
    if (r.action === 'guard.appeal') get(rule).appeals++;
    else if (r.action === 'guard.grant') get(rule).grants++;
  }

  const out: RuleTally[] = [];
  for (const [rule, e] of by) {
    const actors = [...e.actors].sort();
    const shapes = [...e.shapes].sort();
    out.push({ rule, hits: e.hits, actors, shapes, appeals: e.appeals, grants: e.grants, ...verdictFor(e.hits, actors.length, shapes.length, e.appeals, e.grants) });
  }
  // 疑わしい順、次に叩かれた順。
  const rank = { rule: 0, actor: 1, watch: 2, quiet: 3 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.hits - a.hits);
}

function verdictFor(
  hits: number,
  actors: number,
  shapes: number,
  appeals: number,
  grants: number,
): { verdict: RuleTally['verdict']; note: string } {
  // 直訴が上がり、手形が下り続ける条は、**答えが常に諾となる問い**である。
  // 門としての意味を失うており、叩きの数を待たずに疑うてよい。
  if (grants >= 2 && grants >= appeals) {
    return { verdict: 'rule', note: '直訴が通り続けておる。条が常道を捕らえておらぬか' };
  }
  if (hits < MIN_HITS) {
    return { verdict: 'quiet', note: '材料が足りぬ' };
  }
  if (actors >= 2 && shapes >= 2) {
    return { verdict: 'rule', note: '多くの者が様々な形で叩いておる。条を疑え' };
  }
  if (actors === 1 && shapes === 1) {
    return { verdict: 'actor', note: '一人が同じ形を繰り返しておる。その者を見よ' };
  }
  return { verdict: 'watch', note: '様子見' };
}

/** 台帳から門まわりの記録を引く。窓は日数。 */
export function collect(db: Database, now: Date, windowDays = 7): LedgerRow[] {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  return db
    .query(
      `SELECT actor, action, target, detail, at FROM ledger
       WHERE at >= ? AND action IN ('guard.deny', 'guard.appeal', 'guard.grant')
       ORDER BY id`,
    )
    .all(since) as LedgerRow[];
}

/** 戦況へ載せる形。何も無い時は、**無いことの意味**まで言う。 */
export function render(tallies: RuleTally[], windowDays = 7): string[] {
  const mark = { rule: '⚠ 条', actor: '👤 者', watch: '· 見', quiet: '· 少' };
  const lines: string[] = [`## 🧱 叩かれた壁（直近 ${windowDays} 日）`];
  if (tallies.length === 0) {
    lines.push(
      'なし。ただし**門が生きておることの証ではない**——',
      '外れておっても拒みは 0 になる。生死は `shutsujin_departure.sh gate` で別に確かめよ。',
    );
    return lines;
  }
  lines.push('| | 条 | 叩き | 者 | 形 | 直訴/手形 | 見立て |', '|---|---|---|---|---|---|---|');
  for (const t of tallies) {
    lines.push(
      `| ${mark[t.verdict]} | ${t.rule} | ${t.hits} | ${t.actors.length} | ${t.shapes.length} | ${t.appeals}/${t.grants} | ${t.note} |`,
    );
  }
  return lines;
}
