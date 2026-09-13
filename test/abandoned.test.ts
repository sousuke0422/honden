/**
 * 見捨てられた司令の見つけの試験。
 *
 * 中心は 3 つ。
 *
 *   1. 実際に起きた形——振られ、持ち場が報告を経ずに空き、pending のまま
 *      報告ゼロ——が検知されること（陽性対照）
 *   2. 見捨てられておらぬ三つ——振られる前・閾値の内・いま握られておる——が
 *      検知されぬこと（陰性対照）
 *   3. 期限切れ（握ったまま）と取り違えぬこと
 */

import { expect, test, describe } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport } from '../src/report';
import { releaseAllOf } from '../src/claim';
import { release as leaseRelease, leaseState } from '../src/lease';
import { findAbandoned, notifyAbandoned, ABANDONED_AFTER_MS } from '../src/abandoned';
import { runCmdList } from '../src/main';

const CMD = {
  north_star: '振られた仕事が黙って消えると司令が永久に寝る',
  purpose: '見捨てられた司令を芯が見つける',
  acceptance_criteria: ['見捨てられた形が検知されること'],
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
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
    ]);
  });
  const c = createCmd(db, 'shogun', CMD);
  return { db, cmdId: c.id! };
}

/** 実際に起きた形を作る: 振る → 持ち場が報告を経ずに空く。 */
function abandon(db: ReturnType<typeof seeded>['db'], cmdId: string, agent = 'ashigaru1') {
  const a = assignTask(db, 'karo', { agent, cmd_id: cmdId, title: '任', workspace: `/w/.worktrees/${cmdId}` });
  expect(a.ok).toBe(true);
  // 報告は出さぬまま、貸与も取り置きも解ける（実件では次の差配や手仕舞いで空いた）
  expect(leaseRelease(db, { agent, holder: agent }).ok).toBe(true);
  expect(releaseAllOf(db, agent)).toBeGreaterThan(0);
}

/** 閾値を過ぎた刻。 */
const after = () => new Date(Date.now() + ABANDONED_AFTER_MS + 60_000);

describe('陽性対照——実際に起きた形', () => {
  test('振られ、報告を経ずに空き、pending のまま報告ゼロ → 検知される', () => {
    const { db, cmdId } = seeded();
    abandon(db, cmdId);
    const found = findAbandoned(db, after());
    expect(found.map((f) => f.cmdId)).toEqual([cmdId]);
    expect(found[0]!.agents).toContain('ashigaru1');
  });

  test('三件並んでも三件とも挙がる', () => {
    const { db, cmdId } = seeded();
    const c2 = createCmd(db, 'shogun', CMD).id!;
    const c3 = createCmd(db, 'shogun', CMD).id!;
    abandon(db, cmdId, 'ashigaru1');
    abandon(db, c2, 'ashigaru2');
    abandon(db, c3, 'ashigaru1');
    expect(findAbandoned(db, after()).map((f) => f.cmdId).sort()).toEqual([cmdId, c2, c3].sort());
  });
});

describe('陰性対照——見捨てられておらぬ三つ', () => {
  test('まだ誰にも振られておらぬ pending は挙がらぬ（差配待ちである）', () => {
    const { db } = seeded();
    expect(findAbandoned(db, after())).toEqual([]);
  });

  test('空いて間もなく、閾値の内に在るものは挙がらぬ', () => {
    const { db, cmdId } = seeded();
    abandon(db, cmdId);
    expect(findAbandoned(db, new Date())).toEqual([]);
  });

  test('いま誰かが握って働いておるものは、幾ら経とうと挙がらぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '任', workspace: '/w/.worktrees/x' });
    expect(a.ok).toBe(true);
    expect(findAbandoned(db, after())).toEqual([]);
  });

  test('報告が一つでも出ておれば挙がらぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '任', workspace: '/w/.worktrees/x' });
    expect(a.ok).toBe(true);
    const taskId = (db.query('SELECT task_id FROM task WHERE agent = ?').get('ashigaru1') as { task_id: string }).task_id;
    const r = submitReport(db, 'ashigaru1', { task_id: taskId, status: 'blocked', summary: '詰まった' });
    expect(r.ok).toBe(true);
    // blocked は握ったままだが、その後空いても「報告ゼロ」ではないゆえ挙がらぬ
    leaseRelease(db, { agent: 'ashigaru1', holder: 'ashigaru1' });
    releaseAllOf(db, 'ashigaru1');
    expect(findAbandoned(db, after())).toEqual([]);
  });
});

