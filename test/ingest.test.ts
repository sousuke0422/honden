/**
 * 構造化取り込みの試験。
 *
 * 現行の YAML の形をそのまま受けること、そして何度走らせても同じ結果に
 * なることを確かめる。
 */

import { expect, test, describe } from 'bun:test';
import { openStore } from '../src/store';
import { ingestAll } from '../src/ingest';

const mem = () => openStore({ path: ':memory:' });

// 現行の形をそのまま写した見本（2026-08-25 の実データに合わせてある）
const INBOX = `messages:
  - content: |
      cmd_704を書いた。実行せよ。
    from: shogun
    id: msg_20260824_120000_abcd1234
    read: false
    timestamp: '2026-08-24T12:00:00'
    type: cmd_new
  - content: 報告を受けた
    from: ashigaru1
    id: msg_20260824_130000_beef5678
    read: true
    timestamp: '2026-08-24T13:00:00'
    type: report_completed
`;

const TASK = `task_id: subtask_704_001
worker_id: ashigaru1
status: assigned
updated_at: '2026-08-24T12:27:37'
parent_cmd: cmd_704
title: 誤検知を止めよ
bloom_level: L4
`;

const REPORT = `task_id: subtask_705_001
worker_id: gunshi
timestamp: '2026-08-24T13:10:00'
status: done
verdict: APPROVED
checks:
  - name: build
    result: PASS
`;

const files = (over: Partial<Record<'inbox' | 'task' | 'report', string>> = {}) => [
  { path: 'queue/inbox/karo.yaml', body: over.inbox ?? INBOX },
  { path: 'queue/tasks/ashigaru1.yaml', body: over.task ?? TASK },
  { path: 'queue/reports/gunshi_subtask_705_001_qc.yaml', body: over.report ?? REPORT },
];

const counts = (db: ReturnType<typeof mem>) => ({
  inbox: (db.query('SELECT count(*) c FROM inbox').get() as { c: number }).c,
  task: (db.query('SELECT count(*) c FROM task').get() as { c: number }).c,
  report: (db.query('SELECT count(*) c FROM report').get() as { c: number }).c,
});

describe('現行の形をそのまま受ける', () => {
  test('inbox の 6 つの鍵を写す', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const m = db
      .query('SELECT id, agent, msg_type, sender, body, read FROM inbox ORDER BY id')
      .all() as Record<string, unknown>[];
    expect(m.length).toBe(2);
    // 宛先はファイル名から取る（中身に宛先は書かれていない）
    expect(m[0]?.agent).toBe('karo');
    expect(m[0]?.sender).toBe('shogun');
    expect(m[0]?.msg_type).toBe('cmd_new');
    expect(m[0]?.read).toBe(0);
  });

  // skills/external-to-shogun は「type は 5 種類のみ」と書いているが、
  // 実データには report_completed がある。文書ではなくデータに合わせる。
  test('report_completed も受ける', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const t = db.query("SELECT count(*) c FROM inbox WHERE msg_type = 'report_completed'").get() as {
      c: number;
    };
    expect(t.c).toBe(1);
  });

  test('task は worker_id を持ち場の名にする', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const t = db.query('SELECT agent, task_id, status, cmd_id FROM task').get() as Record<string, unknown>;
    expect(t).toEqual({
      agent: 'ashigaru1',
      task_id: 'subtask_704_001',
      status: 'assigned',
      cmd_id: 'cmd_704',
    });
  });

  // 取り込みで貸与を握らせると、誰も居ないのに握られた形になる。
  test('取り込みは貸与を握らせぬ', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const t = db.query('SELECT holder, lease_until FROM task').get() as Record<string, unknown>;
    expect(t.holder).toBeNull();
    expect(t.lease_until).toBeNull();
  });

  test('report の verdict は規定の 4 値だけ通す', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const r = db.query('SELECT verdict, legacy FROM report').get() as Record<string, unknown>;
    expect(r.verdict).toBe('APPROVED');
  });

  test('規定外の verdict は legacy へ逃がす', () => {
    const db = mem();
    ingestAll(db, '.', files({ report: REPORT.replace('APPROVED', 'PASS') }));
    const r = db.query('SELECT verdict, legacy FROM report').get() as { verdict: null; legacy: string };
    expect(r.verdict).toBeNull();
    expect(JSON.parse(r.legacy).verdict).toBe('PASS');
  });

  test('型に収まらぬ鍵も legacy に残る', () => {
    const db = mem();
    ingestAll(db, '.', files());
    const r = db.query('SELECT legacy FROM report').get() as { legacy: string };
    expect(JSON.parse(r.legacy)).toHaveProperty('checks');
  });
});

describe('繰り返し走らせる', () => {
  test('三度走らせても件数が変わらぬ', () => {
    const db = mem();
    for (let i = 0; i < 3; i++) ingestAll(db, '.', files());
    expect(counts(db)).toEqual({ inbox: 2, task: 1, report: 1 });
  });

  test('中身が変われば上書きされる（増えぬ）', () => {
    const db = mem();
    ingestAll(db, '.', files());
    ingestAll(db, '.', files({ task: TASK.replace('assigned', 'done') }));
    expect(counts(db).task).toBe(1);
    const t = db.query('SELECT status FROM task').get() as { status: string };
    expect(t.status).toBe('done');
  });

  test('既読になった報せは既読で上書きされる', () => {
    const db = mem();
    ingestAll(db, '.', files());
    ingestAll(db, '.', files({ inbox: INBOX.replace('read: false', 'read: true') }));
    const n = (db.query('SELECT count(*) c FROM inbox WHERE read = 0').get() as { c: number }).c;
    expect(n).toBe(0);
  });
});

describe('入れぬもの', () => {
  test('id の無い報せは入れぬ（追えぬゆえ）', () => {
    const db = mem();
    ingestAll(db, '.', files({ inbox: 'messages:\n  - content: x\n    from: shogun\n    type: cmd_new\n' }));
    expect(counts(db).inbox).toBe(0);
  });

  test('持ち場でない名の task は入れぬ', () => {
    const db = mem();
    ingestAll(db, '.', [{ path: 'queue/tasks/pending.yaml', body: 'task_id: x\nstatus: idle\n' }]);
    expect(counts(db).task).toBe(0);
  });

  test('読めぬ YAML は飛ばして数える', () => {
    const db = mem();
    const r = ingestAll(db, '.', [{ path: 'queue/tasks/x.yaml', body: 'a: 1\n  b: 2\n c: 3\n' }]);
    expect(r.skipped).toBe(1);
    expect(counts(db).task).toBe(0);
  });
});
