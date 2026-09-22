/**
 * 検め待ちの報告が status / cmd list に映る試験。
 */
import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { listPendingReviews } from '../src/report';
import { runCmdList, runStatus } from '../src/main';

const CMD = {
  north_star: '検め待ちが見える',
  purpose: '座が入れ替わっても残りが分かる',
  acceptance_criteria: ['検め待ちが出ること'],
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
      { id: 'ashigaru1', role: 'worker', cli: 'codex', model: null },
      { id: 'ashigaru2', role: 'worker', cli: 'codex', model: null },
    ]);
  });
  const cmdId = createCmd(db, 'shogun', CMD).id!;
  const assigned = assignTask(db, 'karo', {
    agent: 'ashigaru1', cmd_id: cmdId, title: '試料', workspace: '/w/.worktrees/test',
  });
  expect(assigned.ok).toBe(true);
  const taskId = (db.query('SELECT task_id FROM task WHERE agent = ?').get('ashigaru1') as { task_id: string }).task_id;
  return { db, cmdId, taskId };
}

function addDoneReport(
  db: ReturnType<typeof seeded>['db'],
  taskId: string,
  cmdId: string,
  opts: { agent?: string; verdict?: string | null } = {},
): number {
  db.run(
    'INSERT INTO report(agent, task_id, created_at, verdict, cmd_id, origin, raw) VALUES (?,?,?,?,?,?,?)',
    [
      opts.agent ?? 'ashigaru1',
      taskId,
      new Date().toISOString(),
      opts.verdict ?? null,
      cmdId,
      'native',
      JSON.stringify({ status: 'done' }),
    ],
  );
  return (db.query('SELECT MAX(id) id FROM report').get() as { id: number }).id;
}

describe('検め待ちの一覧', () => {
  test('陽性: done 報告が検め待ちとして出る', () => {
    const { db, cmdId, taskId } = seeded();
    const rid = addDoneReport(db, taskId, cmdId);
    const pending = listPendingReviews(db);
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(rid);
    expect(pending[0]!.cmdId).toBe(cmdId);
  });

  test('陰性: 検め済みの報告は出ない', () => {
    const { db, cmdId, taskId } = seeded();
    addDoneReport(db, taskId, cmdId);
    addDoneReport(db, taskId, cmdId, { agent: 'gunshi', verdict: 'APPROVED' });
    expect(listPendingReviews(db)).toEqual([]);
  });

  test('陰性: 司令が閉じた報告は出ない', () => {
    const { db, cmdId, taskId } = seeded();
    addDoneReport(db, taskId, cmdId);
    db.run("UPDATE cmd SET status = 'done', completed_at = ? WHERE id = ?", [new Date().toISOString(), cmdId]);
    expect(listPendingReviews(db)).toEqual([]);
  });

  test('陰性: 検め済み task への直しの報告は出ない', () => {
    const { db, cmdId, taskId } = seeded();
    addDoneReport(db, taskId, cmdId);
    addDoneReport(db, taskId, cmdId, { agent: 'gunshi', verdict: 'APPROVED' });
    const rid = addDoneReport(db, taskId, cmdId, { agent: 'ashigaru2' });
    const pending = listPendingReviews(db);
    expect(pending.some((p) => p.id === rid)).toBe(false);
  });
});

describe('cmd list と status に映す', () => {
  test('cmd list の行と末尾に検め待ちが出る', () => {
    const path = join(tmpdir(), `pending-review-cmd-${Date.now()}.db`);
    try {
      const { db, cmdId, taskId } = seeded(path);
      const rid = addDoneReport(db, taskId, cmdId);
      const other = createCmd(db, 'shogun', CMD).id!;
      const r = runCmdList(path, false);
      const line = (id: string) => r.out!.split('\n').find((l) => l.includes(id))!;
      expect(line(cmdId)).toContain('検め待ち');
      expect(line(cmdId)).toContain(`#${rid}`);
      expect(line(other)).not.toContain('検め待ち');
      expect(r.out).toContain(`検め待ち（1 件）`);
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('status の末尾に検め待ちが出る', () => {
    const path = join(tmpdir(), `pending-review-status-${Date.now()}.db`);
    try {
      const { db, taskId, cmdId } = seeded(path);
      addDoneReport(db, taskId, cmdId);
      const r = runStatus(path, false);
      expect(r.out).toContain('検め待ち');
      expect(r.out).toContain(cmdId);
      expect(r.out).toContain('ashigaru1');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
