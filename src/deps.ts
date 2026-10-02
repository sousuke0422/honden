/**
 * 司令の依存。「この司令は、あの司令が済むまで振れぬ」を正本に持たせる。
 *
 * ## なぜ要ったか
 *
 * 司令の順は将軍が頭で持っておった。頭で持つものは落ちる。
 * 家老の割り当て（src/dispatch.ts の assignTask）は司令が在るかしか見ず、
 * 先に済ませるべき司令が残っておっても振れてしまう。
 *
 * ## 解けたかを状態で持たぬ——ここが最も大事である
 *
 * 「依存が解けた」という印を表に書く形にはせぬ。**毎度、needs 側の
 * cmd.status から引く**（done なら解けておる）。
 *
 * 印を書く形にすると、needs が済んだ時に依存する側の印を書き換える
 * 手が要る。その手が遅れたり落ちたりすれば、済んだはずの依存が塞がった
 * まま残る。Claude Code の Agent Teams は、まさにこの詰まりを Limitations に
 * 挙げておる（「task の状態の更新が遅れ、依存する task が塞がる」）。
 * 引く形なら、cmd done が走った瞬間に何もせずとも解ける。書き換える手が
 * 無いゆえ、遅れる所も落ちる所も無い。
 *
 * ## 循環は入口で防ぐ
 *
 * 依存を挿す取引の中で、needs から辿って己へ戻るかを見る。戻るなら拒む。
 * 検めるだけで通すと、循環した司令は誰も振れぬまま残り、人が見つけるまで
 * 分からぬ。入口で防ぐのが最も安い。
 *
 * ## 守るのは司令と司令の間の順だけ
 *
 * 一つの司令の中の積み重ね（PR の A→B→C を三本の枝に積む類）は表せぬ。
 * それは司令の受け入れ条件と家老の差配の領分である
 * （instructions/roles/shogun.md の「司令の依存」）。
 */

import type { Database } from 'bun:sqlite';
import { deliver } from './inbox';
import { journal, tx } from './store';
import { ASSIGNER } from './dispatch';

/** 依存する側を永久に塞ぐ、needs の閉じ方。 */
export const DEAD_STATUSES = ['cancelled', 'failed'] as const;

export interface Need {
  needs: string;
  status: string;
}

/** 依存の書き方を一覧へ均す。YAML の一覧でも、旗の「cmd_1,cmd_2」でも受ける。 */
export function normalizeNeeds(v: unknown): string[] | { error: string } {
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : null;
  if (raw === null) return { error: 'depends_on は司令番号の一覧で書かれよ（例: [cmd_1, cmd_2]）' };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: `depends_on の中身が文ではない: ${JSON.stringify(item)}` };
    const t = item.trim();
    if (t === '') continue;
    if (!/^cmd_\d+$/.test(t)) return { error: `depends_on は司令番号（cmd_<数>）で書かれよ: ${t}` };
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** その司令が頼る司令と、いまの status。 */
export function needsOf(db: Database, cmdId: string): Need[] {
  return db
    .query(
      `SELECT d.needs needs, c.status status FROM cmd_dep d JOIN cmd c ON c.id = d.needs
       WHERE d.cmd_id = ? ORDER BY d.needs`,
    )
    .all(cmdId) as Need[];
}

/** まだ解けておらぬ依存（needs が done でないもの）。毎度 status から引く。 */
export function unresolved(db: Database, cmdId: string): Need[] {
  return needsOf(db, cmdId).filter((n) => n.status !== 'done');
}

/** needs から依存を辿って target へ戻るか。戻るなら、その道を返す。 */
function pathBack(db: Database, from: string, target: string): string[] | null {
  const next = db.prepare('SELECT needs FROM cmd_dep WHERE cmd_id = ?');
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === target) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const r of next.all(at) as { needs: string }[]) {
      const got = walk(r.needs, [...path, r.needs]);
      if (got) return got;
    }
    return null;
  };
  return walk(from, [from]);
}

/**
 * 依存を挿す。**呼ぶ側の取引の中で呼ぶこと。**
 *
 * 在らぬ司令・己自身・循環は拒む（投げる）。投げれば取引ごと巻き戻る。
 */
export function insertNeeds(db: Database, cmdId: string, needs: string[], by: string, at: string): void {
  const exists = db.prepare('SELECT 1 FROM cmd WHERE id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO cmd_dep(cmd_id, needs, created_at, by) VALUES (?,?,?,?)');
  for (const n of needs) {
    if (n === cmdId) throw new DepError(`${cmdId} は己自身に頼れぬ。`);
    if (!exists.get(n)) throw new DepError(`そのような司令は無い: ${n}（depends_on）`);
    // 挿す前に辿る。n から辿って cmdId に戻るなら、cmdId → n を足すと輪になる。
    const loop = pathBack(db, n, cmdId);
    if (loop) {
      throw new DepError(`依存が輪になる: ${[cmdId, ...loop].join(' → ')}`);
    }
    ins.run(cmdId, n, at, by);
  }
}

