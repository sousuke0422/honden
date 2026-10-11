/**
 * 差し戻しの後に同じ仕事で出し直した報告を、軍師が検められ、台帳が閉じられる（cmd_237）。
 *
 * 検めは仕事（task）ではなく報告（report）に付く。門・覆い・閉じは、その仕事の
 * **最も新しい報告**と、それへの検めを見る。古い報告への差し戻しは跡として残るが、
 * 新しい報告の是を塞がぬ。新しい報告が未だ検められておらねば、古い是では閉じぬ。
 *
 * 正本は使い捨て（:memory: と mkdtemp の file）。本物の ~/.honden/honden.db には触れぬ。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport, submitQc, cmdDone, coverageOf, listPendingReviews } from '../src/report';
import { runCmdShow } from '../src/main';

const CMD = {
  north_star: '差し戻しの後の出し直しが検められること',
  purpose: '再報告を台帳が数える',
  acceptance_criteria: ['試験が通ること', 'push しておらぬこと', '他の worktree に触れておらぬこと'],
  command: '実装せよ',
  project: 'honden',
};
const FULL = {
  1: 'bun test → 1500 pass / exit 0 を確かめた',
  2: 'git ls-remote で push しておらぬことを確かめた',
  3: '.worktrees 配下は git status で無変更',
};

function seeded(path = ':memory:') {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'm' },
      { id: 'karo', role: 'commander', cli: 'cursor', model: 'm' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'm' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'm' },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: 'm' },
    ]);
  });
  const c = createCmd(db, 'shogun', CMD);
  const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: c.id!, title: '実装せよ' });
  return { db, cmdId: c.id!, taskId: a.id! };
}
type DB = ReturnType<typeof openStore>;
const report = (db: DB, taskId: string, acceptance: unknown = FULL) => {
  const r = submitReport(db, 'ashigaru1', { task_id: taskId, status: 'done', summary: '実装した', acceptance });
  expect(r.ok, r.message).toBe(true);
  return r.id!;
};
const qc = (db: DB, reportId: number, verdict: string) =>
  submitQc(db, 'gunshi', { report_id: String(reportId), verdict, summary: `${verdict} と検めた` });

describe('差し戻しの後の出し直し', () => {
  test('(1) 報告 → 差し戻し → 同じ仕事で再報告 → APPROVED が受け付けられ、cmd show が数え、cmd done が迂回なしに閉じる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-qc-rereport-'));
    const path = join(dir, 'h.db');
    const { db, cmdId, taskId } = seeded(path);
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'CHANGES_REQUESTED').ok).toBe(true);
    // 差し戻しのままでは閉じぬ
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(false);
    const r2 = report(db, taskId);
    const q2 = qc(db, r2, 'APPROVED');
    expect(q2.ok, q2.message).toBe(true);
    const cov = coverageOf(db, cmdId);
    expect(cov.covered.size).toBe(3);
    expect([...cov.covered.values()].every((c) => c.reportId === r2)).toBe(true);
    expect(cov.passing.map((p) => p.id)).toEqual([q2.id!]);
    expect(cov.unreviewed).toEqual([]);
    const show = runCmdShow(path, cmdId).out ?? '';
    expect(show).toContain(`覆済 ← #${r2} ashigaru1`);
    expect(show).toContain(`検め: #${q2.id} APPROVED`);
    expect(show).not.toContain('まだ無い');
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok, d.message).toBe(true);
    expect(d.out).toContain('条件 3/3');
    expect(db.query("SELECT 1 FROM ledger WHERE action = 'cmd.done.bypass'").get()).toBeNull();
  });

  test('(1) 出し直した報告は、cmd show・status の検め待ちに出る（差し戻しの跡に埋もれぬ）', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'CHANGES_REQUESTED').ok).toBe(true);
    expect(coverageOf(db, cmdId).unreviewed).toEqual([]);
    const r2 = report(db, taskId);
    expect(coverageOf(db, cmdId).unreviewed.map((u) => u.id)).toEqual([r2]);
    expect(listPendingReviews(db).map((p) => p.id)).toEqual([r2]);
  });

  test('(2) 同じ報告への二度目の検めは止まる。古い報告を検め直すのも止まる', () => {
    const { db, taskId } = seeded();
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'CHANGES_REQUESTED').ok).toBe(true);
    const again = qc(db, r1, 'APPROVED');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('既に検めてある');
    const r2 = report(db, taskId);
    // 既に検めた古い報告は、今どおり『既に検めてある』
    expect(qc(db, r1, 'APPROVED').message).toContain('既に検めてある');
    // 検められぬまま差し替わった報告は検めぬ——門は最新の報告だけを見るゆえ、判定が宙に浮く
    const r3 = report(db, taskId);
    const stale = qc(db, r2, 'APPROVED');
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain(`最新は #${r3}`);
    expect(qc(db, r3, 'APPROVED').ok).toBe(true);
    const twice = qc(db, r3, 'REJECTED');
    expect(twice.ok).toBe(false);
    expect(twice.message).toContain('既に検めてある');
    // 書き込みは増えておらぬ（検めの行は二つだけ）
    expect((db.query('SELECT count(*) n FROM report WHERE verdict IS NOT NULL').get() as { n: number }).n).toBe(2);
  });

  test('(3) 再報告がまだ検められておらぬ時、古い報告への APPROVED があっても閉じられぬ（fail-closed）', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'APPROVED').ok).toBe(true);
    const r2 = report(db, taskId);
    const cov = coverageOf(db, cmdId);
    expect(cov.covered.size).toBe(0);
    expect(cov.passing).toEqual([]);
    expect(cov.unreviewed.map((u) => u.id)).toEqual([r2]);
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain(`#${r2}`);
    // 新しい報告が検められれば閉じられる
    expect(qc(db, r2, 'APPROVED').ok).toBe(true);
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(true);
  });

  test('(3) 新しい報告が差し戻されれば、古い報告の APPROVED では閉じぬ', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'APPROVED').ok).toBe(true);
    const r2 = report(db, taskId);
    expect(qc(db, r2, 'CHANGES_REQUESTED').ok).toBe(true);
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(false);
    expect(coverageOf(db, cmdId).rejected.length).toBeGreaterThan(0);
  });

  test('(4) 二周: 再報告を再び差し戻した後、さらに出し直して APPROVED で閉じられる', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId);
    expect(qc(db, r1, 'CHANGES_REQUESTED').ok).toBe(true);
    const r2 = report(db, taskId);
    expect(qc(db, r2, 'CHANGES_REQUESTED').ok).toBe(true);
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(false);
    const r3 = report(db, taskId);
    expect(coverageOf(db, cmdId).unreviewed.map((u) => u.id)).toEqual([r3]);
    expect(qc(db, r3, 'APPROVED').ok).toBe(true);
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok, d.message).toBe(true);
    // 差し戻しの跡は台帳に残っておる
    expect((db.query("SELECT count(*) n FROM report WHERE verdict = 'CHANGES_REQUESTED'").get() as { n: number }).n).toBe(2);
  });

  test('(5) 差し戻しの無い今までの流れは今どおり（報告 → APPROVED → 閉じる、未達なら閉じぬ）', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId, { 1: 'bun test → 1500 pass / exit 0 を確かめた' });
    expect(qc(db, r1, 'APPROVED').ok).toBe(true);
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('覆われておらぬ条件が 2 件');
    const s = seeded();
    const r = report(s.db, s.taskId);
    expect(qc(s.db, r, 'APPROVED').ok).toBe(true);
    expect(cmdDone(s.db, 'karo', { cmd_id: s.cmdId }).ok).toBe(true);
  });

  test('覆いの回: 差し戻しの前の証拠は数えず、差し戻しの後の補いの報告は数える', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId); // 全条件の証拠を出したが差し戻される
    expect(qc(db, r1, 'CHANGES_REQUESTED').ok).toBe(true);
    const r2 = report(db, taskId, { 1: 'bun test → 1500 pass / exit 0 を確かめた' }); // 条件 1 だけの出し直し
    expect(qc(db, r2, 'APPROVED').ok).toBe(true);
    // 差し戻された r1 の証拠（条件 2・3）は数えぬ
    expect([...coverageOf(db, cmdId).covered.keys()]).toEqual([1]);
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(false);
    // 補い: 差し戻しの無い回で、足りぬ条件だけを足した報告は同じ回として数える
    const s = seeded();
    const a = report(s.db, s.taskId, { 1: 'bun test → 1500 pass / exit 0 を確かめた', 2: 'git ls-remote で push しておらぬことを確かめた' });
    const b = report(s.db, s.taskId, { 3: '.worktrees 配下は git status で無変更' });
    expect(qc(s.db, b, 'APPROVED').ok).toBe(true);
    const cov = coverageOf(s.db, s.cmdId);
    expect([...cov.covered.keys()].sort()).toEqual([1, 2, 3]);
    expect(cov.covered.get(1)!.reportId).toBe(a);
    expect(cmdDone(s.db, 'karo', { cmd_id: s.cmdId }).ok).toBe(true);
  });

  test('既にある行: raw に report_id の無い検めの行（旧い写し）も、その前の最も新しい報告への検めとして数える', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = report(db, taskId);
    // submitQc を通さず、report_id を持たぬ検めの行を直に入れる（既存の正本に在りうる形）
    db.prepare(
      'INSERT INTO report(agent, task_id, created_at, verdict, cmd_id, raw) VALUES (?,?,?,?,?,?)',
    ).run('gunshi', taskId, new Date().toISOString(), 'APPROVED', cmdId, JSON.stringify({ verdict: 'APPROVED', summary: '旧い形' }));
    const cov = coverageOf(db, cmdId);
    expect(cov.covered.size).toBe(3);
    expect([...cov.covered.values()].every((c) => c.reportId === r1)).toBe(true);
    // その報告は検め済みとして数え、二度は検めぬ
    expect(qc(db, r1, 'REJECTED').message).toContain('既に検めてある');
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(true);
  });
});
