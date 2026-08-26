/**
 * 持ち場の貸与。
 *
 * 「この持ち場に生きた持ち主が居るか」を、推定ではなく事実として答えるための層。
 * 設計の理由は store.ts の task 表の註にある。
 *
 * ## 期限切れは「空き」ではない
 *
 * ここが DHCP と最も違うところになる。期限が切れても持ち主を消さない。
 * 消してしまうと、半分やりかけた仕事が誰のものでもなくなり、次に来た者が
 * 最初からやり直す。文脈は既に失われているので、やり直しは避けられない。
 *
 * だから期限切れは `expired` として見えるだけにして、返すかどうかは人が決める。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { checkReason } from './validate';
import { roleOf, roleOrNull } from './roster';

/** 仕事の重さから期限を決める。宣言が無いときの既定。 */
export const DEFAULT_LEASE_MINUTES = 30;

export interface Lease {
  agent: string;
  taskId: string | null;
  holder: string | null;
  leasedAt: string | null;
  leaseUntil: string | null;
}

export type LeaseState = 'free' | 'held' | 'expired';

export function leaseState(lease: Pick<Lease, 'holder' | 'leaseUntil'>, now: Date): LeaseState {
  if (!lease.holder) return 'free';
  if (!lease.leaseUntil) return 'held'; // 期限の宣言が無いものは切らさない
  return new Date(lease.leaseUntil).getTime() <= now.getTime() ? 'expired' : 'held';
}

export interface AcquireResult {
  ok: boolean;
  state: LeaseState;
  /** 断ったときの理由。そのまま呼び出し側へ見せられる形にする。 */
  message?: string;
  lease?: Lease;
}

function readRow(db: Database, agent: string): Lease | null {
  const r = db
    .query('SELECT agent, task_id, holder, leased_at, lease_until FROM task WHERE agent = ?')
    .get(agent) as
    | { agent: string; task_id: string | null; holder: string | null; leased_at: string | null; lease_until: string | null }
    | null;
  return r
    ? { agent: r.agent, taskId: r.task_id, holder: r.holder, leasedAt: r.leased_at, leaseUntil: r.lease_until }
    : null;
}

/**
 * 持ち場を取る。
 *
 * 既に生きた持ち主が居れば断る。期限切れなら取れるが、
 * 取ったこと自体を台帳へ残す (前の持ち主の仕事を引き継いだという事実になる)。
 *
 * 取引の中から呼ぶこと。
 */
export function acquire(
  db: Database,
  opts: { agent: string; taskId: string; holder: string; minutes?: number; now?: Date; force?: boolean },
): AcquireResult {
  const now = opts.now ?? new Date();
  const cur = readRow(db, opts.agent);
  const state = cur ? leaseState(cur, now) : 'free';

  if (state === 'held' && cur?.holder !== opts.holder && !opts.force) {
    return {
      ok: false,
      state,
      lease: cur ?? undefined,
      message:
        `${opts.agent} の持ち場は ${cur?.holder} が握っておる（${cur?.leaseUntil} まで）。\n` +
        `  いま持たれておる仕事: ${cur?.taskId ?? '不明'}\n` +
        '  期限が切れるのを待つか、持ち主に手放させるか、force を明示されよ。',
    };
  }

  const until = new Date(now.getTime() + (opts.minutes ?? DEFAULT_LEASE_MINUTES) * 60_000);
  db.prepare(
    `INSERT INTO task(agent, task_id, status, updated_at, raw, holder, leased_at, lease_until)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(agent) DO UPDATE SET
       task_id = excluded.task_id, status = excluded.status,
       updated_at = excluded.updated_at, holder = excluded.holder,
       leased_at = excluded.leased_at, lease_until = excluded.lease_until`,
  ).run(
    opts.agent,
    opts.taskId,
    'assigned',
    now.toISOString(),
    cur ? '' : '',
    opts.holder,
    now.toISOString(),
    until.toISOString(),
  );

  journal(db, {
    actor: opts.holder,
    action: state === 'expired' ? 'lease.take_over' : 'lease.acquire',
    target: opts.agent,
    detail: `task=${opts.taskId} until=${until.toISOString()}${state === 'expired' ? ` prev=${cur?.holder}` : ''}`,
  });

  return { ok: true, state, lease: readRow(db, opts.agent) ?? undefined };
}

/**
 * 期限を延ばす。
 *
 * 仕事のついでに呼ぶもの。期限が切れる前に更新されるので、働いている限り
 * 切れることがない。「更新を忘れる」経路を作らないため、書き込みの取引から
 * 呼ぶのが本筋になる。
 *
 * 持ち主が違えば断る。黙って奪うと、奪われた側が気づけない。
 */
