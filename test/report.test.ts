/**
 * 報告路と受け入れ条件の門の試験。
 *
 * 中心は 4 つ。
 *
 *   1. 路が現行のままであること（足軽 → 軍師 → 家老。将軍の inbox は鳴らさぬ）
 *   2. 「済」だけの証拠を通さぬこと（形だけの通過で門が開く筋）
 *   3. FAIL を抱えたまま APPROVED にできぬこと（集めただけで判定に使わぬ癖）
 *   4. 条件が一つでも未達なら閉じられぬこと（現行 karo.md の散文を門にした所）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import {
  submitReport,
  submitQc,
  cmdDone,
  coverageOf,
  checkEvidence,
  normalizeAcceptance,
  WORKER_REPORTS_TO,
  CMD_CLOSER,
} from '../src/report';

const CMD = {
  north_star: '受け入れ条件が散文のままでは守られたか分からぬ',
  purpose: '条件ごとの証拠を型で要求する',
  acceptance_criteria: ['試験が通ること', 'push しておらぬこと', '他の worktree に触れておらぬこと'],
  command: '実装せよ',
  project: 'honden',
};

/** 司令 1 件と、足軽 1 人へ振った状態まで作る。 */
function seeded() {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'claude-opus-5' },
      { id: 'karo', role: 'commander', cli: 'cursor', model: 'auto' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'claude-sonnet-5' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'claude-fable-5' },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: 'claude-fable-5' },
    ]);
  });
  const c = createCmd(db, 'shogun', CMD);
  const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: c.id!, title: '実装せよ' });
  return { db, cmdId: c.id!, taskId: a.id! };
}

const FULL = {
  1: 'cargo test -p job -p service → job 18 / service 195 / exit 0',
  2: 'git log origin/main..HEAD で push しておらぬことを確認',
  3: '.worktrees 配下は git status で無変更',
};

const unread = (db: ReturnType<typeof openStore>, agent: string) =>
  (db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(agent) as { c: number }).c;

