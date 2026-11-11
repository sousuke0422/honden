import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openStore, tx } from '../src/store';
import { syncRoster, roster } from '../src/roster';
import { deliver, summarize, type Summary } from '../src/inbox';
import {
  markSince,
  nudgeSnapshot,
  plan,
  startClocks,
  stateOf,
  type NudgeSnapshot,
} from '../src/nudge';
import { runNudge } from '../src/main';
import type { Pane } from '../src/pane';

const T0 = new Date('2026-11-11T00:00:00.000Z');
const NOW = new Date('2026-11-11T00:05:00.000Z');
const PANES = new Map<string, Pane>([
  ['karo', { id: '%1', label: 'test:karo.0' }],
  ['ashigaru1', { id: '%2', label: 'test:ashigaru1.0' }],
  ['ashigaru2', { id: '%3', label: 'test:ashigaru2.0' }],
]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seeded(path = ':memory:') {
  const db = openStore({ path });
  tx(db, () => syncRoster(db, [
    { id: 'shogun', role: 'commander', cli: 'claude', model: null },
    { id: 'karo', role: 'commander', cli: 'cursor', model: null },
    { id: 'ashigaru1', role: 'worker', cli: 'codex', model: null },
    { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
  ]));
  return db;
}

function mail(db: ReturnType<typeof seeded>, id: string, agent: string, type: string) {
  deliver(db, { id, agent, at: T0.toISOString(), type, sender: 'karo', body: '用件' });
}

/** 最適化前と同じく、一人ずつ正本を読む写し。比較試験だけに残す。 */
function legacySnapshot(db: ReturnType<typeof seeded>): NudgeSnapshot {
  const entries = roster(db);
  const summaries = new Map<string, Summary>();
  const states = new Map();
  const oldestUnread = new Map<string, string>();
  for (const entry of entries) {
    summaries.set(entry.id, summarize(db, entry.id));
    states.set(entry.id, stateOf(db, entry.id));
    const row = db.query('SELECT MIN(created_at) oldest FROM inbox WHERE agent = ? AND read = 0')
      .get(entry.id) as { oldest: string | null };
    if (row.oldest !== null) oldestUnread.set(entry.id, row.oldest);
  }
  return { entries, summaries, states, oldestUnread };
}

describe('nudge の一巡写し', () => {
  test('複数人・busy 再計画・保留を含めても旧来の一人ずつの判じと同じ plan になる', () => {
    const db = seeded();
    tx(db, () => {
      mail(db, 'm1', 'ashigaru1', 'report_received');
      mail(db, 'm2', 'ashigaru1', 'cmd_update');
      mail(db, 'm3', 'ashigaru2', 'task_assigned');
      mail(db, 'm4', 'karo', 'report_received');
      markSince(db, 'ashigaru1', T0);
      markSince(db, 'ashigaru2', T0);
      markSince(db, 'karo', T0);
      db.run("UPDATE nudge SET hold_reason = 'undated-limit', hold_at = ? WHERE agent = 'ashigaru2'", [T0.toISOString()]);
    });
    const busy = new Set(['ashigaru1']);
    const busyReason = new Map([['ashigaru1', '画面が処理中']]);
    const oldPlan = plan(db, NOW, {
      autonomous: false, panes: PANES, busy, busyReason, snapshot: legacySnapshot(db),
    });
    const newPlan = plan(db, NOW, {
      autonomous: false, panes: PANES, busy, busyReason, snapshot: nudgeSnapshot(db),
    });
    expect(newPlan).toEqual(oldPlan);
  });

  test('名簿・全員の未読集計・全員の状態を一本の query で読む', () => {
    const db = seeded();
    mail(db, 'm1', 'ashigaru1', 'cmd_update');
    const original = db.query.bind(db);
    let queries = 0;
    Object.defineProperty(db, 'query', {
      value: (sql: string) => {
        queries++;
        return original(sql);
      },
    });
    const snapshot = nudgeSnapshot(db as Database);
    startClocks(db, NOW, { autonomous: false, snapshot });
    plan(db, NOW, { autonomous: false, panes: PANES, snapshot });
    expect(queries).toBe(1);
    expect(snapshot.summaries.get('ashigaru1')).toEqual(summarizeFromRows(1, 'cmd_update'));
  });

  test('pane 列挙中に ack された相手を、古い未読数で計画しない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-nudge-snapshot-'));
    dirs.push(dir);
    const path = join(dir, 'honden.db');
    const db = seeded(path);
    mail(db, 'm1', 'ashigaru1', 'cmd_update');
    let sent = 0;
    const result = await runNudge(
      path, true, false, undefined, 'core',
      () => {
        db.run("UPDATE inbox SET read = 1 WHERE id = 'm1'");
        return PANES;
      },
      () => false,
      () => null,
      async () => { sent++; return { ok: true }; },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('未読は無い');
    expect(result.out).not.toContain('ashigaru1 未読1');
    expect(sent).toBe(0);
    db.close();
  });

  test('busy capture 中に保留へ変われば、再 plan は新しい状態を読む', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-nudge-snapshot-'));
    dirs.push(dir);
    const path = join(dir, 'honden.db');
    const db = seeded(path);
    mail(db, 'm1', 'ashigaru1', 'cmd_update');
    markSince(db, 'ashigaru1', T0);
    const result = await runNudge(
      path, true, false, undefined, 'core',
      () => PANES,
      () => {
        db.run(
          "UPDATE nudge SET hold_reason = 'unresponsive', hold_at = ? WHERE agent = 'ashigaru1'",
          [NOW.toISOString()],
        );
        return true;
      },
      () => null,
      async () => ({ ok: true }),
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('ashigaru1 未読1');
    expect(result.out).toContain('上役の確認待ち（unresponsive');
    expect(result.out).not.toContain('[--dry-run ゆえ撃たぬ]');
    db.close();
  });
});

function summarizeFromRows(count: number, type: string): Summary {
  return { total: count, byType: [{ type, count }], urgent: true };
}
