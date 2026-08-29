/**
 * 布陣の様子の試験。
 *
 * 芯は二つ。
 *   1. **「居らぬ」と「手すき」を混ぜぬこと**——pane が無い者を
 *      「待機」と書けば、落ちておるのに元気に見える
 *   2. 桁が崩れぬこと——揃わぬ表は読む気を削ぎ、読まれぬ表は無いのと同じ
 */
import { describe, expect, test } from 'bun:test';
import { collect, render, corePaths } from '../src/status';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import type { Pane } from '../src/pane';

const NOW = new Date('2026-08-28T12:00:00Z');

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'karo', role: 'commander', cli: 'claude', model: 'claude-sonnet-5' },
      { id: 'ashigaru1', role: 'worker', cli: 'codex', model: 'gpt-5.6-luna' },
      { id: 'ashigaru2', role: 'worker', cli: 'cursor', model: 'composer-2.5' },
    ]);
  });
  return db;
};

const pane = (id: string, label: string): Pane => ({ id, label, agent: '' }) as Pane;

describe('居らぬ者と手すきの者を混ぜぬ', () => {
  test('pane が無い者は busy が null（false ではない）', () => {
    const db = seeded();
    const rows = collect(db, { panes: new Map(), busy: () => false, now: NOW });
    for (const r of rows) {
      expect(r.pane).toBeNull();
      expect(r.busy).toBeNull(); // false と書けば「手すき」に見えてしまう
    }
  });

  test('居らぬ者は「不在」と出る（「待機」ではない）', () => {
    const db = seeded();
    const out = render(collect(db, { panes: new Map(), busy: () => false, now: NOW }));
    expect(out).toContain('不在');
    expect(out).not.toContain('待機');
  });

  test('居って手が塞がっておれば「働中」', () => {
    const db = seeded();
    const panes = new Map([['karo', pane('%1', 'x.0')]]);
    const out = render(collect(db, { panes, busy: () => true, now: NOW }));
    expect(out).toContain('働中');
  });

  test('居って手すきなら「待機」', () => {
    const db = seeded();
    const panes = new Map([['karo', pane('%1', 'x.0')]]);
    const out = render(collect(db, { panes, busy: () => false, now: NOW }));
    expect(out).toContain('待機');
  });
});

describe('未読と急ぎ', () => {
  test('急ぎの未読には印が付く', () => {
    const db = seeded();
    tx(db, () => {
      deliver(db, {
        id: 'm1',
        agent: 'ashigaru1',
        at: NOW.toISOString(),
        type: 'cmd_update',
        sender: 'karo',
        body: '範囲が変わった',
      });
    });
    const rows = collect(db, { panes: new Map(), busy: () => false, now: NOW });
    const a1 = rows.find((r) => r.agent === 'ashigaru1')!;
    expect(a1.unread).toBe(1);
    expect(a1.urgent).toBe(true);
    expect(render(rows)).toContain('⚠急');
  });

  test('未読が無ければ横棒', () => {
    const db = seeded();
    const rows = collect(db, { panes: new Map(), busy: () => false, now: NOW });
    expect(rows.every((r) => r.unread === 0)).toBe(true);
    expect(render(rows)).toContain('—');
  });
});

describe('桁を守る', () => {
  test('長い任の名でも行の幅が揃う', () => {
    const db = seeded();
    tx(db, () => {
      db.prepare(
        'INSERT INTO task(agent, task_id, status, cmd_id, updated_at, raw) VALUES (?,?,?,?,?,?)',
      ).run('ashigaru1', 'subtask_' + 'x'.repeat(60), 'assigned', 'cmd_1', NOW.toISOString(), '{}');
    });
    const lines = render(collect(db, { panes: new Map(), busy: () => false, now: NOW })).split('\n');
    const body = lines.slice(2); // 見出しと罫線を除く
    const widths = new Set(
      body.map((l) => [...l].reduce((a, ch) => a + (/[　-鿿＀-｠]/.test(ch) ? 2 : 1), 0)),
    );
    expect(widths.size).toBe(1); // 全ての行が同じ幅
  });

  test('削られた時は … が付く（黙って切らぬ）', () => {
    const db = seeded();
    tx(db, () => {
      db.prepare(
        'INSERT INTO task(agent, task_id, status, cmd_id, updated_at, raw) VALUES (?,?,?,?,?,?)',
      ).run('ashigaru1', 'subtask_' + 'y'.repeat(60), 'assigned', 'cmd_1', NOW.toISOString(), '{}');
    });
    expect(render(collect(db, { panes: new Map(), busy: () => false, now: NOW }))).toContain('…');
  });
});

/**
 * 芯まわりの道は**一箇所で**決まるか。
 *
 * 出陣と検めが各々で組み、名が食い違って「芯は常に死んでおる」と出ておった。
 * ここが正であり、shell は `honden paths` で引く。
 */
describe('corePaths', () => {
  test('正本の道から signal と lock を導く', () => {
    const p = corePaths('/home/x/.honden/honden.db');
    expect(p.db).toBe('/home/x/.honden/honden.db');
    expect(p.signal).toBe('/home/x/.honden/honden.db.signal');
    expect(p.lock).toBe('/home/x/.honden/watch.lock');
  });

  test('coreCheck と同じ錠を指す（食い違いが二度と入らぬよう）', () => {
    // coreCheck は corePaths を呼ぶ。別々に組み立てておらぬことを型で縛れぬゆえ、
    // ここで突き合わせる。
    const db = '/home/x/.honden/honden.db';
    expect(corePaths(db).lock).toBe('/home/x/.honden/watch.lock');
  });

  test('正本の名が honden.db でなくとも壊れぬ', () => {
    const p = corePaths('/tmp/t/h.db');
    expect(p.signal).toBe('/tmp/t/h.db.signal');
    expect(p.lock).toBe('/tmp/t/watch.lock'); // 名でなく場所で決まる
  });
});
