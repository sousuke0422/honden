/**
 * 外部レビューが見つけた欠陥の回帰試験（2026-08-26）。
 *
 * 元の probe は `console.log` で観測しておって `expect` が無く、**落ちようが
 * なかった**。集めるだけで判定に使わぬ型が、それを戒めるための道具に出ていた。
 * 正しい振る舞いを主張する形へ書き直す。直るまでは赤で、それが残りの仕事になる。
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport, submitQc, cmdDone } from '../src/report';
import { plan, record, markSince, startClocks, LEVEL_3_AFTER_MS, REPEAT_MS, ATTENDED_SILENT } from '../src/nudge';
import { setMode } from '../src/mode';
import { take, live as liveClaims, release as releaseClaim } from '../src/claim';
import { release as releaseLease, renew as renewLease } from '../src/lease';
import { ingestTask } from '../src/ingest';
import { inboxWrite } from '../src/cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportCollision } from '../src/peer';
import type { Pane } from '../src/pane';

const CRIT = ['試験が通ること', 'push しておらぬこと'];
const EV = { 1: 'bun test 349 pass / exit 0', 2: 'git log origin/main..HEAD が 0 件' };

function seeded() {
  const db = openStore({ path: ':memory:' });
  tx(db, () =>
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
      { id: 'ashigaru2', role: 'worker', cli: 'copilot', model: null },
    ]),
  );
  const c = createCmd(db, 'shogun', {
    north_star: 'x',
    purpose: 'y',
    acceptance_criteria: CRIT,
    command: 'z',
    project: 'p',
  });
  return { db, cmdId: c.id! };
}

describe('門の実効性', () => {
  test('却下された報告の証拠は覆いに数えぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '本体' });
    const r1 = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: '全部', acceptance: EV });
    submitQc(db, 'gunshi', { report_id: r1.id, verdict: 'REJECTED', summary: '実測が再現せぬ' });

    const b = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '些末' });
    const r2 = submitReport(db, 'ashigaru2', {
      task_id: b.id!,
      status: 'done',
      summary: '一部だけ',
      acceptance: { 1: '別環境で bun test を実行し確認した' },
    });
    submitQc(db, 'gunshi', { report_id: r2.id, verdict: 'APPROVED', summary: '条件1のみ妥当' });

    const d = cmdDone(db, 'karo', { cmd_id: cmdId });
    expect(d.ok).toBe(false);
    // なぜ数えられぬかが分かること
    expect(d.message).toContain('REJECTED');
  });

  test('checks を対応で書いても FAIL の門は効く', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '本体' });
    const r = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: 'x', acceptance: EV });
    const q = submitQc(db, 'gunshi', {
      report_id: r.id,
      verdict: 'APPROVED',
      summary: '検めた',
      checks: { lint: 'FAIL', test: 'FAIL' },
    });
    expect(q.ok).toBe(false);
    expect(q.message).toContain('FAIL');
  });

  test('checks を対応で書いた時も跡が残る', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '本体' });
    const r = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: 'x', acceptance: EV });
    submitQc(db, 'gunshi', {
      report_id: r.id,
      verdict: 'CHANGES_REQUESTED',
      summary: '直されよ',
      checks: { lint: 'FAIL', test: 'PASS' },
    });
    expect((db.query('SELECT count(*) c FROM report_check').get() as { c: number }).c).toBe(2);
  });

  test('知らぬ形の checks は断る', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '本体' });
    const r = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: 'x', acceptance: EV });
    const q = submitQc(db, 'gunshi', { report_id: r.id, verdict: 'APPROVED', summary: 'x', checks: '全部通った' });
    expect(q.ok).toBe(false);
  });

  test('軍師も自分の仕事を自分で是とはできぬ', () => {
    const { db, cmdId } = seeded();
    const g = assignTask(db, 'karo', { agent: 'gunshi', cmd_id: cmdId, title: '軍師の調査' });
    const r = submitReport(db, 'gunshi', { task_id: g.id!, status: 'done', summary: '調べた', acceptance: EV });
    const q = submitQc(db, 'gunshi', { report_id: r.id, verdict: 'APPROVED', summary: '自分で検めた' });
    expect(q.ok).toBe(false);
    expect(q.message).toContain('検めの意味');
  });
});

describe('貸与の寿命', () => {
  const expire = (db: ReturnType<typeof openStore>, agent: string) =>
    db.run('UPDATE task SET lease_until = ? WHERE agent = ?', [new Date(Date.now() - 60_000).toISOString(), agent]);

  test('期限が切れても、働いておる者を黙って上書きせぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '長い仕事' });
    expire(db, 'ashigaru1');
    const b = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '別の仕事' });
    expect(b.ok).toBe(false);
    // 何が起きておるか・どうすればよいかが分かること
    expect(b.message).toContain('期限');
    // 旧い仕事の報告が今も出せること
    const r = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: '納めた', acceptance: EV });
    expect(r.ok).toBe(true);
  });

  test('納めたら貸与が解け、次を振れる', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: '納めた', acceptance: EV });
    const row = db.query("SELECT holder, status FROM task WHERE agent = 'ashigaru1'").get() as {
      holder: string | null;
      status: string;
    };
    expect(row.holder).toBeNull();
    expect(assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '次' }).ok).toBe(true);
  });

  test('blocked では握ったまま。まだ仕掛かっておる', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'blocked', summary: '塞がれた' });
    const row = db.query("SELECT holder FROM task WHERE agent = 'ashigaru1'").get() as { holder: string | null };
    expect(row.holder).toBe('ashigaru1');
  });
});

describe('合図が守るべき相手を壊さぬ', () => {
  const PANES = new Map<string, Pane>([
    ['shogun', { id: '%0', label: 'shogun:main.0' }],
    ['ashigaru2', { id: '%5', label: 'multiagent:agents.2' }],
  ]);
  const T0 = new Date('2026-08-26T10:00:00Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const unread = (db: ReturnType<typeof openStore>, agent: string) =>
    db.prepare('INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)').run(
      `m_${agent}_${Math.random()}`,
      agent,
      T0.toISOString(),
      'report_received',
      'karo',
      'x',
    );

  test('文脈消しの冷まし中に連射せぬ', () => {
    const { db } = seeded();
    unread(db, 'ashigaru2');
    markSince(db, 'ashigaru2', T0);
    const first = plan(db, at(LEVEL_3_AFTER_MS), { panes: PANES }).find((p) => p.agent === 'ashigaru2')!;
    expect(first.level).toBe(3);
    record(db, first, at(LEVEL_3_AFTER_MS));

    // 5 秒後。冷ましの中ゆえ段 2 へ落ちるが、撃ち直しの間も効いていること
    const soon = plan(db, at(LEVEL_3_AFTER_MS + 5_000), { panes: PANES }).find((p) => p.agent === 'ashigaru2')!;
    expect(soon.send).toBe(false);

    // 撃ち直しの間を過ぎれば撃つ
    const later = plan(db, at(LEVEL_3_AFTER_MS + REPEAT_MS + 5_000), { panes: PANES }).find(
      (p) => p.agent === 'ashigaru2',
    )!;
    expect(later.send).toBe(true);
    expect(later.level).toBe(2);

    // ここが本題。降格した段 2 を記録した後、次の回は elapsed から段 3 が出て
    // 「段が上がった」と判ぜられ、撃ち直しの間を素通りする筋があった。
    record(db, later, at(LEVEL_3_AFTER_MS + REPEAT_MS + 5_000));
    const again = plan(db, at(LEVEL_3_AFTER_MS + REPEAT_MS + 10_000), { panes: PANES }).find(
      (p) => p.agent === 'ashigaru2',
    )!;
    expect(again.send).toBe(false);
  });

  test('様態を切り替えた初弾が、いきなり文脈消しにならぬ', () => {
    const { db } = seeded();
    unread(db, ATTENDED_SILENT);

    // 在席の間、芯は何度も手を呼ぶ。そのたび時計を進めるかどうかが分かれ目。
    for (let m = 0; m <= 30; m += 5) startClocks(db, at(m * 60_000));
    const t = at(30 * 60_000);
    expect(plan(db, t, { panes: PANES }).find((p) => p.agent === ATTENDED_SILENT)!.send).toBe(false);

    // 殿が席を外される
    setMode(db, 'shogun', 'autonomous', { until: '6h', now: t });
    startClocks(db, t);
    const first = plan(db, t, { panes: PANES }).find((p) => p.agent === ATTENDED_SILENT)!;
    expect(first.send).toBe(true);
    // 一度も撃っておらぬ相手への初弾が /clear では、開始と同時に文脈が焼ける
    expect(first.level).toBe(1);
  });
});

describe('影と実運用が同じ行を取り合わぬ', () => {
  test('honden で振った持ち場を、取り込みが潰さぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: 'honden の仕事' });
    // shogun 側 YAML の取り込み（実の経路を通す）
    const n = ingestTask(
      db,
      '/q/tasks/ashigaru1.yaml',
      { worker_id: 'ashigaru1', task_id: 'subtask_999_001', status: 'assigned', parent_cmd: 'cmd_999' },
      '{}',
    );
    expect(n).toBe(0); // 生きた持ち主が居る行には触れぬ
    // 潰されておれば報告が出せなくなる
    const r = submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'done', summary: '納めた', acceptance: EV });
    expect(r.ok).toBe(true);
  });
});

describe('衝突の報せ', () => {
  test('時を経れば再び報せる', () => {
    const { db } = seeded();
    const now = new Date('2026-08-26T10:00:00Z');
    take(db, { kind: 'branch', value: 'fix32', agent: 'ashigaru1', taskId: 't1', now });
    expect(reportCollision(db, { from: 'ashigaru2', with: 'ashigaru1', key: 't1', detail: 'x', now })).toBe(true);
    // 直後は抑える
    expect(reportCollision(db, { from: 'ashigaru2', with: 'ashigaru1', key: 't1', detail: 'x', now })).toBe(false);
    // 7 日後にまだ塞がっておるなら、改めて報せる
    const later = new Date(now.getTime() + 7 * 24 * 3_600_000);
    expect(reportCollision(db, { from: 'ashigaru2', with: 'ashigaru1', key: 't1', detail: 'x', now: later })).toBe(
      true,
    );
  });
});

describe('散文のままだった禁止を構造へ', () => {
  test('足軽は他人の取り置きを解けぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/x' });
    const id = liveClaims(db)[0]!.id;
    const r = releaseClaim(db, {
      id,
      by: 'ashigaru2',
      force: true,
      reason: 'ashigaru1 の pane が落ちて 1 時間',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('家老へ回されよ');
  });

  test('足軽は他人の持ち場を解けぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    const r = releaseLease(db, {
      agent: 'ashigaru1',
      holder: 'ashigaru2',
      force: true,
      reason: 'ashigaru1 の pane が落ちて 1 時間',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('家老へ回されよ');
  });

  test('上役なら解ける', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/x' });
    expect(
      releaseClaim(db, {
        id: liveClaims(db)[0]!.id,
        by: 'karo',
        force: true,
        reason: 'ashigaru1 の pane が落ちて 1 時間',
      }).ok,
    ).toBe(true);
  });

  test('明示で起こした跡に、誰が起こしたかが残る', () => {
    const { db } = seeded();
    db.prepare('INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)').run(
      'm1',
      ATTENDED_SILENT,
      new Date().toISOString(),
      'report_received',
      'karo',
      'x',
    );
    const now = new Date();
    markSince(db, ATTENDED_SILENT, now);
    const p = plan(db, now, {
      wakeShogun: true,
      panes: new Map([[ATTENDED_SILENT, { id: '%0', label: 'shogun:main.0' }]]),
    }).find((x) => x.agent === ATTENDED_SILENT)!;
    expect(p.byExplicitWake).toBe(true);
    record(db, p, now, '殿の明示', 'karo');
    const led = db.query("SELECT actor FROM ledger WHERE action = 'nudge.wake_shogun'").all() as {
      actor: string;
    }[];
    expect(led[0]!.actor).toBe('karo');
  });
});

describe('期限切れの引き継ぎ', () => {
  test('理由なしの引き継ぎは通らぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '長い仕事' });
    db.run('UPDATE task SET lease_until = ? WHERE agent = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      'ashigaru1',
    ]);
    expect(assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '次', takeover: 'true' }).ok).toBe(
      false,
    );
  });

  test('理由を添えれば引き継げ、跡に旧い仕事が残る', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '長い仕事' });
    db.run('UPDATE task SET lease_until = ? WHERE agent = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      'ashigaru1',
    ]);
    const b = assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: '次',
      takeover: 'true',
      reason: 'ashigaru1 の pane が落ちて 1 時間、応答が無い',
    });
    expect(b.ok).toBe(true);
    const led = db.query("SELECT detail FROM ledger WHERE action = 'task.assign.takeover'").all() as {
      detail: string;
    }[];
    expect(led.length).toBe(1);
    expect(led[0]!.detail).toContain(a.id!);
  });
});

describe('案内した道が実在すること', () => {
  test('当人は貸与を延ばせる', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '長い仕事' });
    const before = (db.query("SELECT lease_until u FROM task WHERE agent='ashigaru1'").get() as { u: string }).u;
    const r = renewLease(db, { agent: 'ashigaru1', holder: 'ashigaru1', minutes: 120 });
    expect(r.ok).toBe(true);
    const after = (db.query("SELECT lease_until u FROM task WHERE agent='ashigaru1'").get() as { u: string }).u;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  test('他人は延ばせぬ。まだ働いておる証にならぬゆえ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    expect(renewLease(db, { agent: 'ashigaru1', holder: 'ashigaru2' }).ok).toBe(false);
  });

  test('貸与の長さに数でない値を渡しても投げぬ', () => {
    const { db, cmdId } = seeded();
    const r = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', minutes: 'いっぱい' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('正の数');
  });
});

describe('指揮系統を宛先の検めへ（F001）', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'honden-route-'));
  function withDb() {
    const path = join(dir(), 'h.db');
    const db = openStore({ path });
    tx(db, () =>
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
        { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
        { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
        { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
      ]),
    );
    return { db, path };
  }
  const write = (path: string, from: string, to: string, type = 'report_received') =>
    inboxWrite(path, { flags: { to, from, type, body: '用件' } }, false, {
      insideFormation: true,
      selfId: from,
    });

  test('足軽は将軍へ直に報せられぬ', () => {
    const { path } = withDb();
    const r = write(path, 'ashigaru1', 'shogun');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('F001');
    expect(r.err).toContain('report submit');
  });

  test('足軽から足軽へは直に送れぬ', () => {
    const { path } = withDb();
    const r = write(path, 'ashigaru1', 'ashigaru2');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('家老の役目');
    expect(r.err).toContain('peek');
  });

  test('足軽は clear_command を撃てぬ', () => {
    const { path } = withDb();
    const r = write(path, 'ashigaru1', 'ashigaru2', 'clear_command');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('文脈が消える');
  });

  test('足軽から軍師への報せは通る。それが常道ゆえ', () => {
    const { path } = withDb();
    expect(write(path, 'ashigaru1', 'gunshi').code).toBe(0);
  });

  test('足軽から家老への報せも通る', () => {
    const { path } = withDb();
    expect(write(path, 'ashigaru1', 'karo').code).toBe(0);
  });

  test('家老は clear_command を撃てる', () => {
    const { path } = withDb();
    expect(write(path, 'karo', 'ashigaru1', 'clear_command').code).toBe(0);
  });

  test('布陣の外からの差出人は、この検めで縛らぬ', () => {
    // review_session のような外の名は名簿に無い。指揮系統の中に居らぬので
    // 上下を当てはめようがなく、外からの守りは別に在る
    // （役職を騙れぬ・clear_command を撃てぬ）。
    const { path } = withDb();
    const r = inboxWrite(
      path,
      { flags: { to: 'shogun', from: 'review_session', type: 'report_received', body: '外からの報せ' } },
      false,
      { insideFormation: false, selfId: undefined },
    );
    expect(r.code).toBe(0);
  });

  test('将軍から足軽へは通る（指揮系統は下りゆえ）', () => {
    const { path } = withDb();
    expect(write(path, 'shogun', 'ashigaru1', 'cmd_new').code).toBe(0);
  });
});
