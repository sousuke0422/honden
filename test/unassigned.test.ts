import { describe, expect, test } from 'bun:test';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCmd, assignTask } from '../src/dispatch';
import { deliver } from '../src/inbox';
import { notifyAbandoned, ABANDONED_AFTER_MS } from '../src/abandoned';
import { releaseAllOf } from '../src/claim';
import { release as releaseLease } from '../src/lease';
import { runCmdList, runNudge } from '../src/main';
import { syncRoster } from '../src/roster';
import { openStore, tx } from '../src/store';
import { findUnassigned, notifyUnassigned, UNASSIGNED_AFTER_MS } from '../src/unassigned';

const CMD = {
  north_star: '書かれた司令を差配から落とさない',
  purpose: '振られぬまま止まった司令を見つける',
  acceptance_criteria: ['未差配の詰まりが検知されること'],
  command: '実装せよ',
  project: 'honden',
};

function seeded(path = ':memory:') {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
    ]);
  });
  const cmdId = createCmd(db, 'shogun', CMD).id!;
  return { db, cmdId };
}

function age(db: ReturnType<typeof seeded>['db'], cmdId: string, milliseconds: number) {
  const createdAt = new Date(Date.now() - milliseconds).toISOString();
  db.run('UPDATE cmd SET created_at = ? WHERE id = ?', [createdAt, cmdId]);
  return createdAt;
}

describe('振られぬまま止まった司令の定め', () => {
  test('陽性対照: 実件 cmd_45 と同じ18時間・task 0・家老未読1・未閉鎖を検知する', () => {
    const { db, cmdId } = seeded();
    age(db, cmdId, 18 * 60 * 60_000);
    deliver(db, {
      id: 'msg_actual-shape', agent: 'karo', at: new Date().toISOString(),
      type: 'cmd_new', sender: 'shogun', body: `${cmdId} を差配されよ`,
    });
    const taskCount = db.query('SELECT COUNT(*) n FROM task WHERE cmd_id = ?').get(cmdId) as { n: number };
    const unread = db.query("SELECT COUNT(*) n FROM inbox WHERE agent = 'karo' AND read = 0").get() as { n: number };
    const status = db.query('SELECT status FROM cmd WHERE id = ?').get(cmdId) as { status: string };
    expect({ tasks: taskCount.n, unread: unread.n, status: status.status }).toEqual({
      tasks: 0, unread: 1, status: 'pending',
    });
    expect(findUnassigned(db).map((c) => c.cmdId)).toEqual([cmdId]);
  });

  test('30分ちょうどを境界に、直前は差配待ち、境界から詰まりとする', () => {
    const { db, cmdId } = seeded();
    const createdAt = age(db, cmdId, UNASSIGNED_AFTER_MS);
    const boundary = new Date(Date.parse(createdAt) + UNASSIGNED_AFTER_MS);
    expect(findUnassigned(db, new Date(boundary.getTime() - 1))).toEqual([]);
    expect(findUnassigned(db, boundary).map((c) => c.cmdId)).toEqual([cmdId]);
  });

  test('陰性対照: 起草直後・既に振られた・閉じた司令は検知しない', () => {
    const { db, cmdId } = seeded();
    const assigned = createCmd(db, 'shogun', CMD).id!;
    const closed = createCmd(db, 'shogun', CMD).id!;
    age(db, assigned, UNASSIGNED_AFTER_MS + 60_000);
    age(db, closed, UNASSIGNED_AFTER_MS + 60_000);
    expect(assignTask(db, 'karo', {
      agent: 'ashigaru1', cmd_id: assigned, title: '任', workspace: '/w/.worktrees/unassigned-negative',
    }).ok).toBe(true);
    db.run("UPDATE cmd SET status = 'cancelled', completed_at = ? WHERE id = ?", [new Date().toISOString(), closed]);
    expect(findUnassigned(db).map((c) => c.cmdId)).not.toContain(cmdId);
    expect(findUnassigned(db).map((c) => c.cmdId)).not.toContain(assigned);
    expect(findUnassigned(db).map((c) => c.cmdId)).not.toContain(closed);
  });

  test('task の現行行が後で別司令に移っても、claim の跡がある司令を未差配へ戻さない', () => {
    const { db, cmdId } = seeded();
    expect(assignTask(db, 'karo', {
      agent: 'ashigaru1', cmd_id: cmdId, title: '一つ目', workspace: '/w/.worktrees/first',
    }).ok).toBe(true);
    const other = createCmd(db, 'shogun', CMD).id!;
    // 同じ足軽への次の差配で task の cmd_id が移っても、最初の claim の跡は残る。
    db.run('UPDATE task SET cmd_id = ? WHERE agent = ?', [other, 'ashigaru1']);
    age(db, cmdId, UNASSIGNED_AFTER_MS + 60_000);
    expect(findUnassigned(db).map((c) => c.cmdId)).not.toContain(cmdId);
  });
});