describe('期限切れとの区別', () => {
  test('握ったまま期限が切れたものは「期限切れ」であって「見捨てられ」ではない', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', {
      agent: 'ashigaru1', cmd_id: cmdId, title: '任', workspace: '/w/.worktrees/x', minutes: '1',
    });
    expect(a.ok).toBe(true);
    // 取り置きだけ解けても、貸与の holder が立っておる限り「握ったまま」である
    releaseAllOf(db, 'ashigaru1');
    const t = db.query('SELECT holder, lease_until FROM task WHERE agent = ?').get('ashigaru1') as {
      holder: string; lease_until: string;
    };
    const late = after();
    expect(leaseState({ holder: t.holder, leaseUntil: t.lease_until }, late)).toBe('expired');
    expect(findAbandoned(db, late)).toEqual([]);
  });
});

describe('家老への報せ', () => {
  test('見つけたら家老の受け箱へ届き、同じ見捨てに二度は鳴らさぬ', () => {
    const { db, cmdId } = seeded();
    abandon(db, cmdId);
    const sent = notifyAbandoned(db, after());
    expect(sent.map((s) => s.cmdId)).toEqual([cmdId]);
    const inbox = () =>
      db.query("SELECT id, agent, msg_type, body FROM inbox WHERE msg_type = 'cmd_abandoned'").all() as {
        id: string; agent: string; msg_type: string; body: string;
      }[];
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]!.agent).toBe('karo');
    expect(inbox()[0]!.body).toContain(cmdId);
    // 二度目の周回では鳴らさぬ
    expect(notifyAbandoned(db, after())).toEqual([]);
    expect(inbox()).toHaveLength(1);
  });

  test('振り直されて再び見捨てられれば、新しい跡として改めて鳴る', () => {
    const { db, cmdId } = seeded();
    abandon(db, cmdId, 'ashigaru1');
    expect(notifyAbandoned(db, after()).length).toBe(1);
    // 家老が振り直したが、また同じ形で空いた
    abandon(db, cmdId, 'ashigaru2');
    // 跡の刻が変わるまで待つ（claim の at は実時間ゆえ、後の跡は必ず新しい）
    const sent = notifyAbandoned(db, new Date(Date.now() + 2 * ABANDONED_AFTER_MS));
    expect(sent.map((s) => s.cmdId)).toEqual([cmdId]);
    expect(
      db.query("SELECT COUNT(*) n FROM inbox WHERE msg_type = 'cmd_abandoned'").get() as { n: number },
    ).toEqual({ n: 2 });
  });
});

describe('一覧への印', () => {
  test('cmd list に ⚠見捨てられ が立ち、他の司令には立たぬ', () => {
    const path = join(tmpdir(), `abandoned-list-${Date.now()}.db`);
    try {
      const { db, cmdId } = seeded(path);
      const other = createCmd(db, 'shogun', CMD).id!;
      abandon(db, cmdId);
      // runCmdList は実時間で見るゆえ、跡を閾値の向こうへ送る
      const past = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000).toISOString();
      db.run('UPDATE claim SET at = ?, released_at = ?', [past, past]);
      const r = runCmdList(path, false);
      const line = (id: string) => r.out!.split('\n').find((l) => l.includes(id))!;
      expect(line(cmdId)).toContain('⚠見捨てられ');
      expect(line(other)).not.toContain('⚠見捨てられ');
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
