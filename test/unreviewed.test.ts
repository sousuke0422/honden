/**
 * 検められておらぬ報告の試験。
 *
 * 眼目は取り違えの排除である。検め（QC）は元の行を書き換えず新しい行を
 * 挿すゆえ、『verdict が NULL』はほぼ全ての足軽報告に当てはまる。
 * task ごとの最新行だけを見る定めが、検め済み・差し替わり・閉じた司令を
 * 正しく外すことを、陽性と陰性の両対照で固定する。
 */
import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import {
  findUnreviewed, notifyUnreviewed, UNREVIEWED_AFTER_MS, UNREVIEWED_ESCALATE_MS,
} from '../src/unreviewed';
import { runNudge } from '../src/main';

const CMD = {
  north_star: '検めの詰まりを黙って残さぬ',
  purpose: '上がったまま検められておらぬ報告を軍師へ知らせる',
  acceptance_criteria: ['詰まりが検知されること'],
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
      { id: 'ashigaru9', role: 'worker', cli: 'codex', model: null },
    ]);
  });
  const cmdId = createCmd(db, 'shogun', CMD).id!;
  const assigned = assignTask(db, 'karo', {
    agent: 'ashigaru9', cmd_id: cmdId, title: '詰まり試料', workspace: `/w/.worktrees/${cmdId}`,
  });
  expect(assigned.ok).toBe(true);
  const taskId = (db.query('SELECT task_id FROM task WHERE agent = ?').get('ashigaru9') as { task_id: string }).task_id;
  // 配られた task_assigned を既読にする。runNudge を通す試験で plan が
  // ashigaru9 へ撃つ理由を残さぬため——plan は panes() で実の tmux を写すゆえ、
  // 実陣に同じ名の pane が在れば本物へ撃ってしまう（sender の注ぎ口が
  // main へ入るまでの塞ぎ）。
  db.run("UPDATE inbox SET read = 1 WHERE agent = 'ashigaru9'");
  return { db, cmdId, taskId };
}

function addReport(
  db: ReturnType<typeof seeded>['db'],
  taskId: string,
  cmdId: string,
  agoMs: number,
  opts: { agent?: string; verdict?: string | null; origin?: string } = {},
): number {
  db.run(
    'INSERT INTO report(agent, task_id, created_at, verdict, cmd_id, origin, raw) VALUES (?,?,?,?,?,?,?)',
    [
      opts.agent ?? 'ashigaru9',
      taskId,
      new Date(Date.now() - agoMs).toISOString(),
      opts.verdict ?? null,
      cmdId,
      opts.origin ?? 'native',
      '{}',
    ],
  );
  return (db.query('SELECT MAX(id) id FROM report').get() as { id: number }).id;
}

const MIN = 60_000;

describe('検められておらぬ報告の定め', () => {
  test('実際に起きた形——上がって 75 分・verdict 無し・司令は開き・新しい報告も無い——を検知する', () => {
    const { db, cmdId, taskId } = seeded();
    const rid = addReport(db, taskId, cmdId, 75 * MIN);
    const found = findUnreviewed(db);
    expect(found.length).toBe(1);
    expect(found[0]!.reportId).toBe(rid);
    expect(found[0]!.taskId).toBe(taskId);
  });

  test('陰性対照一: 上がって間もない報告は検知せぬ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 10 * MIN);
    expect(findUnreviewed(db)).toEqual([]);
  });

  test('陰性対照二: 既に検められた報告は検知せぬ（QC は新しい行で挿さる）', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);                       // 足軽の報告（verdict NULL のまま）
    addReport(db, taskId, cmdId, 90 * MIN, { agent: 'gunshi', verdict: 'APPROVED' }); // 検め
    expect(findUnreviewed(db)).toEqual([]);
  });

  test('陰性対照三: 後から差し替わった古い報告は検知せぬ——役は新しい方が引き継ぐ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);        // 古い報告（もう検め待ちではない）
    addReport(db, taskId, cmdId, 5 * MIN);          // 直しの報告（まだ閾値前）
    expect(findUnreviewed(db)).toEqual([]);
  });

  test('陰性対照四: 閉じた司令の報告は検知せぬ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);
    db.run("UPDATE cmd SET status = 'done' WHERE id = ?", [cmdId]);
    expect(findUnreviewed(db)).toEqual([]);
  });

  test('import の報告（旧陣の写し）は検知せぬ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN, { origin: 'import' });
    expect(findUnreviewed(db)).toEqual([]);
  });

  test('直しの報告も詰まれば改めて掛かる（最新行が閾値を過ぎた時）', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);
    const rid2 = addReport(db, taskId, cmdId, 40 * MIN);
    const found = findUnreviewed(db);
    expect(found.length).toBe(1);
    expect(found[0]!.reportId).toBe(rid2); // 数えるのは最新の一件だけ
  });
});