describe('家老への報せと一覧', () => {
  test('cmd_unassigned を一度だけ送り、別の未差配司令は改めて鳴る', () => {
    const { db, cmdId } = seeded();
    age(db, cmdId, UNASSIGNED_AFTER_MS + 60_000);
    expect(notifyUnassigned(db).map((c) => c.cmdId)).toEqual([cmdId]);
    expect(notifyUnassigned(db)).toEqual([]);

    const next = createCmd(db, 'shogun', CMD).id!;
    age(db, next, UNASSIGNED_AFTER_MS + 60_000);
    expect(notifyUnassigned(db).map((c) => c.cmdId)).toEqual([next]);
    const messages = db
      .query("SELECT id, agent, msg_type, body FROM inbox WHERE msg_type = 'cmd_unassigned' ORDER BY id")
      .all() as { id: string; agent: string; msg_type: string; body: string }[];
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.agent === 'karo')).toBe(true);
    expect(new Set(messages.map((m) => m.id)).size).toBe(2);
  });

  test('未差配の報せ後に振られ、今度は見捨てられれば別の報せが鳴る', () => {
    const { db, cmdId } = seeded();
    age(db, cmdId, UNASSIGNED_AFTER_MS + 60_000);
    expect(notifyUnassigned(db)).toHaveLength(1);
    expect(assignTask(db, 'karo', {
      agent: 'ashigaru1', cmd_id: cmdId, title: '後から振る', workspace: '/w/.worktrees/after-notice',
    }).ok).toBe(true);
    expect(releaseLease(db, { agent: 'ashigaru1', holder: 'ashigaru1' }).ok).toBe(true);
    expect(releaseAllOf(db, 'ashigaru1')).toBeGreaterThan(0);
    const past = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000).toISOString();
    db.run('UPDATE claim SET at = ?, released_at = ? WHERE cmd_id = ?', [past, past, cmdId]);
    expect(notifyAbandoned(db).map((c) => c.cmdId)).toEqual([cmdId]);
    const types = db
      .query("SELECT msg_type FROM inbox WHERE msg_type IN ('cmd_unassigned','cmd_abandoned')")
      .all() as { msg_type: string }[];
    expect(types.map((m) => m.msg_type).sort()).toEqual(['cmd_abandoned', 'cmd_unassigned']);
  });

  test('一覧では未差配・見捨てられ・止まった持ち場の語を混ぜない', () => {
    const path = join(tmpdir(), `unassigned-list-${Date.now()}.db`);
    try {
      const { db, cmdId } = seeded(path);
      age(db, cmdId, UNASSIGNED_AFTER_MS + 60_000);
      const line = runCmdList(path, false).out!.split('\n').find((s) => s.includes(cmdId))!;
      expect(line).toContain('⚠未差配');
      expect(line).not.toContain('⚠見捨てられ');
      expect(line).not.toContain('止まった持ち場');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('protocol は三つの検知を別種別で示し、新種別を急ぎに含める', () => {
    const protocol = readFileSync(join(import.meta.dir, '..', 'instructions/common/protocol.md'), 'utf8');
    expect(protocol).toContain('`cmd_unassigned` / `cmd_abandoned` / `lease_stalled`');
    expect(protocol).toContain('`cmd_unassigned` を受けた家老');
    expect(protocol.match(/急ぎ（[^\n]+`cmd_unassigned`/)).not.toBeNull();
  });

  test('報せの失敗を台帳へ残しても nudge の輪を落とさない', async () => {
    const path = join(tmpdir(), `unassigned-notice-error-${Date.now()}.db`);
    try {
      const { db, cmdId } = seeded(path);
      age(db, cmdId, UNASSIGNED_AFTER_MS + 60_000);
      db.run(`CREATE TRIGGER fail_unassigned_notice
              BEFORE INSERT ON inbox
              WHEN NEW.msg_type = 'cmd_unassigned'
              BEGIN SELECT RAISE(ABORT, 'forced unassigned notice failure'); END`);
      const result = await runNudge(path, false, false, undefined, 'core');
      expect(result.code).toBe(0);
      expect(result.out).toContain('next_wake_ms');
      const row = db
        .query("SELECT action, target, detail FROM ledger WHERE action = 'cmd.unassigned.notice.error'")
        .get() as { action: string; target: string; detail: string };
      expect(row.target).toBe('cmd_unassigned');
      expect(row.detail).toContain('forced unassigned notice failure');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
