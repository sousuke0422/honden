/**
 * 刻の無い枠切れ（undated-limit）の保留中の打ち直しの試験。
 *
 * 眼目（殿の裁可・2026-10-04）:
 *   - 保留の後も、間を倍々に延ばして素の合図を打ち直す（30 分 → 1 時間 → … → 12 時間、以後 12 時間ごと）
 *   - 打つのは inbox_notice だけ。文脈の消去（/new・/clear）は一度も起こさぬ
 *   - 上役への報せは保留の時に一度だけ
 *   - 回数と刻は正本に覚え、芯を立て直しても 30 分へ巻き戻らぬ
 *   - 未読の片付き・revive で解け、次の保留は 30 分から数え直す
 *   - 原因の分からぬ無応答（unresponsive）は打ち直さぬ
 *   - 刻の在る枠切れ（limited_until）は今のとおり明けるまで撃たぬ
 *
 * runNudge は sender を spy へ注ぎ替え、pane は作り物を渡す（実の pane へ撃たぬ）。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver, ackAll } from '../src/inbox';
import { plan, record, stateOf, holdForReview, revive, markLimited } from '../src/nudge';
import { runNudge } from '../src/main';

const AGENT = 'ashigaru9';
const FAKE_PANE = '%2147483646';
const MIN = 60_000;
// 殿の言から取った列（最初の 30 分と、上限の 12 時間）。以後は 12 時間ごと。
const STEPS_MIN = [30, 60, 120, 240, 480, 720, 720, 720];

const panesMap = () => new Map([[AGENT, { id: FAKE_PANE, label: 'fake:agents.9' }]]);
const paneReader = () => panesMap();
const spy = () => {
  const sent: string[] = [];
  const sender = async (p: { text: string }) => {
    sent.push(p.text);
    return { ok: true as const };
  };
  return { sent, sender };
};

function seed(db: Database) {
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: AGENT, role: 'worker', cli: 'codex', model: null },
    ]);
  });
  deliver(db, {
    id: `msg_test_backoff_${Math.random().toString(36).slice(2)}`,
    agent: AGENT,
    at: new Date(Date.now() - 10 * MIN).toISOString(),
    type: 'task_assigned',
    sender: 'karo',
    body: '試料の任',
  });
  db.run('INSERT OR IGNORE INTO nudge(agent, since) VALUES (?, ?)', [AGENT, new Date(Date.now() - 10 * MIN).toISOString()]);
}

const fileDb = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'undated-backoff-')), 'h.db');
  const db = openStore({ path });
  seed(db);
  return { db, path };
};

const notices = (db: Database) =>
  (db.query("SELECT count(*) n FROM inbox WHERE agent IN ('karo','shogun') AND body LIKE '%合図を保留した%'").get() as { n: number }).n;

const tick = (path: string, limited: () => 'undated' | number | null = () => 'undated') => {
  const s = spy();
  return runNudge(path, false, false, undefined, 'core', paneReader, () => false, limited, s.sender).then((r) => ({ r, sent: s.sent }));
};

describe('間隔の列（30 分 → 1 時間 → … → 12 時間、以後 12 時間ごと）', () => {
  test('各回の刻の直前は打たず、刻が来れば inbox_notice を打つ', () => {
    const db = openStore({ path: ':memory:' });
    seed(db);
    const T0 = new Date('2026-10-04T00:00:00.000Z');
    holdForReview(db, AGENT, 'undated-limit', T0);
    let base = T0;
    STEPS_MIN.forEach((step, k) => {
      const due = new Date(base.getTime() + step * MIN);
      const before = plan(db, new Date(due.getTime() - MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!;
      expect(before.send, `${k + 1} 回目の 1 分前`).toBe(false);
      const at = plan(db, due, { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!;
      expect(at.send, `${k + 1} 回目の刻`).toBe(true);
      expect(at.text.startsWith('inbox_notice'), `${k + 1} 回目は素の合図`).toBe(true);
      record(db, at, due); // 撃った跡（回数と刻）
      expect(stateOf(db, AGENT).hold_resend_count).toBe(k + 1);
      base = due;
    });
  });
});

describe('打つのは inbox_notice だけ、上役へは一度だけ', () => {
  test('芯の一巡を何周させても、送るのは inbox_notice だけで、文脈は消さず、報せは保留の一度', async () => {
    const { db, path } = fileDb();
    holdForReview(db, AGENT, 'undated-limit', new Date(Date.now() - 31 * MIN));
    db.close();
    const all: string[] = [];
    for (let k = 0; k < 8; k++) {
      const { r, sent } = await tick(path); // 旗は出たまま（読み手は undated を返す）
      expect(r.code).toBe(0);
      all.push(...sent);
      // 次の刻を過ぎた所へ時を進める（最後に打った刻を、その回の間＋1 分だけ昔へ置く）
      const d = openStore({ path });
      d.run('UPDATE nudge SET hold_resent_at = ? WHERE agent = ?', [
        new Date(Date.now() - (STEPS_MIN[Math.min(k + 1, STEPS_MIN.length - 1)]! + 1) * MIN).toISOString(),
        AGENT,
      ]);
      d.close();
    }
    expect(all.length).toBe(8);
    expect(all.every((t) => t.startsWith('inbox_notice'))).toBe(true);
    expect(all.some((t) => t.startsWith('/'))).toBe(false);
    const d = openStore({ path });
    expect(stateOf(d, AGENT).hold_resend_count).toBe(8);
    expect(stateOf(d, AGENT).hold_reason).toBe('undated-limit'); // 保留は続く
    expect(stateOf(d, AGENT).reset_count).toBe(0); // 文脈消しの数えは進まぬ
    expect(notices(d)).toBe(1);
  });
});

describe('芯を立て直しても間は巻き戻らぬ', () => {
  test('一度打った後に正本を開き直しても、次は 1 時間後（30 分ではない）', async () => {
    const { db, path } = fileDb();
    holdForReview(db, AGENT, 'undated-limit', new Date(Date.now() - 31 * MIN));
    db.close();
    const first = await tick(path);
    expect(first.sent.length).toBe(1);
    // 立て直し: 正本を開き直し、最後に打った刻を 31 分前へ（30 分の間なら打つ所）
    const d = openStore({ path });
    expect(stateOf(d, AGENT).hold_resend_count).toBe(1);
    d.run('UPDATE nudge SET hold_resent_at = ? WHERE agent = ?', [new Date(Date.now() - 31 * MIN).toISOString(), AGENT]);
    d.close();
    const second = await tick(path);
    expect(second.sent).toEqual([]); // 二回目の間は 1 時間
    expect(second.r.out ?? '').toContain('次に打つ刻');
  });
});

describe('解除と数え直し', () => {
  test('本人が未読を片付ければ保留も数えも消え、次の保留は 30 分から', async () => {
    const { db, path } = fileDb();
    holdForReview(db, AGENT, 'undated-limit', new Date(Date.now() - 31 * MIN));
    db.close();
    expect((await tick(path)).sent.length).toBe(1);
    let d = openStore({ path });
    ackAll(d, AGENT);
    d.close();
    await tick(path); // 未読 0 ゆえ覚えを消す
    d = openStore({ path });
    const st = stateOf(d, AGENT);
    expect(st.hold_reason).toBeNull();
    expect(st.hold_resend_count).toBe(0);
    expect(st.hold_resent_at).toBeNull();
    // 次の保留は 30 分から
    seed(d);
    const T1 = new Date();
    holdForReview(d, AGENT, 'undated-limit', T1);
    const p29 = plan(d, new Date(T1.getTime() + 29 * MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!;
    const p30 = plan(d, new Date(T1.getTime() + 30 * MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!;
    expect(p29.send).toBe(false);
    expect(p30.send).toBe(true);
  });

  test('revive で保留も数えも消え、次の保留は 30 分から', () => {
    const db = openStore({ path: ':memory:' });
    seed(db);
    const T0 = new Date('2026-10-04T00:00:00.000Z');
    holdForReview(db, AGENT, 'undated-limit', T0);
    const at = plan(db, new Date(T0.getTime() + 30 * MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!;
    record(db, at, new Date(T0.getTime() + 30 * MIN));
    expect(stateOf(db, AGENT).hold_resend_count).toBe(1);
    expect(revive(db, { agent: AGENT, by: 'karo', reason: '画面と契約枠を確かめ、枠が戻っておった' }).ok).toBe(true);
    const st = stateOf(db, AGENT);
    expect(st.hold_reason).toBeNull();
    expect(st.hold_resend_count).toBe(0);
    const T1 = new Date('2026-10-04T05:00:00.000Z');
    holdForReview(db, AGENT, 'undated-limit', T1);
    expect(plan(db, new Date(T1.getTime() + 29 * MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!.send).toBe(false);
    expect(plan(db, new Date(T1.getTime() + 30 * MIN), { panes: panesMap(), autonomous: true }).find((x) => x.agent === AGENT)!.send).toBe(true);
  });
});

describe('打ち直さぬ物', () => {
  test('原因の分からぬ無応答（unresponsive）は、どれだけ経っても打ち直さぬ', async () => {
    const { db, path } = fileDb();
    holdForReview(db, AGENT, 'unresponsive', new Date(Date.now() - 24 * 60 * MIN));
    db.close();
    const { r, sent } = await tick(path, () => null);
    expect(sent).toEqual([]);
    expect(r.out ?? '').toContain('上役の確認待ち（unresponsive');
    const d = openStore({ path });
    expect(stateOf(d, AGENT).hold_resend_count).toBe(0);
  });

  test('刻の在る枠切れ（limited_until）が明けておらねば、打ち直しの刻が来ても撃たぬ', async () => {
    const { db, path } = fileDb();
    holdForReview(db, AGENT, 'undated-limit', new Date(Date.now() - 31 * MIN));
    markLimited(db, AGENT, new Date(Date.now() + 60 * MIN));
    db.close();
    const { r, sent } = await tick(path);
    expect(sent).toEqual([]);
    expect(r.out ?? '').toContain('明けるまで撃たず');
  });
});

describe('表示と移行', () => {
  test('保留中の行に次に打つ刻が出る', async () => {
    const { db, path } = fileDb();
    const T0 = new Date(Date.now() - 5 * MIN);
    holdForReview(db, AGENT, 'undated-limit', T0);
    db.close();
    const { r, sent } = await tick(path);
    expect(sent).toEqual([]);
    expect(r.out ?? '').toContain(`次に打つ刻 ${new Date(T0.getTime() + 30 * MIN).toISOString()}`);
  });

  test('古い形の正本（打ち直しの欄の無い nudge 表）は開くだけで追い付く', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'undated-backoff-mig-')), 'old.db');
    openStore({ path }).close();
    const old = new Database(path);
    old.run('DROP TABLE nudge');
    old.run(`CREATE TABLE nudge (agent TEXT PRIMARY KEY, since TEXT, last_at TEXT, last_level INTEGER,
      last_reset_at TEXT, reset_count INTEGER NOT NULL DEFAULT 0, limited_until TEXT, hold_reason TEXT, hold_at TEXT)`);
    old.run("INSERT INTO nudge(agent, hold_reason, hold_at) VALUES (?, 'undated-limit', '2026-10-04T00:00:00.000Z')", [AGENT]);
    old.close();
    const db = openStore({ path });
    const cols = (db.query('PRAGMA table_info(nudge)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('hold_resend_count');
    expect(cols).toContain('hold_resent_at');
    const st = stateOf(db, AGENT);
    expect(st.hold_reason).toBe('undated-limit');
    expect(st.hold_resend_count).toBe(0);
  });
});
