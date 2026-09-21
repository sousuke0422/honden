import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { findAbandoned } from '../src/abandoned';
import { findStalled, notifyStalled, STALLED_AFTER_MS } from '../src/stalled';
import { runNudge } from '../src/main';

const CMD = {
  north_star: '止まった持ち場を黙って残さぬ',
  purpose: '期限切れ後に止まった holder を家老へ知らせる',
  acceptance_criteria: ['止まった持ち場が検知されること'],
  command: '実装せよ',
  project: 'honden',
};

function seeded(path = ':memory:') {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'ashigaru9', role: 'worker', cli: 'claude', model: null },
    ]);
  });
  const cmdId = createCmd(db, 'shogun', CMD).id!;
  const assigned = assignTask(db, 'karo', {
    agent: 'ashigaru9', cmd_id: cmdId, title: '止まり試料', workspace: `/w/.worktrees/${cmdId}`,
  });
  expect(assigned.ok).toBe(true);
  const taskId = (db.query('SELECT task_id FROM task WHERE agent = ?').get('ashigaru9') as { task_id: string }).task_id;
  return { db, cmdId, taskId };
}

function setLease(db: ReturnType<typeof seeded>['db'], leaseUntil: Date) {
  db.run('UPDATE task SET lease_until = ? WHERE agent = ?', [leaseUntil.toISOString(), 'ashigaru9']);
}

// 試験は実在の pane へ命を送らぬ。既定の paneReader は実陣を写し、既定の
// sender は tmux へ撃つ——両方を注ぎ替え、造りの側で送信を封ずる。
const NO_PANES = () => new Map();
const NO_SEND = async () => ({ ok: true as const });

function lendToKaro(db: ReturnType<typeof seeded>['db']) {
  db.run("UPDATE task SET holder = 'karo' WHERE agent = 'ashigaru9'");
}

const NOW = new Date('2026-09-15T00:57:00Z');

describe('止まった持ち場の定め', () => {
  test('holder が立ったまま期限後の猶予も過ぎ、busy でなければ検知する', () => {
    const { db, taskId } = seeded();
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS - 60_000));
    expect(findStalled(db, new Set(), NOW).map((s) => s.taskId)).toEqual([taskId]);
  });

  test('実例——21:57 に切れ、三時間活動も報告も無い holder を検知する', () => {
    const { db, taskId } = seeded();
    setLease(db, new Date('2026-09-14T21:57:00Z'));
    db.run("UPDATE ledger SET at = '2026-09-14T21:56:00Z' WHERE actor = 'ashigaru9'");
    expect((db.query('SELECT COUNT(*) n FROM report').get() as { n: number }).n).toBe(0);
    expect(findStalled(db, new Set(), NOW).map((s) => s.taskId)).toEqual([taskId]);
  });

  test('期限が切れて間もない者は除く', () => {
    const { db } = seeded();
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS + 60_000));
    expect(findStalled(db, new Set(), NOW)).toEqual([]);
  });

  test('いま手が動いておる者は除く', () => {
    const { db } = seeded();
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS - 60_000));
    expect(findStalled(db, new Set(['ashigaru9']), NOW)).toEqual([]);
  });

  test('期限内の者は除く', () => {
    const { db } = seeded();
    setLease(db, new Date(NOW.getTime() + 60_000));
    expect(findStalled(db, new Set(), NOW)).toEqual([]);
  });

  test('見捨てられた司令とは取り違えぬ', () => {
    const { db, taskId } = seeded();
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS - 60_000));
    expect(findStalled(db, new Set(), NOW).map((s) => s.taskId)).toEqual([taskId]);
    expect(findAbandoned(db, NOW)).toEqual([]);
  });
});