describe('軍師への報せと家老への引き上げ', () => {
  test('軍師へ report_unreviewed が届き、同じ詰まりには二度鳴らさぬ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 75 * MIN);
    expect(notifyUnreviewed(db).length).toBe(1);
    expect(notifyUnreviewed(db).length).toBe(0); // 二度目は届け直さぬ
    const rows = db.query("SELECT agent, msg_type FROM inbox WHERE msg_type = 'report_unreviewed'").all() as
      { agent: string; msg_type: string }[];
    expect(rows.length).toBe(1); // 挿さるのは一度だけ
    expect(rows[0]!.agent).toBe('gunshi');
    expect(db.query("SELECT 1 FROM ledger WHERE action = 'report.unreviewed.notice'").get()).not.toBeNull();
  });

  test('閾値の三倍を過ぎれば家老へも一度だけ報せる（75 分では軍師のみ）', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 75 * MIN);
    notifyUnreviewed(db);
    expect(db.query("SELECT 1 FROM inbox WHERE agent = 'karo' AND msg_type = 'report_unreviewed'").get()).toBeNull();
    const { db: db2, cmdId: c2, taskId: t2 } = seeded();
    addReport(db2, t2, c2, UNREVIEWED_ESCALATE_MS + 5 * MIN);
    notifyUnreviewed(db2);
    notifyUnreviewed(db2);
    const karo = db2.query("SELECT COUNT(*) n FROM inbox WHERE agent = 'karo' AND msg_type = 'report_unreviewed'").get() as { n: number };
    expect(karo.n).toBe(1);
    expect(db2.query("SELECT 1 FROM ledger WHERE action = 'report.unreviewed.escalate'").get()).not.toBeNull();
  });

  test('検め済みの task への直しの報告は軍師へ報せぬ——submitQc が拒み、果たせぬ命になるゆえ', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);
    notifyUnreviewed(db);
    addReport(db, taskId, cmdId, 100 * MIN, { agent: 'gunshi', verdict: 'CHANGES_REQUESTED' });
    expect(findUnreviewed(db)).toEqual([]); // 検めが出た——一旦静まる
    addReport(db, taskId, cmdId, 45 * MIN); // 直しの報告が上がったが、この task はもう検められぬ
    expect(findUnreviewed(db)).toEqual([]);
    notifyUnreviewed(db);
    const n = (db.query("SELECT COUNT(*) n FROM inbox WHERE agent = 'gunshi' AND msg_type = 'report_unreviewed'").get() as { n: number }).n;
    expect(n).toBe(1); // 最初の一通だけ。軍師へは増えぬ
  });

  test('検め済みの task への直しの報告は、家老へ「振り直しが要る」として届く', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 120 * MIN);
    addReport(db, taskId, cmdId, 100 * MIN, { agent: 'gunshi', verdict: 'CHANGES_REQUESTED' });
    const rid = addReport(db, taskId, cmdId, 45 * MIN);
    notifyUnreviewed(db);
    notifyUnreviewed(db); // 二度呼んでも一度だけ
    const rows = db.query("SELECT agent, body FROM inbox WHERE msg_type = 'report_requeue'").all() as
      { agent: string; body: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent).toBe('karo');
    expect(rows[0]!.body).toContain('振り直しが要る報告');
    expect(rows[0]!.body).toContain(`#${rid}`);
    expect(rows[0]!.body).toContain('新しい仕事として振り直されよ'); // submitQc の門と同じ言葉
    expect(db.query("SELECT 1 FROM ledger WHERE action = 'report.requeue.notice'").get()).not.toBeNull();
    // まだ間もない直しの報告（閾値前）は requeue にも数えぬ
    const { db: db3, cmdId: c3, taskId: t3 } = seeded();
    addReport(db3, t3, c3, 120 * MIN);
    addReport(db3, t3, c3, 100 * MIN, { agent: 'gunshi', verdict: 'CHANGES_REQUESTED' });
    addReport(db3, t3, c3, 5 * MIN);
    notifyUnreviewed(db3);
    expect(db3.query("SELECT 1 FROM inbox WHERE msg_type = 'report_requeue'").get()).toBeNull();
  });

  test('四つの検知が別の言葉・別の種別で現れる', () => {
    const { db, cmdId, taskId } = seeded();
    addReport(db, taskId, cmdId, 75 * MIN);
    notifyUnreviewed(db);
    const body = (db.query("SELECT body FROM inbox WHERE msg_type = 'report_unreviewed'").get() as { body: string }).body;
    expect(body).toContain('検められておらぬ報告');
    for (const other of ['見捨てられた司令', '止まった持ち場', '未差配']) {
      expect(body).not.toContain(other);
    }
    // 種別も既存の三つ（cmd_abandoned / lease_stalled / cmd_unassigned）と重ならぬ
    expect(['cmd_abandoned', 'lease_stalled', 'cmd_unassigned']).not.toContain('report_unreviewed');
  });
});

describe('nudge の輪との繋ぎ', () => {
  test('nudge が詰まりを見つけて報せ、報せの失敗でも輪を落とさぬ', async () => {
    const path = join(tmpdir(), `unreviewed-${Date.now()}.db`);
    try {
      const { db, cmdId, taskId } = seeded(path);
      addReport(db, taskId, cmdId, 75 * MIN);
      const r = await runNudge(path, false, false, undefined, 'core', () => new Map());
      expect(r.code).toBe(0);
      expect(r.out).toContain('検められておらぬ報告を軍師へ報せた');
      expect(db.query("SELECT 1 FROM inbox WHERE agent = 'gunshi' AND msg_type = 'report_unreviewed'").get()).not.toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('報せの挿しが落ちても台帳へ残し、nudge は生きて返る', async () => {
    const path = join(tmpdir(), `unreviewed-fail-${Date.now()}.db`);
    try {
      const { db, cmdId, taskId } = seeded(path);
      addReport(db, taskId, cmdId, 75 * MIN);
      db.run(`CREATE TRIGGER forbid_unreviewed
              BEFORE INSERT ON inbox
              WHEN NEW.msg_type = 'report_unreviewed'
              BEGIN SELECT RAISE(ABORT, 'forced unreviewed notice failure'); END`);
      const r = await runNudge(path, false, false, undefined, 'core', () => new Map());
      expect(r.code).toBe(0);
      expect(r.out).toContain('next_wake_ms');
      const row = db
        .query("SELECT detail FROM ledger WHERE action = 'report.unreviewed.notice.error'")
        .get() as { detail: string };
      expect(row.detail).toContain('forced unreviewed notice failure');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
