/**
 * 枠切れの覚え（limited_until）の試験。
 *
 * 眼目: 旗を一度読んだら、旗が画面から消えても（/clear・再描画で写しは
 * 消える）明ける刻まで撃たず、文脈を消す段にも入らぬこと。
 * 明ける刻を過ぎれば通常の梯子が再開すること。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import { limitedWaitMs } from '../src/busy';
import { stateOf } from '../src/nudge';
import { runNudge } from '../src/main';

// 実物の旗（殿採取・2026-09-05・claude）
const LIMIT_LINE = "You've hit your session limit · resets 6:20pm (Asia/Tokyo)\n";
// /clear の後の素の待ち画面（旗は無い）
const CLEARED_PANE = '❯\n? for shortcuts\n';

const FAKE_PANE = '%2147483647';

function seeded(path: string, agent = 'ashigaru9') {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: agent, role: 'worker', cli: 'codex', model: null },
    ]);
  });
  deliver(db, {
    id: `msg_test_limited_${agent}`,
    agent,
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    type: 'task_assigned',
    sender: 'karo',
    body: '試料の任',
  });
  // 未読を 10 分抱えた覚え——段 3（文脈消し）へ届く経ち
  db.run('INSERT INTO nudge(agent, since) VALUES (?, ?)', [
    agent,
    new Date(Date.now() - 10 * 60_000).toISOString(),
  ]);
  return db;
}

const paneReader = () => new Map([['ashigaru9', { id: FAKE_PANE, label: 'fake:agents.9' }]]);
const spy = () => {
  const sent: { pane: string; text: string }[] = [];
  const sender = async (p: { pane?: { id: string } | null; text: string }) => {
    sent.push({ pane: p.pane?.id ?? '', text: p.text });
    return { ok: true as const };
  };
  return { sent, sender };
};

describe('旗が消えることの実測（/clear 後の写し）', () => {
  test('旗のある写しは待ちを返し、/clear 後の写しは null（消えた物は読めぬ）', () => {
    const at = new Date(2026, 8, 5, 15, 0); // 旗の 6:20pm より前の刻
    // 陽性対照: 同じ読み手が、在る旗は現に読める
    expect(limitedWaitMs(LIMIT_LINE, at)).not.toBeNull();
    // /clear の後: 旗は写しに残らぬ——画面からは枠切れを知りようが無い
    expect(limitedWaitMs(CLEARED_PANE, at)).toBeNull();
  });
});

describe('枠切れの覚え（陽性対照——今宵の形）', () => {
  test('旗を一度見せ、次の周で旗が消えても撃たず、明けた後は撃つ', async () => {
    const path = join(tmpdir(), `limited-persist-${Date.now()}.db`);
    const db = seeded(path);
    db.close();

    // ── 周 1: 旗が見えておる。撃たず、明ける刻を正本へ覚える ──
    const s1 = spy();
    const WAIT_MS = 1500;
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => WAIT_MS, s1.sender);
    expect(r1.code).toBe(0);
    expect(s1.sent).toEqual([]);
    const db1 = openStore({ path });
    const until = stateOf(db1, 'ashigaru9').limited_until;
    db1.close();
    expect(until).not.toBeNull();
    expect(new Date(until!).getTime()).toBeGreaterThan(Date.now());

    // ── 周 2: 旗は画面から消えた（読み手は null）。それでも撃たぬ。 ──
    // 覚えが正であり、pane を読み直しにも行かぬ（消えた物は読めぬ）
    const s2 = spy();
    let limitedReads = 0;
    const r2 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => { limitedReads += 1; return null; }, s2.sender);
    expect(r2.code).toBe(0);
    expect(s2.sent).toEqual([]);
    expect(limitedReads).toBe(0); // send=false の相手に読みは走らぬ
    expect((r2.out ?? '').includes('明けるまで撃たず')).toBe(true);

    // ── 周 3: 明ける刻を過ぎた。通常の梯子が再開し、撃つ ──
    await Bun.sleep(WAIT_MS + 200);
    const s3 = spy();
    const r3 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s3.sender);
    expect(r3.code).toBe(0);
    expect(s3.sent.length).toBe(1);
    expect(s3.sent[0]!.pane).toBe(FAKE_PANE);
  }, 20_000);
});

describe('枠切れでない相手（陰性対照）', () => {
  test('いままでどおり撃ち、経ちが 4 分を超えれば文脈消しに至る', async () => {
    const path = join(tmpdir(), `limited-negative-${Date.now()}.db`);
    const db = seeded(path);
    db.close();

    const s1 = spy();
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s1.sender);
    expect(r1.code).toBe(0);
    // 10 分の経ちゆえ段 3——codex への文脈消しは /new
    expect(s1.sent.length).toBe(1);
    expect(s1.sent[0]!.text).toBe('/new');
  }, 20_000);
});
