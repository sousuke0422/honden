/**
 * 期限切れのまま握られ、手も動いておらぬ持ち場を見つける。
 *
 * 「見捨てられた司令」は holder が居らぬ。一方こちらは holder が立ったまま
 * 期限を過ぎ、さらに既定貸与一巡を越えたものだけを「止まった持ち場」と呼ぶ。
 * 期限直後に鳴らさぬのは、30 分を越す検査が日常にあるためである。
 *
 * 働いておる印は呼び手が src/busy.ts の isWorking と captureBusy から集める。
 * 台帳の直近活動または pane の処理中表示がある者は除く。長い無出力処理を
 * 完全には見分けられぬため、報せは強制解除ではなく家老の差配を促すだけにする。
 */

import type { Database } from 'bun:sqlite';
import { deliver } from './inbox';
import { journal, tx } from './store';
import { DEFAULT_LEASE_MINUTES } from './lease';
import { ASSIGNER } from './dispatch';

/** 期限が切れてから、さらに一巡待つ。 */
export const STALLED_AFTER_MS = DEFAULT_LEASE_MINUTES * 60_000;

export interface StalledLease {
  taskId: string;
  agent: string;
  holder: string;
  cmdId: string | null;
  leaseUntil: string;
}

export function findStalled(
  db: Database,
  busyAgents: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): StalledLease[] {
  const rows = db
    .query(
      `SELECT task_id taskId, agent, holder, cmd_id cmdId, lease_until leaseUntil
       FROM task
       WHERE holder IS NOT NULL
         AND task_id IS NOT NULL
         AND lease_until IS NOT NULL
       ORDER BY lease_until, agent`,
    )
    .all() as StalledLease[];

  return rows.filter((r) => {
    const expiredFor = now.getTime() - Date.parse(r.leaseUntil);
    return expiredFor >= STALLED_AFTER_MS && !busyAgents.has(r.agent);
  });
}

/**
 * 止まった持ち場を家老へ知らせる。
 *
 * 同じ期限には一度だけ鳴る。更新後に再び止まれば lease_until が変わるため
 * 新しい id となる。家老が動かぬ時は未読が残り、既存の nudge の梯子が
 * 家老を起こし続ける。独自に将軍へ回すと差配が二重になるため行わない。
 */
export function notifyStalled(
  db: Database,
  busyAgents: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): StalledLease[] {
  const found = findStalled(db, busyAgents, now);
  const sent: StalledLease[] = [];
  for (const s of found) {
    const id = `msg_stalled_${s.taskId}_u${Date.parse(s.leaseUntil)}`;
    const already = db.query('SELECT 1 FROM inbox WHERE id = ?').get(id);
    if (already) continue;
    const expiredMinutes = Math.floor((now.getTime() - Date.parse(s.leaseUntil)) / 60_000);
    const assignee = s.holder === s.agent ? s.agent : `${s.agent}（holder: ${s.holder}）`;
    const divider = s.holder === s.agent ? ' / ' : '/ ';
    // 在るかの確かめ・報せ・台帳を一つの取引で確定する（重複抑止の鍵が
    // inbox の id ゆえ、台帳だけ落ちて id が残ると二度と鳴らぬ）。
    const delivered = tx(db, () => {
      if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(id)) return false;
      deliver(db, {
      id,
      agent: ASSIGNER,
      at: now.toISOString(),
      type: 'lease_stalled',
      sender: 'core',
      body:
        `止まった持ち場: ${assignee}${divider}${s.taskId}${s.cmdId ? ` / ${s.cmdId}` : ''}\n\n` +
        `${s.holder} が holder として立ったまま貸与期限 ${s.leaseUntil} から ${expiredMinutes} 分が過ぎ、` +
        `直近の活動も pane の処理中表示も見つからぬ。\n` +
        `振り直すか、貸与を解くか、長い処理と確かめてそのまま待つか差配されよ。`,
    });
      journal(db, {
      actor: 'core',
      action: 'lease.stalled.notice',
      target: s.taskId,
      detail: `agent=${s.agent} holder=${s.holder} lease_until=${s.leaseUntil}`,
      at: now,
      });
      return true;
    });
    if (delivered) sent.push(s);
  }
  return sent;
}
