/**
 * 司令の書き換えの試験。
 *
 * 中心は 4 つ。
 *
 *   1. 書き換えと知らせが同じ取引であること（別の操作にすると忘れられる）
 *   2. 家老だけでなく、働いておる者全員へ届くこと
 *   3. 条件が変わる前の証拠を覆いに数えぬこと（最も静かに壊れる所）
 *   4. 閉じた司令は書き換えられぬこと（2026-07-14 の失敗）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport, submitQc, cmdDone, coverageOf } from '../src/report';
import { amendCmd, workersOn } from '../src/amend';

const CMD = {
  north_star: '書き換えが誰にも届かぬと、旧版の指示で動き続ける',
  purpose: '途中で書き換えられるようにする',
  acceptance_criteria: ['試験が通ること', 'push しておらぬこと'],
  command: '実装せよ',
  project: 'honden',
};
const REASON = 'skills が whitelist gitignore であることを見落としておった';

function seeded() {
  const db = openStore({ path: ':memory:' });
  tx(db, () =>
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
    ]),
  );
  return { db, cmdId: createCmd(db, 'shogun', CMD).id! };
}
const unread = (db: ReturnType<typeof openStore>, a: string) =>
  (db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(a) as { c: number }).c;

describe('誰が書き換えられるか', () => {
  test('将軍だけ', () => {
    const { db, cmdId } = seeded();
    const r = amendCmd(db, 'karo', { cmd_id: cmdId, purpose: 'べつの狙い', reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('shogun');
  });

  test('理由が要る', () => {
    const { db, cmdId } = seeded();
    expect(amendCmd(db, 'shogun', { cmd_id: cmdId, purpose: 'べつの狙い' }).ok).toBe(false);
  });

  test('変わるものが無ければ断る', () => {
    const { db, cmdId } = seeded();
    const r = amendCmd(db, 'shogun', { cmd_id: cmdId, purpose: CMD.purpose, reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('変わるものが無い');
  });

  test('書き換えられぬ欄は断る', () => {
    const { db, cmdId } = seeded();
    const r = amendCmd(db, 'shogun', { cmd_id: cmdId, status: 'done', reason: REASON });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('status');
  });
});

describe('知らせが同じ取引で飛ぶ', () => {
  test('家老へ届く', () => {
    const { db, cmdId } = seeded();
    const before = unread(db, 'karo');
    expect(amendCmd(db, 'shogun', { cmd_id: cmdId, purpose: 'べつの狙い', reason: REASON }).ok).toBe(true);
    expect(unread(db, 'karo')).toBe(before + 1);
  });

  test('働いておる足軽にも届く。家老が知っただけでは手元が変わらぬゆえ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    const before = unread(db, 'ashigaru1');
    amendCmd(db, 'shogun', { cmd_id: cmdId, command: 'やり方を変えよ', reason: REASON });
    expect(unread(db, 'ashigaru1')).toBe(before + 1);
  });

  test('振られておらぬ者へは届かぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    const before = unread(db, 'ashigaru2');
    amendCmd(db, 'shogun', { cmd_id: cmdId, command: 'やり方を変えよ', reason: REASON });
    expect(unread(db, 'ashigaru2')).toBe(before);
  });

  test('知らせに理由と差分が載る', () => {
    const { db, cmdId } = seeded();
    amendCmd(db, 'shogun', {
      cmd_id: cmdId,
      acceptance_criteria: ['試験が通ること', 'push しておらぬこと', '他の worktree に触れておらぬこと'],
      reason: REASON,
    });
    const m = db.query("SELECT body FROM inbox WHERE agent='karo' ORDER BY rowid DESC LIMIT 1").get() as {
      body: string;
    };
    expect(m.body).toContain(REASON);
    expect(m.body).toContain('条件 3 が増えた');
  });

  test('跡が台帳と revision に残る', () => {
    const { db, cmdId } = seeded();
    amendCmd(db, 'shogun', { cmd_id: cmdId, purpose: 'べつの狙い', reason: REASON });
    const rev = db.query('SELECT field, before, after, reason FROM cmd_revision').all() as {
      field: string;
      before: string;
      after: string;
      reason: string;
    }[];
    expect(rev.length).toBe(1);
    expect(rev[0]!.before).toBe(CMD.purpose);
    expect(rev[0]!.after).toBe('べつの狙い');
    const led = db.query("SELECT detail FROM ledger WHERE action='cmd.amend'").all() as { detail: string }[];
    expect(led[0]!.detail).toContain('知らせた先=[karo]');
  });
});

describe('条件を変えたら、古い証拠は数えぬ', () => {
  function withEvidence() {
    const s = seeded();
    const a = assignTask(s.db, 'karo', { agent: 'ashigaru1', cmd_id: s.cmdId, title: '一' });
    const r = submitReport(s.db, 'ashigaru1', {
      task_id: a.id!,
      status: 'done',
      summary: '納めた',
      acceptance: { 1: 'bun test 387 pass / exit 0', 2: 'git log で push なし' },
    });
    submitQc(s.db, 'gunshi', { report_id: r.id, verdict: 'APPROVED', summary: '検めた' });
    return s;
  }

  test('変える前は覆っておる', () => {
    const { db, cmdId } = withEvidence();
    expect(coverageOf(db, cmdId).uncovered.length).toBe(0);
  });

  test('条件の文言を変えると、その条件だけ覆いが外れる', () => {
    const { db, cmdId } = withEvidence();
    amendCmd(
      db,
      'shogun',
      { cmd_id: cmdId, acceptance_criteria: ['試験が通り、かつ SKIP が 0 であること', 'push しておらぬこと'], reason: REASON },
      new Date(Date.now() + 1000),
    );
    const cov = coverageOf(db, cmdId);
    expect(cov.uncovered.map((c) => c.idx)).toEqual([1]);
    // 変えておらぬ条件 2 は覆ったまま
    expect(cov.covered.has(2)).toBe(true);
  });

  test('証拠は消さぬ。数えぬだけである', () => {
    const { db, cmdId } = withEvidence();
    const before = (db.query('SELECT count(*) c FROM report_acceptance').get() as { c: number }).c;
    amendCmd(
      db,
      'shogun',
      { cmd_id: cmdId, acceptance_criteria: ['変えた条件', 'push しておらぬこと'], reason: REASON },
      new Date(Date.now() + 1000),
    );
    expect((db.query('SELECT count(*) c FROM report_acceptance').get() as { c: number }).c).toBe(before);
  });

  test('覆いが外れれば門も閉じる', () => {
    const { db, cmdId } = withEvidence();
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(true);
  });

  test('条件を変えた後は閉じられぬ', () => {
    const { db, cmdId } = withEvidence();
    amendCmd(
      db,
      'shogun',
      { cmd_id: cmdId, acceptance_criteria: ['変えた条件', 'push しておらぬこと'], reason: REASON },
      new Date(Date.now() + 1000),
    );
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('変えた条件');
  });
});

describe('閉じた司令', () => {
  test('書き換えられぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    const r = submitReport(db, 'ashigaru1', {
      task_id: a.id!,
      status: 'done',
      summary: '納めた',
      acceptance: { 1: 'bun test 387 pass', 2: 'git log で push なし' },
    });
    submitQc(db, 'gunshi', { report_id: r.id, verdict: 'APPROVED', summary: '検めた' });
    cmdDone(db, 'karo', { cmd_id: cmdId });
    const am = amendCmd(db, 'shogun', { cmd_id: cmdId, purpose: 'あとから変える', reason: REASON });
    expect(am.ok).toBe(false);
    expect(am.message).toContain('誰にも届かぬ');
  });
});

describe('働いておる者を数える', () => {
  test('idle は数えぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    expect(workersOn(db, cmdId).map((w) => w.agent)).toEqual(['ashigaru1']);
  });
});
