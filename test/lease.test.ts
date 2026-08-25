/**
 * 貸与の試験。
 *
 * 確かめるのは主に 3 つ。
 *
 *   1. 生きた持ち主が居るとき、横取りできぬこと（2026-08-24 の衝突がこれで防げる）
 *   2. 期限切れが推定でなく事実として出ること
 *   3. 期限切れでも自動で返さぬこと（やりかけの仕事を失わせない）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { acquire, renew, release, expired, leaseState, DEFAULT_LEASE_MINUTES } from '../src/lease';

const mem = () => openStore({ path: ':memory:' });
const at = (iso: string) => new Date(iso);
const T0 = at('2026-08-24T12:00:00Z');
const plus = (base: Date, min: number) => new Date(base.getTime() + min * 60_000);

describe('取る', () => {
  test('空きなら取れる', () => {
    const db = mem();
    const r = tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_1', holder: 'karo', now: T0 }));
    expect(r.ok).toBe(true);
    expect(r.state).toBe('free');
    expect(r.lease?.holder).toBe('karo');
  });

  // 2026-08-24: 将軍が assigned を「取り残し」と読み、足軽1号が働いておる
  // worktree へ手を入れて merge commit を生んだ。これはその再発防止になる。
  test('生きた持ち主が居れば断る', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_1', holder: 'karo', now: T0 }));
    const r = tx(db, () =>
      acquire(db, { agent: 'ashigaru1', taskId: 'subtask_2', holder: 'shogun', now: plus(T0, 5) }),
    );
    expect(r.ok).toBe(false);
    expect(r.state).toBe('held');
    expect(r.message).toContain('karo');
    expect(r.message).toContain('subtask_1');
  });

  test('断られたとき、持ち場は動いておらぬ', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_1', holder: 'karo', now: T0 }));
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_2', holder: 'shogun', now: plus(T0, 5) }));
    const row = db.query('SELECT task_id, holder FROM task WHERE agent = ?').get('ashigaru1') as {
      task_id: string;
      holder: string;
    };
    expect(row).toEqual({ task_id: 'subtask_1', holder: 'karo' });
  });

  test('同じ持ち主なら取り直せる', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_1', holder: 'karo', now: T0 }));
    const r = tx(db, () =>
      acquire(db, { agent: 'ashigaru1', taskId: 'subtask_2', holder: 'karo', now: plus(T0, 5) }),
    );
    expect(r.ok).toBe(true);
  });

  test('期限切れなら取れる。そして引き継いだ事実が台帳に残る', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 'subtask_1', holder: 'karo', now: T0 }));
    const later = plus(T0, DEFAULT_LEASE_MINUTES + 1);
    const r = tx(db, () =>
      acquire(db, { agent: 'ashigaru1', taskId: 'subtask_2', holder: 'shogun', now: later }),
    );
    expect(r.ok).toBe(true);
    expect(r.state).toBe('expired');
    const acts = (db.query('SELECT action, detail FROM ledger ORDER BY id').all() as {
      action: string;
      detail: string;
    }[]);
    expect(acts.map((a) => a.action)).toEqual(['lease.acquire', 'lease.take_over']);
    expect(acts[1]?.detail).toContain('prev=karo');
  });
});

describe('延ばす', () => {
  test('働いておる限り切れない', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't', holder: 'karo', now: T0 }));
    // 期限の半分で更新する (DHCP の T1 と同じ考え)
    const r = tx(db, () => renew(db, { agent: 'ashigaru1', holder: 'karo', now: plus(T0, 15) }));
    expect(r.ok).toBe(true);
    // 元の期限を過ぎた時刻でも、まだ生きている
    expect(leaseState(r.lease!, plus(T0, 35))).toBe('held');
  });

  test('他人の持ち場は延ばせぬ', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't', holder: 'karo', now: T0 }));
    const r = tx(db, () => renew(db, { agent: 'ashigaru1', holder: 'shogun', now: plus(T0, 5) }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('karo');
  });

  test('誰も握っておらぬものは延ばせぬ', () => {
    const db = mem();
    const r = tx(db, () => renew(db, { agent: 'ashigaru1', holder: 'karo', now: T0 }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('まず取られよ');
  });
});

describe('手放す', () => {
  test('持ち主なら手放せる', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't', holder: 'karo', now: T0 }));
    const r = tx(db, () => release(db, { agent: 'ashigaru1', holder: 'karo', now: plus(T0, 5) }));
    expect(r.ok).toBe(true);
    expect(r.state).toBe('free');
  });

  test('他人の持ち場は手放せぬ', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't', holder: 'karo', now: T0 }));
    const r = tx(db, () => release(db, { agent: 'ashigaru1', holder: 'shogun', now: plus(T0, 5) }));
    expect(r.ok).toBe(false);
  });
});

describe('強制解除', () => {
  // 足軽が握ったまま倒れると、持ち主しか手放せない造りでは誰も解けない。
  // expired() は並べるだけで直さないので、詰まったままになる。
  const held = () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't1', holder: 'ashigaru1', now: T0 }));
    return db;
  };

  test('理由つきなら他人の持ち場も解ける', () => {
    const db = held();
    const r = tx(db, () =>
      release(db, {
        agent: 'ashigaru1',
        holder: 'shogun',
        force: true,
        reason: '足軽1号の pane が落ちて 1 時間',
        now: plus(T0, 60),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.state).toBe('free');
  });

  test('理由が無ければ解けぬ', () => {
    const db = held();
    const r = tx(db, () =>
      release(db, { agent: 'ashigaru1', holder: 'shogun', force: true, now: plus(T0, 60) }),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('理由が要る');
  });

  test('force を宣言せねば解けぬまま。だが道は教える', () => {
    const db = held();
    const r = tx(db, () => release(db, { agent: 'ashigaru1', holder: 'shogun', now: plus(T0, 60) }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('--force');
  });

  // 生きている者の仕事を取り上げた場合も、跡が残らねばならぬ。
  test('解除時の状態が台帳に残る', () => {
    const db = held();
    tx(db, () =>
      release(db, {
        agent: 'ashigaru1',
        holder: 'shogun',
        force: true,
        reason: '足軽1号の pane が落ちて 1 時間',
        now: plus(T0, 60),
      }),
    );
    const l = db
      .query("SELECT actor, action, detail FROM ledger WHERE action = 'lease.release.force'")
      .get() as { actor: string; action: string; detail: string };
    expect(l.actor).toBe('shogun');
    expect(l.detail).toContain('prev_holder=ashigaru1');
    expect(l.detail).toContain('解除時の状態=expired');
    expect(l.detail).toContain('reason=');
  });

  test('生きておる貸与を取り上げても、その旨が残る', () => {
    const db = held();
    tx(db, () =>
      release(db, {
        agent: 'ashigaru1',
        holder: 'shogun',
        force: true,
        reason: '誤った仕事を振ってしまったゆえ取り消す',
        now: plus(T0, 5),
      }),
    );
    const l = db
      .query("SELECT detail FROM ledger WHERE action = 'lease.release.force'")
      .get() as { detail: string };
    // まだ生きていた（held）ことが残る。倒れていたかを後から検められる。
    expect(l.detail).toContain('解除時の状態=held');
  });

  test('自分の持ち場なら force は要らぬ（普通の解除として残る）', () => {
    const db = held();
    tx(db, () => release(db, { agent: 'ashigaru1', holder: 'ashigaru1', now: plus(T0, 5) }));
    const acts = (db.query('SELECT action FROM ledger').all() as { action: string }[]).map((r) => r.action);
    expect(acts).toContain('lease.release');
    expect(acts).not.toContain('lease.release.force');
  });
});

describe('期限切れの扱い', () => {
  test('期限切れは並ぶ', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't1', holder: 'karo', now: T0 }));
    tx(db, () => acquire(db, { agent: 'ashigaru2', taskId: 't2', holder: 'karo', now: plus(T0, 20) }));
    const list = expired(db, plus(T0, 40));
    expect(list.map((e) => e.agent)).toEqual(['ashigaru1']);
    expect(list[0]?.overdueSeconds).toBeGreaterThan(0);
  });

  // ここが DHCP と違う。期限が切れても持ち主を消さない。
  // 消すと、半分やりかけた仕事が誰のものでもなくなる。
  test('並べても自動で返さぬ', () => {
    const db = mem();
    tx(db, () => acquire(db, { agent: 'ashigaru1', taskId: 't1', holder: 'karo', now: T0 }));
    expired(db, plus(T0, 40));
    const row = db.query('SELECT holder, task_id FROM task WHERE agent = ?').get('ashigaru1') as {
      holder: string;
      task_id: string;
    };
    expect(row).toEqual({ holder: 'karo', task_id: 't1' });
  });

  test('期限の宣言が無いものは切らさない', () => {
    expect(leaseState({ holder: 'karo', leaseUntil: null }, T0)).toBe('held');
  });

  test('誰も握っておらぬものは空き', () => {
    expect(leaseState({ holder: null, leaseUntil: null }, T0)).toBe('free');
  });
});
