/**
 * 一度も振られぬまま止まった司令を見つける。
 *
 * 起草から既定の貸与一巡（30 分）以上が経ち、閉じておらず、task に行が
 * 一つも無い司令を対象とする。claim の跡も除く。task は現在の持ち場を表す
 * ため、後の差配で行が上書きされても「一度も振られておらぬ」を守るためである。
 *
 * 線引きは時だけで行う。家老の未読や稼働状態を混ぜると、差配役自身が
 * 詰まった実件ほど検知できなくなる。30 分は通常の差配を急かさず、既定の
 * 貸与一巡を丸ごと待つ猶予である。境界（ちょうど30分）は検知する。
 */

import type { Database } from 'bun:sqlite';
import { ASSIGNER } from './dispatch';
import { deliver } from './inbox';
import { DEFAULT_LEASE_MINUTES } from './lease';
import { journal } from './store';

export const UNASSIGNED_AFTER_MS = DEFAULT_LEASE_MINUTES * 60_000;

export interface UnassignedCommand {
  cmdId: string;
  purpose: string | null;
  createdAt: string;
}

export function findUnassigned(db: Database, now: Date = new Date()): UnassignedCommand[] {
  const rows = db
    .query(
      `SELECT c.id cmdId, c.purpose purpose, c.created_at createdAt
       FROM cmd c
       WHERE c.status IN ('pending','in_progress')
         AND NOT EXISTS (SELECT 1 FROM task t WHERE t.cmd_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM claim cl WHERE cl.cmd_id = c.id)
       ORDER BY c.created_at, c.id`,
    )
    .all() as UnassignedCommand[];

  return rows.filter((r) => now.getTime() - Date.parse(r.createdAt) >= UNASSIGNED_AFTER_MS);
}

/** 差配役である家老へ一度だけ報せる。 */
export function notifyUnassigned(db: Database, now: Date = new Date()): UnassignedCommand[] {
  const found = findUnassigned(db, now);
  const sent: UnassignedCommand[] = [];
  for (const command of found) {
    const id = `msg_unassigned_${command.cmdId}_t${Date.parse(command.createdAt)}`;
    if (db.query('SELECT 1 FROM inbox WHERE id = ?').get(id)) continue;

    deliver(db, {
      id,
      agent: ASSIGNER,
      at: now.toISOString(),
      type: 'cmd_unassigned',
      sender: 'core',
      body:
        `振られぬまま止まった司令: ${command.cmdId} ${(command.purpose ?? '').split('\n')[0]}\n\n` +
        `起草から ${Math.floor((now.getTime() - Date.parse(command.createdAt)) / 60_000)} 分、` +
        `task に行が無く、一度も振られておらぬ。\n` +
        `振るか、閉じるか差配されよ。経緯は honden cmd show ${command.cmdId} で確かめられる。`,
    });
    journal(db, {
      actor: 'core',
      action: 'cmd.unassigned.notice',
      target: command.cmdId,
      detail: `created_at=${command.createdAt}`,
      at: now,
    });
    sent.push(command);
  }
  return sent;
}
