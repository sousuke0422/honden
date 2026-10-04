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
import { stateOf, revive, markLimited, holdForReview } from '../src/nudge';
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

    // ── 周 3: 明ける刻を過ぎた。覚えの分岐を抜け、通常の梯子へ戻る ──
    // 試料の未読は 10 分前ゆえ梯子は L3。L3 は文脈を消さず上役の確認待ちへ
    // 回す（無応答の保留・feat/nudge-unknown-flag の方針）。覚えが効いておれば
    // 周 2 と同じく「明けるまで撃たず」で止まり、pane も読みに行かぬ。
    await Bun.sleep(WAIT_MS + 200);
    const s3 = spy();
    let reads3 = 0;
    const r3 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => { reads3 += 1; return null; }, s3.sender);
    expect(r3.code).toBe(0);
    expect((r3.out ?? '').includes('明けるまで撃たず')).toBe(false);
    expect(reads3).toBe(1); // 梯子へ戻り、旗を読みに行った
    expect((r3.out ?? '').includes('上役の確認待ち（unresponsive）')).toBe(true);
    expect(s3.sent).toEqual([]); // 文脈は消させぬ
  }, 20_000);
});

describe('見放された者が revive の後に合図を受ける（軍師の形）', () => {
  test('reset_count>=3 は撃たれぬが、revive で覚えが落ちれば次の周から届く', async () => {
    const path = join(tmpdir(), `limited-revive-${Date.now()}.db`);
    const db = seeded(path);
    // 見放しの覚え（三度の文脈消し）——今の軍師と同じ形。枠切れの覚えは無い
    db.run('UPDATE nudge SET reset_count = 3 WHERE agent = ?', ['ashigaru9']);
    db.close();

    // 見放されておる間は撃たれぬ（枠切れの分岐とは別で、直しの影響を受けぬ）
    const s1 = spy();
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s1.sender);
    expect(r1.code).toBe(0);
    expect(s1.sent).toEqual([]);
    expect((r1.out ?? '').includes('撃つのをやめた')).toBe(true);

    // 人の手（家老の revive）で覚えを落とす
    const db2 = openStore({ path });
    const rv = revive(db2, { agent: 'ashigaru9', by: 'karo', reason: 'pane は生きておるが応えぬ。人の手で確かめた' });
    db2.close();
    expect(rv.ok).toBe(true);

    // 次の周から合図が届く——明けた後の軍師へ合図が届く形は壊れておらぬ
    const s2 = spy();
    const r2 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s2.sender);
    expect(r2.code).toBe(0);
    expect(s2.sent.length).toBe(1);
    expect(s2.sent[0]!.pane).toBe(FAKE_PANE);
  }, 20_000);
});

describe('枠切れでない相手（陰性対照）', () => {
  test('覚えの分岐を通らず通常の梯子へ行き、経ちが 4 分を超えれば確認待ちに至る', async () => {
    const path = join(tmpdir(), `limited-negative-${Date.now()}.db`);
    const db = seeded(path);
    db.close();

    const s1 = spy();
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s1.sender);
    expect(r1.code).toBe(0);
    // 枠切れでないゆえ覚えは刻まれず、覚えの分岐も通らぬ
    const db1 = openStore({ path });
    expect(stateOf(db1, 'ashigaru9').limited_until).toBeNull();
    db1.close();
    expect((r1.out ?? '').includes('明けるまで撃たず')).toBe(false);
    // 10 分の経ちゆえ段 3。L3 は文脈を消さず上役の確認待ちへ回す
    // （無応答の保留・feat/nudge-unknown-flag の方針。以前はここで /new を撃った）
    expect(s1.sent).toEqual([]);
    expect((r1.out ?? '').includes('上役の確認待ち（unresponsive）')).toBe(true);
  }, 20_000);
});

/**
 * 「より遠い方だけ残す」守りを直に撃つ。
 *
 * いまの経路では、この ELSE には届かぬ——明ける刻を覚えた相手は plan が
 * 撃たぬ側へ回し、markLimited を呼ぶ所（runNudge の旗を読んだ時）まで来ぬ。
 * 経路から撃てぬ守りは、単純化しても試験が通り、誰にも見張られぬ。
 * markLimited は export されておる。別の経路から呼ばれた時に効く守りゆえ、
 * 関数そのものを撃って留める。
 */
