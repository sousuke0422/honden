/**
 * 合図の段の試験。
 *
 * 中心は 4 つ。
 *
 *   1. 将軍へ撃たぬこと（殿の入力を潰す）
 *   2. 段が時刻の差で上がること（現行 CLAUDE.md の 2 分 / 4 分）
 *   3. 文脈を消すのが 5 分に一度までであること
 *   4. 片付いた者の覚えを消すこと（消さぬと次がいきなり段 3 から始まる）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import {
  plan,
  record,
  forget,
  markSince,
  levelFor,
  NEVER_NUDGE,
  LEVEL_2_AFTER_MS,
  LEVEL_3_AFTER_MS,
  RESET_COOLDOWN_MS,
  REPEAT_MS,
} from '../src/nudge';
import type { Pane } from '../src/pane';

const PANES = new Map<string, Pane>([
  ['shogun', { id: '%0', label: 'shogun:main.0' }],
  ['karo', { id: '%1', label: 'multiagent:agents.0' }],
  ['ashigaru1', { id: '%4', label: 'multiagent:agents.1' }],
  ['ashigaru2', { id: '%5', label: 'multiagent:agents.2' }],
]);

const T0 = new Date('2026-08-26T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function seeded(cli: Record<string, string> = {}) {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: cli['shogun'] ?? 'claude', model: null },
      { id: 'karo', role: 'commander', cli: cli['karo'] ?? 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: cli['gunshi'] ?? 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: cli['ashigaru1'] ?? 'claude', model: null },
      { id: 'ashigaru2', role: 'worker', cli: cli['ashigaru2'] ?? 'copilot', model: null },
    ]);
  });
  return db;
}

function unreadFor(db: ReturnType<typeof openStore>, agent: string, n = 1) {
  tx(db, () => {
    for (let i = 0; i < n; i++) {
      deliver(db, {
        id: `m_${agent}_${i}`,
        agent,
        at: T0.toISOString(),
        type: 'report_received',
        sender: 'ashigaru1',
        body: '用件',
      });
    }
  });
}

const find = (ps: ReturnType<typeof plan>, a: string) => ps.find((p) => p.agent === a);

describe('段の数え方', () => {
  test('現行の刻みと同じ（2 分 / 4 分）', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(LEVEL_2_AFTER_MS - 1)).toBe(1);
    expect(levelFor(LEVEL_2_AFTER_MS)).toBe(2);
    expect(levelFor(LEVEL_3_AFTER_MS - 1)).toBe(2);
    expect(levelFor(LEVEL_3_AFTER_MS)).toBe(3);
  });
});

describe('将軍への手当て', () => {
  test('将軍へは撃たぬ', () => {
    const db = seeded();
    unreadFor(db, NEVER_NUDGE);
    markSince(db, NEVER_NUDGE, T0);
    const p = find(plan(db, T0, { panes: PANES }), NEVER_NUDGE)!;
    expect(p.send).toBe(false);
    expect(p.reason).toContain('殿の入力');
  });

  test('夜間の旗があれば撃つ', () => {
    const db = seeded();
    unreadFor(db, NEVER_NUDGE);
    markSince(db, NEVER_NUDGE, T0);
    const p = find(plan(db, T0, { panes: PANES, wakeShogun: true }), NEVER_NUDGE)!;
    expect(p.send).toBe(true);
  });
});

describe('撃つ中身', () => {
  test('段 1 は合図の形（inbox_notice）', () => {
    const db = seeded();
    unreadFor(db, 'karo', 2);
    markSince(db, 'karo', T0);
    const p = find(plan(db, T0, { panes: PANES }), 'karo')!;
    expect(p.level).toBe(1);
    expect(p.text).toContain('inbox_notice');
    expect(p.text).toContain('unread=2');
  });

  test('Copilot は段 2 で先に Escape×2 と Ctrl-C', () => {
    const db = seeded();
    unreadFor(db, 'ashigaru2');
    markSince(db, 'ashigaru2', T0);
    const p = find(plan(db, at(LEVEL_2_AFTER_MS), { panes: PANES }), 'ashigaru2')!;
    expect(p.level).toBe(2);
    expect(p.hardRecovery).toBe(true);
  });

  test('Claude は段 2 でも素の合図', () => {
    const db = seeded();
    unreadFor(db, 'ashigaru1');
    markSince(db, 'ashigaru1', T0);
    const p = find(plan(db, at(LEVEL_2_AFTER_MS), { panes: PANES }), 'ashigaru1')!;
    expect(p.hardRecovery).toBe(false);
  });

  test('段 3 は CLI ごとの文脈消しの命令', () => {
    const db = seeded({ ashigaru1: 'codex' });
    unreadFor(db, 'ashigaru1');
    markSince(db, 'ashigaru1', T0);
    const p = find(plan(db, at(LEVEL_3_AFTER_MS), { panes: PANES }), 'ashigaru1')!;
    expect(p.level).toBe(3);
    expect(p.text).toBe('/new'); // codex は /clear ではない
  });
});

describe('うるさくせぬ手当て', () => {
  test('同じ段は間を置いて撃ち直す', () => {
    const db = seeded();
    unreadFor(db, 'karo');
    markSince(db, 'karo', T0);
    const first = find(plan(db, T0, { panes: PANES }), 'karo')!;
    record(db, first, T0);

    const soon = find(plan(db, at(1000), { panes: PANES }), 'karo')!;
    expect(soon.send).toBe(false);
    expect(soon.reason).toContain('撃ち直さぬ');

    const later = find(plan(db, at(REPEAT_MS + 1000), { panes: PANES }), 'karo')!;
    expect(later.send).toBe(true);
  });

  test('段が上がったら間を置かずに撃つ', () => {
    const db = seeded();
    unreadFor(db, 'karo');
    markSince(db, 'karo', T0);
    record(db, find(plan(db, at(LEVEL_2_AFTER_MS - 1000), { panes: PANES }), 'karo')!, at(LEVEL_2_AFTER_MS - 1000));
    // 1 秒後だが段は 1 から 2 へ上がっておる
    const p = find(plan(db, at(LEVEL_2_AFTER_MS), { panes: PANES }), 'karo')!;
    expect(p.level).toBe(2);
    expect(p.send).toBe(true);
  });

  test('文脈消しは 5 分に一度まで。塞がれた間は素の合図へ落ちる', () => {
    const db = seeded();
    unreadFor(db, 'ashigaru1');
    markSince(db, 'ashigaru1', T0);
    const first = find(plan(db, at(LEVEL_3_AFTER_MS), { panes: PANES }), 'ashigaru1')!;
    expect(first.level).toBe(3);
    record(db, first, at(LEVEL_3_AFTER_MS));

    // 冷めておらぬ間
    const blocked = find(plan(db, at(LEVEL_3_AFTER_MS + REPEAT_MS + 1000), { panes: PANES }), 'ashigaru1')!;
    expect(blocked.level).toBe(2);
    // 黙るのではない。撃つ相手は残る
    expect(blocked.send).toBe(true);
    expect(blocked.text).toContain('inbox_notice');

    // 冷めた後
    const again = find(plan(db, at(LEVEL_3_AFTER_MS + RESET_COOLDOWN_MS + 1000), { panes: PANES }), 'ashigaru1')!;
    expect(again.level).toBe(3);
  });
});

describe('覚えの後始末', () => {
  test('片付いた者の覚えを消さぬと、次がいきなり段 3 から始まる', () => {
    const db = seeded();
    unreadFor(db, 'karo');
    markSince(db, 'karo', T0);

    // 10 分後に片付いた
    db.run('DELETE FROM inbox WHERE agent = ?', ['karo']);
    forget(db, ['karo']);

    // さらに後で新しい未読が来る
    unreadFor(db, 'karo');
    const later = at(LEVEL_3_AFTER_MS * 3);
    markSince(db, 'karo', later);
    const p = find(plan(db, later, { panes: PANES }), 'karo')!;
    expect(p.level).toBe(1); // 前の続きではなく、いま始まった扱い
  });

  test('未読が無い者は並ばぬ', () => {
    const db = seeded();
    unreadFor(db, 'karo');
    markSince(db, 'karo', T0);
    const ps = plan(db, T0, { panes: PANES });
    expect(ps.map((p) => p.agent)).toEqual(['karo']);
  });
});

describe('ペインが引けぬとき', () => {
  test('ペインが無ければ撃たぬ。黙らずに理由を出す', () => {
    const db = seeded();
    unreadFor(db, 'gunshi'); // PANES に居らぬ
    markSince(db, 'gunshi', T0);
    const p = find(plan(db, T0, { panes: PANES }), 'gunshi')!;
    expect(p.send).toBe(false);
    expect(p.reason).toContain('ペインが見つからぬ');
  });
});
