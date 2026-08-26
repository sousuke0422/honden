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
  ATTENDED_SILENT,
  LEVEL_2_AFTER_MS,
  LEVEL_3_AFTER_MS,
  RESET_COOLDOWN_MS,
  REPEAT_MS,
} from '../src/nudge';
import type { Pane } from '../src/pane';
import { setMode, getMode, parseUntil } from '../src/mode';
import { inboxWrite } from '../src/cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('殿が在席かで宛先が変わる', () => {
  const withShogunUnread = () => {
    const db = seeded();
    unreadFor(db, ATTENDED_SILENT);
    markSince(db, ATTENDED_SILENT, T0);
    return db;
  };

  test('在席の間は将軍へ撃たぬ', () => {
    const db = withShogunUnread();
    const p = find(plan(db, T0, { panes: PANES }), ATTENDED_SILENT)!;
    expect(p.send).toBe(false);
    expect(p.reason).toContain('殿が在席');
  });

  test('自律運用では将軍も起こす。これが前提であって例外ではない', () => {
    const db = withShogunUnread();
    setMode(db, 'shogun', 'autonomous', { until: '6h', now: T0 });
    const p = find(plan(db, T0, { panes: PANES }), ATTENDED_SILENT)!;
    expect(p.send).toBe(true);
  });

  test('様態は正本から引く。旗を渡さずとも効く', () => {
    const db = withShogunUnread();
    setMode(db, 'shogun', 'autonomous', { now: T0 });
    // opts に何も渡していない
    expect(find(plan(db, T0, { panes: PANES }), ATTENDED_SILENT)!.send).toBe(true);
  });

  test('期限が切れれば在席へ戻り、また撃たぬ', () => {
    // 戻し忘れの害は、まさにこの守りが防ごうとしているもの
    const db = withShogunUnread();
    setMode(db, 'shogun', 'autonomous', { until: '6h', now: T0 });
    expect(find(plan(db, at(5 * 3_600_000), { panes: PANES }), ATTENDED_SILENT)!.send).toBe(true);
    expect(find(plan(db, at(7 * 3_600_000), { panes: PANES }), ATTENDED_SILENT)!.send).toBe(false);
  });

  test('自律でも他の者への扱いは変わらぬ', () => {
    const db = seeded();
    unreadFor(db, 'karo');
    markSince(db, 'karo', T0);
    setMode(db, 'shogun', 'autonomous', { now: T0 });
    expect(find(plan(db, T0, { panes: PANES }), 'karo')!.send).toBe(true);
  });
});

describe('様態そのもの', () => {
  test('既定は在席。何も決めておらぬなら潰さぬほうを採る', () => {
    const db = seeded();
    expect(getMode(db, T0).mode).toBe('attended');
  });

  test('知らぬ様態は弾く', () => {
    const db = seeded();
    const r = setMode(db, 'shogun', '夜', { now: T0 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('attended');
  });

  test('期限は時刻でも長さでも書ける', () => {
    // 夜に「朝 8 時まで」と書いたら翌朝を指すこと
    const night = new Date('2026-08-26T23:00:00');
    const d = parseUntil('08:00', night)!;
    expect(d.getTime()).toBeGreaterThan(night.getTime());
    expect(d.getHours()).toBe(8);

    expect(parseUntil('6h', T0)!.getTime()).toBe(T0.getTime() + 6 * 3_600_000);
    expect(parseUntil('30m', T0)!.getTime()).toBe(T0.getTime() + 30 * 60_000);
  });

  test('読めぬ期限と過ぎた期限は弾く', () => {
    const db = seeded();
    expect(setMode(db, 'shogun', 'autonomous', { until: 'あした', now: T0 }).ok).toBe(false);
    expect(setMode(db, 'shogun', 'autonomous', { until: '2020-01-01T00:00:00Z', now: T0 }).ok).toBe(false);
  });

  test('期限なしの自律には断りを添える', () => {
    const db = seeded();
    const r = setMode(db, 'shogun', 'autonomous', { now: T0 });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('戻し忘れる');
  });

  test('様態の切り替えは台帳に残る', () => {
    const db = seeded();
    setMode(db, 'shogun', 'autonomous', { until: '6h', now: T0 });
    const led = db.query("SELECT action, detail FROM ledger WHERE action = 'mode.autonomous'").all() as {
      action: string;
      detail: string;
    }[];
    expect(led.length).toBe(1);
    expect(led[0]!.detail).toContain('until=');
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

describe('書き込み側も同じ様態で判ずる', () => {
  const write = (db: ReturnType<typeof openStore>, dbPath: string, from: string, to: string) =>
    inboxWrite(dbPath, { flags: { to, from, type: 'report_received', body: '裁定を仰ぐ' } }, false, {
      insideFormation: true,
      selfId: from,
    });

  test('在席の間、家老から将軍へは書けぬ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-mode-'));
    const dbPath = join(dir, 'h.db');
    const db = openStore({ path: dbPath });
    tx(db, () => {
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      ]);
    });
    const r = write(db, dbPath, 'karo', 'shogun');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('dashboard');
    expect((db.query('SELECT count(*) c FROM inbox').get() as { c: number }).c).toBe(0);
  });

  test('自律運用なら開く。これが escalation の路になる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-mode2-'));
    const dbPath = join(dir, 'h.db');
    const db = openStore({ path: dbPath });
    tx(db, () => {
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      ]);
    });
    setMode(db, 'shogun', 'autonomous', { until: '6h' });
    const r = write(db, dbPath, 'karo', 'shogun');
    expect(r.code).toBe(0);
  });

  test('他の者から将軍へは平時でも通る（塞いだのは家老の路だけ）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-mode3-'));
    const dbPath = join(dir, 'h.db');
    const db = openStore({ path: dbPath });
    tx(db, () => {
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      ]);
    });
    expect(write(db, dbPath, 'gunshi', 'shogun').code).toBe(0);
  });
});