/** 依存を外す。呼ぶ側の取引の中で呼ぶこと。 */
export function deleteNeeds(db: Database, cmdId: string, needs: string[]): void {
  const del = db.prepare('DELETE FROM cmd_dep WHERE cmd_id = ? AND needs = ?');
  for (const n of needs) del.run(cmdId, n);
}

/** 依存の誤り。取引を巻き戻すために投げ、呼ぶ側で文に直す。 */
export class DepError extends Error {}

export interface Blocked {
  cmdId: string;
  purpose: string | null;
  /** 閉じ方が取り消し・失敗の needs（「cmd_3:cancelled」の形で並べる） */
  dead: Need[];
}

/** 生きた司令のうち、needs が取り消し・失敗で閉じたもの。振れぬまま永久に塞がる。 */
export function findBlocked(db: Database): Blocked[] {
  const rows = db
    .query(
      `SELECT c.id cmdId, c.purpose purpose, d.needs needs, n.status status
       FROM cmd c
       JOIN cmd_dep d ON d.cmd_id = c.id
       JOIN cmd n ON n.id = d.needs
       WHERE c.status IN ('pending','in_progress')
         AND n.status IN ('cancelled','failed')
       ORDER BY c.id, d.needs`,
    )
    .all() as { cmdId: string; purpose: string | null; needs: string; status: string }[];
  const by = new Map<string, Blocked>();
  for (const r of rows) {
    const b = by.get(r.cmdId) ?? { cmdId: r.cmdId, purpose: r.purpose, dead: [] };
    b.dead.push({ needs: r.needs, status: r.status });
    by.set(r.cmdId, b);
  }
  return [...by.values()];
}

/**
 * 塞がった司令を家老へ一度報せる。src/abandoned.ts の notifyAbandoned に倣う。
 *
 * 報せの id を「依存する司令と、閉じた needs」から決めて引く——同じ組なら
 * 同じ id ゆえ、二度目は挿さらぬ。在るかの確かめ・報せ・台帳を一つの取引で
 * 確定する（台帳だけが落ちて inbox が残ると、二度と鳴らぬ）。
 *
 * 段は上げぬ。報せは未読として残り、芯の合図の梯子（src/nudge.ts）が
 * 家老を起こし続ける。cmd list の印も、依存を外すか閉じるまで消えぬ。
 */
export function notifyBlocked(db: Database, now: Date = new Date()): Blocked[] {
  const sent: Blocked[] = [];
  for (const b of findBlocked(db)) {
    let any = false;
    for (const d of b.dead) {
      const id = `msg_blocked_${b.cmdId}_${d.needs}`;
      const delivered = tx(db, () => {
        if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(id)) return false;
        deliver(db, {
          id,
          agent: ASSIGNER,
          at: now.toISOString(),
          type: 'cmd_blocked',
          sender: 'core',
          body:
            `塞がった司令: ${b.cmdId} ${(b.purpose ?? '').split('\n')[0]}\n\n` +
            `頼る ${d.needs} が ${d.status} で閉じた。このままでは ${b.cmdId} は永久に振れぬ。\n` +
            `将軍へ上げ、依存を外す（honden cmd amend --cmd_id ${b.cmdId} --depends_on …）か、` +
            `${b.cmdId} を閉じるかを差配されよ。`,
        });
        journal(db, {
          actor: 'core',
          action: 'cmd.blocked.notice',
          target: b.cmdId,
          detail: `needs=${d.needs} status=${d.status}`,
        });
        return true;
      });
      if (delivered) any = true;
    }
    if (any) sent.push(b);
  }
  return sent;
}

/** cmd list の印。done でない needs だけを並べる。 */
export function depMark(needs: Need[]): string {
  const open = needs.filter((n) => n.status !== 'done');
  if (open.length === 0) return '';
  const dead = open.filter((n) => (DEAD_STATUSES as readonly string[]).includes(n.status));
  const wait = open.filter((n) => !(DEAD_STATUSES as readonly string[]).includes(n.status));
  const parts: string[] = [];
  if (wait.length > 0) parts.push(`⛓ ${wait.map((n) => n.needs).join(', ')} 待ち`);
  if (dead.length > 0) {
    parts.push(`⛔ ${dead.map((n) => `${n.needs}（${n.status}）`).join(', ')}で塞がり`);
  }
  return `  ${parts.join('  ')}`;
}

/** status の尻に載せる合計の一行。依存の無い時は空。 */
export function depSummary(db: Database): string {
  const rows = db
    .query(
      `SELECT d.cmd_id cmdId, n.status status
       FROM cmd_dep d JOIN cmd c ON c.id = d.cmd_id JOIN cmd n ON n.id = d.needs
       WHERE c.status IN ('pending','in_progress') AND n.status != 'done'`,
    )
    .all() as { cmdId: string; status: string }[];
  const dead = new Set(rows.filter((r) => (DEAD_STATUSES as readonly string[]).includes(r.status)).map((r) => r.cmdId));
  const wait = new Set(rows.map((r) => r.cmdId).filter((id) => !dead.has(id)));
  const parts: string[] = [];
  if (wait.size > 0) parts.push(`依存待ちの司令 ${wait.size} 件`);
  if (dead.size > 0) parts.push(`依存の取り消しで塞がった司令 ${dead.size} 件`);
  return parts.join(' / ');
}