describe('報告の路', () => {
  test('足軽が納めると、軍師の未読が増える（宛先は選べぬ）', () => {
    const { db, taskId } = seeded();
    const before = unread(db, WORKER_REPORTS_TO);
    const r = submitReport(db, 'ashigaru1', {
      task_id: taskId,
      status: 'done',
      summary: '実装した',
      acceptance: FULL,
    });
    expect(r.ok).toBe(true);
    expect(unread(db, WORKER_REPORTS_TO)).toBe(before + 1);
    // 将軍へは行かない。現行 karo.md の to_shogun: false と同じ扱い。
    expect(unread(db, 'shogun')).toBe(0);
  });

  test('報告を書くのと軍師を起こすのが 1 つの取引になっておる', () => {
    const { db, taskId } = seeded();
    submitReport(db, 'ashigaru1', { task_id: taskId, status: 'done', summary: '実装した', acceptance: FULL });
    const reports = (db.query('SELECT count(*) c FROM report').get() as { c: number }).c;
    expect(reports).toBe(1);
    expect(unread(db, WORKER_REPORTS_TO)).toBe(1);
  });

  test('他人の仕事の報告は書けぬ（自分も仕事を握っておる場合）', () => {
    // ここが肝要。ashigaru2 に何も振られていないと、手前の
    // 「振られておらぬ」門で止まってしまい、番号の照合そのものが試されない。
    // 実際にすり替えが起きうるのは、双方が仕事を持っている時である。
    const { db, cmdId, taskId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '別の持ち場' });
    const r = submitReport(db, 'ashigaru2', { task_id: taskId, status: 'done', summary: 'やった', acceptance: FULL });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('他の者の仕事の報告は書けぬ');
    expect((db.query('SELECT count(*) c FROM report').get() as { c: number }).c).toBe(0);
  });

  test('振られておらぬのに報告はできぬ', () => {
    const { db } = seeded();
    const r = submitReport(db, 'ashigaru2', { task_id: 'subtask_x', status: 'done', summary: 'やった' });
    expect(r.ok).toBe(false);
  });

  test('家老は報告を上げぬ（dashboard を通す）', () => {
    const { db, taskId } = seeded();
    const r = submitReport(db, 'karo', { task_id: taskId, status: 'done', summary: 'やった' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('上役');
  });

  test('名乗りが無ければ書かせぬ', () => {
    const { db, taskId } = seeded();
    const r = submitReport(db, undefined, { task_id: taskId, status: 'done', summary: 'やった' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('確かめられぬ');
  });
});

describe('証拠の検め', () => {
  test('「済」だけでは通らぬ', () => {
    for (const s of ['済', 'OK', 'done', '〇', '✓']) {
      expect(checkEvidence(1, '試験が通ること', s)).toContain('証にならぬ');
    }
  });

  test('空も短すぎるものも通らぬ', () => {
    expect(checkEvidence(1, 'x', '')).toContain('空');
    expect(checkEvidence(1, 'x', 'あい')).toContain('短すぎる');
  });

  test('実際の証拠は通る', () => {
    expect(checkEvidence(1, 'x', 'cargo test → 195 passed / exit 0')).toBeNull();
  });

  test('done を名乗るなら条件を一つは覆うこと', () => {
    const { db, taskId } = seeded();
    const r = submitReport(db, 'ashigaru1', { task_id: taskId, status: 'done', summary: 'やった' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('証拠つきで挙げられよ');
    // 条件の文言を出して、何を書けばよいか分かるようにする
    expect(r.message).toContain('試験が通ること');
  });

  test('blocked は覆う義務を負わぬ', () => {
    const { db, taskId } = seeded();
    const r = submitReport(db, 'ashigaru1', {
      task_id: taskId,
      status: 'blocked',
      summary: '依存が揃わず着手できぬ',
    });
    expect(r.ok).toBe(true);
  });

  test('無い番号の条件は弾く', () => {
    const { db, taskId } = seeded();
    const r = submitReport(db, 'ashigaru1', {
      task_id: taskId,
      status: 'done',
      summary: 'やった',
      acceptance: { 9: 'cargo test → 195 passed' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('条件 9 は無い');
  });

  test('並びでも番号でも同じ形へ落ちる', () => {
    const crit = [
      { idx: 1, text: 'a' },
      { idx: 2, text: 'b' },
    ];
    const byList = normalizeAcceptance(['証拠その一である', '証拠その二である'], crit);
    const byMap = normalizeAcceptance({ 1: '証拠その一である', 2: '証拠その二である' }, crit);
    expect(byList.ok && byMap.ok).toBe(true);
    if (byList.ok && byMap.ok) expect([...byList.map]).toEqual([...byMap.map]);
  });

  test('並びが条件より多ければ弾く', () => {
    const r = normalizeAcceptance(['あああああああ', 'いいいいいいい'], [{ idx: 1, text: 'a' }]);
    expect(r.ok).toBe(false);
  });
});

describe('軍師の検め', () => {
  const upto = () => {
    const s = seeded();
    const r = submitReport(s.db, 'ashigaru1', {
      task_id: s.taskId,
      status: 'done',
      summary: '実装した',
      acceptance: FULL,
    });
    return { ...s, reportId: r.id! };
  };

  test('報告の番号は数でも文字列でも通る（YAML と旗の差）', () => {
    const { db, reportId } = upto();
    // YAML の `report_id: 1` は数、旗の --report_id 1 は文字列で入る。
    const q = submitQc(db, 'gunshi', { report_id: reportId, verdict: 'APPROVED', summary: '数で渡した' });
    expect(q.ok).toBe(true);
  });

  test('番号が数でなければ弾く', () => {
    const { db } = upto();
    const q = submitQc(db, 'gunshi', { report_id: 'あ', verdict: 'APPROVED', summary: '検めた' });
    expect(q.ok).toBe(false);
    expect(q.message).toContain('数でない');
  });

  test('検めると家老の未読が増える', () => {
    const { db, reportId } = upto();
    const before = unread(db, CMD_CLOSER);
    const q = submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '独立再現した' });
    expect(q.ok).toBe(true);
    expect(unread(db, CMD_CLOSER)).toBe(before + 1);
  });

  test('足軽が自分の仕事を自分で是とはできぬ', () => {
    const { db, reportId } = upto();
    const q = submitQc(db, 'ashigaru1', { report_id: String(reportId), verdict: 'APPROVED', summary: '通った' });
    expect(q.ok).toBe(false);
    expect(q.message).toContain('gunshi');
  });

  test('FAIL を抱えたまま APPROVED にはできぬ', () => {
    const { db, reportId } = upto();
    const q = submitQc(db, 'gunshi', {
      report_id: String(reportId),
      verdict: 'APPROVED',
      summary: '検めた',
      checks: [
        { name: '試験の独立再現', result: 'PASS' },
        { name: '陽性対照', result: 'FAIL', note: '旧コードでも落ちぬ' },
      ],
    });
    expect(q.ok).toBe(false);
    expect(q.message).toContain('陽性対照');
    expect(q.message).toContain('判定へ結ばぬ');
  });

  test('同じ仕事を二度は検めぬ', () => {
    const { db, reportId } = upto();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    const again = submitQc(db, 'gunshi', {
      report_id: String(reportId),
      verdict: 'REJECTED',
      summary: 'やはり駄目',
    });
    expect(again.ok).toBe(false);
    expect(again.message).toContain('既に検めてある');
  });

  test('検めを検めることはできぬ', () => {
    const { db, reportId } = upto();
    const q = submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    const meta = submitQc(db, 'gunshi', { report_id: String(q.id), verdict: 'APPROVED', summary: '検めを検める' });
    expect(meta.ok).toBe(false);
  });
});

describe('受け入れ条件の門', () => {
  const ready = (acceptance: unknown = FULL) => {
    const s = seeded();
    const r = submitReport(s.db, 'ashigaru1', {
      task_id: s.taskId,
      status: 'done',
      summary: '実装した',
      acceptance,
    });
    return { ...s, reportId: r.id };
  };

  test('検めが無ければ閉じられぬ', () => {
    const { db, cmdId } = ready();
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('gunshi の是が無い');
    expect(d.message).toContain('検めを待っておる報告');
  });

  test('条件が一つでも未達なら閉じられぬ', () => {
    const { db, cmdId, reportId } = ready({ 1: 'cargo test → 195 passed / exit 0' });
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('覆われておらぬ条件が 2 件');
    expect(d.message).toContain('push しておらぬこと');
  });

  test('全条件が覆われ、軍師が是と言えば閉じられる', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(true);
    const row = db.query('SELECT status FROM cmd WHERE id = ?').get(cmdId) as { status: string };
    expect(row.status).toBe('done');
  });

  test('懸念つきの是でも通る', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', {
      report_id: String(reportId),
      verdict: 'APPROVED_WITH_CONCERNS',
      summary: '通るが懸念あり',
    });
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(true);
  });

  test('CHANGES_REQUESTED では通らぬ', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'CHANGES_REQUESTED', summary: '直されよ' });
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(false);
  });

  test('閉じられるのは家老だけ', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    const d = cmdDone(db, 'gunshi', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('karo');
  });

  test('迂回できるのは将軍だけ・理由が要る・跡が残る', () => {
    const { db, cmdId, reportId } = ready({ 1: 'cargo test → 195 passed / exit 0' });
    // 条件 1 は検めを通しておく。覆いは是と検められた報告からのみ数えるゆえ、
    // 検めを通さぬと未達が 3 件になり、この試験が見たい「一部だけ未達」にならぬ。
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '条件1は良い' });

    // 家老は迂回できない
    expect(cmdDone(db, 'karo', { cmd_id: cmdId, bypass: 'true', reason: '案件が取り止めになった' }).ok).toBe(false);
    // 理由なしは通らない
    expect(cmdDone(db, 'shogun', { cmd_id: cmdId, bypass: 'true' }).ok).toBe(false);

    const d = cmdDone(db, 'shogun', {
      cmd_id: cmdId,
      bypass: 'true',
      reason: '案件そのものが取り止めになり、残りの条件が意味を失った',
    });
    expect(d.ok).toBe(true);

    const led = db
      .query("SELECT action, detail FROM ledger WHERE action = 'cmd.done.bypass'")
      .all() as { action: string; detail: string }[];
    expect(led.length).toBe(1);
    // 何が未達のまま閉じたのかが後から分かること
    expect(led[0]!.detail).toContain('未達=[2,3]');
    expect(led[0]!.detail).toContain('取り止め');
  });

  test('二度は閉じられぬ', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).message).toContain('既に done である');
  });

  test('閉じても将軍の inbox は鳴らさぬ', () => {
    const { db, cmdId, reportId } = ready();
    submitQc(db, 'gunshi', { report_id: String(reportId), verdict: 'APPROVED', summary: '検めた' });
    cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(unread(db, 'shogun')).toBe(0);
  });

  test('複数の足軽が分けて覆っても数え上げる', () => {
    const { db, cmdId, taskId } = seeded();
    const r1 = submitReport(db, 'ashigaru1', {
      task_id: taskId,
      status: 'done',
      summary: '試験まで',
      acceptance: { 1: FULL[1] },
    });
    const a2 = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '残り' });
    const r2 = submitReport(db, 'ashigaru2', {
      task_id: a2.id!,
      status: 'done',
      summary: '残り',
      acceptance: { 2: FULL[2], 3: FULL[3] },
    });
    submitQc(db, 'gunshi', { report_id: String(r1.id), verdict: 'APPROVED', summary: '検めた' });
    submitQc(db, 'gunshi', { report_id: String(r2.id), verdict: 'APPROVED', summary: '検めた' });

    const cov = coverageOf(db, cmdId);
    expect(cov.uncovered.length).toBe(0);
    expect(cov.covered.get(1)!.agent).toBe('ashigaru1');
    expect(cov.covered.get(3)!.agent).toBe('ashigaru2');
    expect(cmdDone(db, 'karo', { cmd_id: cmdId }).ok).toBe(true);
  });

  test('残りは司令ぜんたいで数える（他の者が覆った分を残りに出さぬ）', () => {
    const { db, cmdId, taskId } = seeded();
    submitReport(db, 'ashigaru1', { task_id: taskId, status: 'done', summary: 'その一', acceptance: { 1: FULL[1] } });
    const a2 = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '残り' });
    const r2 = submitReport(db, 'ashigaru2', {
      task_id: a2.id!,
      status: 'done',
      summary: 'その二',
      acceptance: { 2: FULL[2] },
    });
    expect(r2.ok).toBe(true);
    // 条件 1 は足軽1が既に覆っておる。残りに出してはならぬ。
    expect(r2.out).not.toContain('1. 試験が通ること');
    expect(r2.out).toContain('3. 他の worktree に触れておらぬこと');
    expect(r2.out).toContain('2 / 3 件');
  });

  test('blocked の報告は覆いに数えぬ', () => {
    const { db, cmdId, taskId } = seeded();
    // blocked なのに証拠だけ並べても、覆ったことにはならない
    submitReport(db, 'ashigaru1', {
      task_id: taskId,
      status: 'blocked',
      summary: '塞がれた',
      acceptance: FULL,
    });
    expect(coverageOf(db, cmdId).uncovered.length).toBe(3);
  });
});