export function renew(
  db: Database,
  opts: { agent: string; holder: string; minutes?: number; now?: Date },
): AcquireResult {
  const now = opts.now ?? new Date();
  const cur = readRow(db, opts.agent);
  if (!cur || !cur.holder) {
    return { ok: false, state: 'free', message: `${opts.agent} の持ち場は誰も握っておらぬ。まず取られよ。` };
  }
  if (cur.holder !== opts.holder) {
    return {
      ok: false,
      state: leaseState(cur, now),
      lease: cur,
      message: `${opts.agent} を握っておるのは ${cur.holder} であって ${opts.holder} ではない。`,
    };
  }
  const until = new Date(now.getTime() + (opts.minutes ?? DEFAULT_LEASE_MINUTES) * 60_000);
  db.prepare('UPDATE task SET lease_until = ?, updated_at = ? WHERE agent = ?').run(
    until.toISOString(),
    now.toISOString(),
    opts.agent,
  );
  return { ok: true, state: 'held', lease: readRow(db, opts.agent) ?? undefined };
}

/**
 * 手放す。仕事が終わったときに呼ぶ。
 *
 * ## 強制解除の道
 *
 * 足軽が握ったまま倒れると、持ち主しか手放せない造りでは誰も解けない。
 * expired() は並べるだけで何も直さないので、詰まったままになる。
 *
 * だから道は要る。だが迂回と同じ four を課す。
 *
 *   1. 明示（force）。誤って通れない
 *   2. 理由が必須
 *   3. 別の action として台帳に残す（lease.release.force）
 *   4. 解いた時の持ち場の様子を併せて記録する
 *
 * 4 つ目が要るのは、後から「本当に倒れていたか」を検めるため。
 * 生きている者の仕事を取り上げた場合も、跡が残る。
 */
export function release(
  db: Database,
  opts: { agent: string; holder: string; now?: Date; force?: boolean; reason?: string },
): AcquireResult {
  const now = opts.now ?? new Date();
  const cur = readRow(db, opts.agent);
  if (!cur || !cur.holder) return { ok: true, state: 'free' };
  if (cur.holder !== opts.holder && !opts.force) {
    return {
      ok: false,
      state: leaseState(cur, now),
      lease: cur,
      message:
        `${opts.agent} を握っておるのは ${cur.holder} である。他人の持ち場は手放せぬ。\n` +
        `  倒れて詰まっておるなら --force --reason "…" で解ける。跡は台帳に残る。`,
    };
  }
  if (opts.force && cur.holder !== opts.holder) {
    // 他人の持ち場を解くのは上役の裁定。足軽が互いに解き合うと、
    // 「倒れておる」の判断が誰のものでもなくなる。
    if (roleOrNull(opts.holder) !== 'commander') {
      return {
        ok: false,
        state: leaseState(cur, now),
        lease: cur,
        message:
          `${opts.agent} を握っておるのは ${cur.holder} である。足軽が他人の持ち場を解くことはできぬ。\n` +
          '  家老へ回されよ。',
      };
    }
    const bad = checkReason(opts.reason, `${opts.agent} の pane が落ちて 1 時間`);
    if (bad) return { ok: false, state: leaseState(cur, now), lease: cur, message: bad };
    const st = leaseState(cur, now);
    db.prepare(
      "UPDATE task SET holder = NULL, leased_at = NULL, lease_until = NULL, status = 'idle', updated_at = ? WHERE agent = ?",
    ).run(now.toISOString(), opts.agent);
    journal(db, {
      actor: opts.holder,
      action: 'lease.release.force',
      target: opts.agent,
      detail:
        `task=${cur.taskId ?? '不明'} prev_holder=${cur.holder} 解除時の状態=${st} ` +
        `lease_until=${cur.leaseUntil ?? 'なし'} reason=${JSON.stringify(opts.reason)}`,
    });
    return { ok: true, state: 'free', lease: readRow(db, opts.agent) ?? undefined };
  }
  db.prepare(
    "UPDATE task SET holder = NULL, leased_at = NULL, lease_until = NULL, status = 'idle', updated_at = ? WHERE agent = ?",
  ).run(now.toISOString(), opts.agent);
  journal(db, { actor: opts.holder, action: 'lease.release', target: opts.agent, detail: cur.taskId ?? '' });
  return { ok: true, state: 'free' };
}

export interface StaleEntry extends Lease {
  state: LeaseState;
  /** 期限を過ぎてからの秒数。 */
  overdueSeconds: number;
}

/**
 * 期限の切れた持ち場を並べる。
 *
 * **返すだけで、何も直さない。** 自動で振り直すと、半分やりかけた仕事が
 * 文脈ごと失われる。誰へ渡すか、そもそも渡すのかは人が決める。
 */
export function expired(db: Database, now: Date = new Date()): StaleEntry[] {
  const rows = db
    .query('SELECT agent, task_id, holder, leased_at, lease_until FROM task WHERE holder IS NOT NULL')
    .all() as {
    agent: string;
    task_id: string | null;
    holder: string | null;
    leased_at: string | null;
    lease_until: string | null;
  }[];
  const out: StaleEntry[] = [];
  for (const r of rows) {
    const lease: Lease = {
      agent: r.agent,
      taskId: r.task_id,
      holder: r.holder,
      leasedAt: r.leased_at,
      leaseUntil: r.lease_until,
    };
    const state = leaseState(lease, now);
    if (state !== 'expired') continue;
    out.push({
      ...lease,
      state,
      overdueSeconds: Math.floor((now.getTime() - new Date(lease.leaseUntil!).getTime()) / 1000),
    });
  }
  return out.sort((a, b) => b.overdueSeconds - a.overdueSeconds);
}