describe('家老への報せ', () => {
  test('別種の報せを家老へ一度だけ送り、同じ止まりには二度鳴らさぬ', () => {
    const { db, taskId } = seeded();
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS - 60_000));
    expect(notifyStalled(db, new Set(), NOW).map((s) => s.taskId)).toEqual([taskId]);
    expect(notifyStalled(db, new Set(), NOW)).toEqual([]);
    const rows = db
      .query("SELECT agent, msg_type, body FROM inbox WHERE msg_type = 'lease_stalled'")
      .all() as { agent: string; msg_type: string; body: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent).toBe('karo');
    expect(rows[0]!.body).toContain('止まった持ち場: ashigaru9 /');
    expect(rows[0]!.body).not.toContain('（holder:');
    expect(rows[0]!.body).toContain('振り直すか、貸与を解くか');
    expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'cmd_abandoned'").get()).toBeNull();
  });

  test('holder が agent と異なれば報せと journal に実保持者を載せる', () => {
    const { db } = seeded();
    lendToKaro(db);
    setLease(db, new Date(NOW.getTime() - STALLED_AFTER_MS - 60_000));

    expect(notifyStalled(db, new Set(), NOW)).toHaveLength(1);
    const notice = db
      .query("SELECT body FROM inbox WHERE msg_type = 'lease_stalled'")
      .get() as { body: string };
    expect(notice.body).toContain('止まった持ち場: ashigaru9（holder: karo）/');
    expect(notice.body).toContain('karo が holder として立ったまま');
    const entry = db
      .query("SELECT detail FROM ledger WHERE action = 'lease.stalled.notice'")
      .get() as { detail: string };
    expect(entry.detail).toContain('agent=ashigaru9 holder=karo');
  });

  test('貸与が更新された後に再び止まれば改めて鳴る', () => {
    const { db } = seeded();
    setLease(db, new Date('2026-09-14T21:00:00Z'));
    expect(notifyStalled(db, new Set(), NOW)).toHaveLength(1);
    setLease(db, new Date('2026-09-14T22:00:00Z'));
    expect(notifyStalled(db, new Set(), NOW)).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) n FROM inbox WHERE msg_type = 'lease_stalled'").get() as { n: number }).n).toBe(2);
  });

  test('報せの失敗を台帳へ残し、nudge の輪は落とさぬ', async () => {
    const path = join(tmpdir(), `stalled-notice-error-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      const old = new Date(Date.now() - STALLED_AFTER_MS - 60_000);
      setLease(db, old);
      db.run('UPDATE ledger SET at = ? WHERE actor = ?', [new Date(old.getTime() - 60_000).toISOString(), 'ashigaru9']);
      db.run(`CREATE TRIGGER fail_stalled_notice
              BEFORE INSERT ON inbox
              WHEN NEW.msg_type = 'lease_stalled'
              BEGIN SELECT RAISE(ABORT, 'forced stalled notice failure'); END`);

      const result = await runNudge(path, false, false, undefined, 'core', NO_PANES, undefined, undefined, NO_SEND);
      expect(result.code).toBe(0);
      expect(result.out).toContain('next_wake_ms');
      const row = db
        .query("SELECT target, detail FROM ledger WHERE action = 'lease.stalled.notice.error'")
        .get() as { target: string; detail: string };
      expect(row.target).toBe('lease_stalled');
      expect(row.detail).toContain('forced stalled notice failure');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('nudge は直近に台帳を動かした holder を働いておる者として除く', async () => {
    const path = join(tmpdir(), `stalled-working-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      setLease(db, new Date(Date.now() - STALLED_AFTER_MS - 60_000));
      db.run('UPDATE ledger SET at = ? WHERE actor = ?', [new Date().toISOString(), 'ashigaru9']);

      const result = await runNudge(path, false, false, undefined, 'core', NO_PANES, undefined, undefined, NO_SEND);
      expect(result.code).toBe(0);
      expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'lease_stalled'").get()).toBeNull();
      expect(db.query("SELECT 1 FROM ledger WHERE action = 'lease.stalled.notice'").get()).toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('nudge は agent と異なる holder だけが働いておれば報せぬ', async () => {
    const path = join(tmpdir(), `stalled-holder-working-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      lendToKaro(db);
      setLease(db, new Date(Date.now() - STALLED_AFTER_MS - 60_000));

      const result = await runNudge(path, false, false, undefined, 'core', NO_PANES, undefined, undefined, NO_SEND);
      expect(result.code).toBe(0);
      expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'lease_stalled'").get()).toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('nudge は agent だけが働き holder が止まっておれば報せる', async () => {
    const path = join(tmpdir(), `stalled-agent-working-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      lendToKaro(db);
      setLease(db, new Date(Date.now() - STALLED_AFTER_MS - 60_000));
      db.run("UPDATE ledger SET actor = 'ashigaru9', at = ?", [new Date().toISOString()]);

      const result = await runNudge(path, false, false, undefined, 'core', NO_PANES, undefined, undefined, NO_SEND);
      expect(result.code).toBe(0);
      expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'lease_stalled'").get()).not.toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('nudge は holder の pane が処理中なら報せぬ', async () => {
    const path = join(tmpdir(), `stalled-pane-busy-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      setLease(db, new Date(Date.now() - STALLED_AFTER_MS - 60_000));
      db.run("UPDATE ledger SET at = '2000-01-01T00:00:00.000Z'");

      const paneReader = () => new Map([['ashigaru9', { id: '%2147483647', label: 'fake:agents.9' }]]);
      const result = await runNudge(path, false, false, undefined, 'core', paneReader, () => true, undefined, NO_SEND);
      expect(result.code).toBe(0);
      expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'lease_stalled'").get()).toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('nudge は holder の pane が無ければ報せる', async () => {
    const path = join(tmpdir(), `stalled-pane-absent-${Date.now()}.db`);
    try {
      const { db } = seeded(path);
      setLease(db, new Date(Date.now() - STALLED_AFTER_MS - 60_000));
      db.run("UPDATE ledger SET at = '2000-01-01T00:00:00.000Z'");

      const result = await runNudge(
        path,
        false,
        false,
        undefined,
        'core',
        NO_PANES,
        () => { throw new Error('pane が無ければ captureBusy を呼んではならぬ'); },
        undefined,
        NO_SEND,
      );
      expect(result.code).toBe(0);
      expect(db.query("SELECT 1 FROM inbox WHERE msg_type = 'lease_stalled'").get()).not.toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