describe('markLimited は覚えを縮めぬ（守りを直に撃つ）', () => {
  const at = (iso: string) => new Date(iso);
  test('遠い刻を覚えた後に近い刻で撃っても縮まず、より遠い刻なら進む', () => {
    const db = openStore({ path: ':memory:' });
    markLimited(db, 'ashigaru9', at('2026-10-04T12:00:00.000Z'));
    expect(stateOf(db, 'ashigaru9').limited_until).toBe('2026-10-04T12:00:00.000Z');

    // 古い旗の残骸を読み直した形——近い刻で撃っても、遠い覚えを縮めぬ
    markLimited(db, 'ashigaru9', at('2026-10-04T09:00:00.000Z'));
    expect(stateOf(db, 'ashigaru9').limited_until).toBe('2026-10-04T12:00:00.000Z');

    // 同じ刻でも変わらぬ
    markLimited(db, 'ashigaru9', at('2026-10-04T12:00:00.000Z'));
    expect(stateOf(db, 'ashigaru9').limited_until).toBe('2026-10-04T12:00:00.000Z');

    // より遠い刻なら進む
    markLimited(db, 'ashigaru9', at('2026-10-04T15:30:00.000Z'));
    expect(stateOf(db, 'ashigaru9').limited_until).toBe('2026-10-04T15:30:00.000Z');
  });

  test('覚えの無い行（nudge の行が既に在り limited_until が空）なら刻む', () => {
    const db = openStore({ path: ':memory:' });
    db.run("INSERT INTO nudge(agent, since) VALUES ('ashigaru9', '2026-10-04T08:00:00.000Z')");
    markLimited(db, 'ashigaru9', at('2026-10-04T09:00:00.000Z'));
    const st = stateOf(db, 'ashigaru9');
    expect(st.limited_until).toBe('2026-10-04T09:00:00.000Z');
    // 他の欄は壊さぬ
    expect(st.since).toBe('2026-10-04T08:00:00.000Z');
  });
});

/**
 * 枠切れの覚え（limited_until）と上役の確認待ち（hold_reason）が交わる所。
 * 二つは別の枝で入り、plan の同じ所で合わさった。順と、確認待ちが旗の
 * 消えた後も解けぬことを留める。
 */
describe('覚えと確認待ちの交わり', () => {
  test('確認待ちは旗が画面から消えても解けぬ（L1 でも撃たず、旗を読みにも行かぬ）', async () => {
    const path = join(tmpdir(), `limited-hold-${Date.now()}.db`);
    const db = seeded(path);
    // 未読の山を新しくし、段を L1 にしておく（L3 の無応答の保留と混ぜぬ）
    db.run('UPDATE nudge SET since = ? WHERE agent = ?', [new Date().toISOString(), 'ashigaru9']);
    holdForReview(db, 'ashigaru9', 'undated-limit', new Date());
    db.close();

    const s1 = spy();
    let reads = 0;
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => { reads += 1; return null; }, s1.sender);
    expect(r1.code).toBe(0);
    expect(s1.sent).toEqual([]);
    expect(reads).toBe(0); // 旗が消えておっても、plan の段で止まる
    expect((r1.out ?? '').includes('上役の確認待ち（undated-limit')).toBe(true);
  }, 20_000);

  test('覚えと確認待ちが両方立てば、覚えの分岐が先に効く（刻が来れば人を待たずに明ける）', async () => {
    const path = join(tmpdir(), `limited-hold-both-${Date.now()}.db`);
    const db = seeded(path);
    holdForReview(db, 'ashigaru9', 'unresponsive', new Date());
    markLimited(db, 'ashigaru9', new Date(Date.now() + 60 * 60_000));
    db.close();

    const s1 = spy();
    const r1 = await runNudge(path, false, false, undefined, 'core', paneReader,
      () => false, () => null, s1.sender);
    expect(r1.code).toBe(0);
    expect(s1.sent).toEqual([]);
    expect((r1.out ?? '').includes('明けるまで撃たず')).toBe(true);
    expect((r1.out ?? '').includes('上役の確認待ち')).toBe(false);
  }, 20_000);
});
