/**
 * 殿の裁定を仰ぐ仕組みの試験。
 *
 * 現行 dashboard.md の 🚨要対応 は実測 352 項目のうち本物が 57（16%）。
 * 済んだまま残るもの 95、覚え書き 83、印なし 117。節そのものも 2 つに増えていた。
 *
 * **散文には状態が無い**ので、消すには判断が要り、誰も消さない。
 * ここで検めるのは、状態を持たせれば絞り込みで消えること。
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { raise, decide, open as openList, sweep } from '../src/decision';

const Q = {
  question: 'PR#32 を入れ直すか',
  choices: ['いま入れる', '次の区切りまで待つ', '取り下げる'],
};
const T0 = new Date('2026-08-26T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function seeded() {
  const db = openStore({ path: ':memory:' });
  tx(db, () =>
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
    ]),
  );
  return db;
}
const unread = (db: ReturnType<typeof openStore>, a: string) =>
  (db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(a) as { c: number }).c;

describe('上げる', () => {
  test('上役だけが上げられる', () => {
    const db = seeded();
    const r = raise(db, 'ashigaru1', Q, T0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('家老へ回されよ');
  });

  test('自由文は決裁の問いではない', () => {
    const db = seeded();
    const r = raise(db, 'karo', { question: 'どうしましょう' }, T0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('一語で再開');
  });

  test('選択肢が一つでは足りぬ', () => {
    const db = seeded();
    expect(raise(db, 'karo', { question: 'x', choices: ['はい'] }, T0).ok).toBe(false);
  });

  test('同じ選択肢が二度あれば断る', () => {
    const db = seeded();
    expect(raise(db, 'karo', { question: 'x', choices: ['はい', 'はい'] }, T0).ok).toBe(false);
  });

  test('上げれば将軍の未読が増える', () => {
    const db = seeded();
    const before = unread(db, 'shogun');
    expect(raise(db, 'karo', Q, T0).ok).toBe(true);
    expect(unread(db, 'shogun')).toBe(before + 1);
  });

  test('決まらぬ時にどうなるかが報せに載る', () => {
    const db = seeded();
    raise(db, 'karo', Q, T0);
    const m = db.query("SELECT body FROM inbox WHERE agent='shogun' ORDER BY rowid DESC LIMIT 1").get() as {
      body: string;
    };
    expect(m.body).toContain('決まるまで止まる');
  });
});

describe('既定と期限', () => {
  test('既定を置くなら期限も要る', () => {
    const db = seeded();
    const r = raise(db, 'karo', { ...Q, fallback: '次の区切りまで待つ' }, T0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('いつ倒れるか');
  });

  test('既定は選択肢の中から選ぶ', () => {
    const db = seeded();
    const r = raise(db, 'karo', { ...Q, fallback: '知らぬ選び', until: '6h' }, T0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('選択肢の中に無い');
  });

  test('期限が来れば既定へ倒れる', () => {
    const db = seeded();
    const r = raise(db, 'karo', { ...Q, fallback: '次の区切りまで待つ', until: '6h' }, T0);
    expect(openList(db, at(1000)).length).toBe(1);
    expect(openList(db, at(7 * 3_600_000)).length).toBe(0);
    const row = db.query('SELECT status, chose FROM decision WHERE id = ?').get(r.id!) as {
      status: string;
      chose: string;
    };
    expect(row.status).toBe('expired');
    expect(row.chose).toBe('次の区切りまで待つ');
  });

  test('倒れたことと、殿が決めたことは分ける', () => {
    // 同じ decided にすると、後から「殿の判断か時間切れか」が分からなくなる
    const db = seeded();
    raise(db, 'karo', { ...Q, fallback: '取り下げる', until: '6h' }, T0);
    sweep(db, at(7 * 3_600_000));
    const led = db.query("SELECT action FROM ledger WHERE action LIKE 'decision.%'").all() as { action: string }[];
    expect(led.map((l) => l.action)).toContain('decision.expired');
    expect(led.map((l) => l.action)).not.toContain('decision.decide');
  });

  test('既定が無ければ倒れぬ。止まったまま残る', () => {
    const db = seeded();
    raise(db, 'karo', Q, T0);
    expect(openList(db, at(30 * 24 * 3_600_000)).length).toBe(1);
  });
});

describe('下ろす', () => {
  test('将軍だけが下ろせる', () => {
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    expect(decide(db, 'karo', r.id!, 'いま入れる', undefined, T0).ok).toBe(false);
  });

  test('選択肢の外は下ろせぬ', () => {
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    const d = decide(db, 'shogun', r.id!, '思いつきの案', undefined, T0);
    expect(d.ok).toBe(false);
    expect(d.message).toContain('選択肢の外');
  });

  test('下ろせば開いておる一覧から消える', () => {
    // ここが眼目。散文では消すのに判断が要り、誰も消さなかった。
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    expect(openList(db, T0).length).toBe(1);
    expect(decide(db, 'shogun', r.id!, 'いま入れる', '殿の一言', T0).ok).toBe(true);
    expect(openList(db, T0).length).toBe(0);
  });

  test('上げた者へ返る', () => {
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    const before = unread(db, 'karo');
    decide(db, 'shogun', r.id!, 'いま入れる', undefined, T0);
    expect(unread(db, 'karo')).toBe(before + 1);
  });

  test('殿の言葉をそのまま残せる', () => {
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    decide(db, 'shogun', r.id!, '取り下げる', '32 はまだ入れないでほしい', T0);
    const row = db.query('SELECT note FROM decision WHERE id = ?').get(r.id!) as { note: string };
    expect(row.note).toBe('32 はまだ入れないでほしい');
  });

  test('二度は下ろせぬ。覆すなら新しく上げる', () => {
    const db = seeded();
    const r = raise(db, 'karo', Q, T0);
    decide(db, 'shogun', r.id!, 'いま入れる', undefined, T0);
    const again = decide(db, 'shogun', r.id!, '取り下げる', undefined, T0);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('新しく上げられよ');
  });

  test('倒れたものも下ろせぬ', () => {
    const db = seeded();
    const r = raise(db, 'karo', { ...Q, fallback: '取り下げる', until: '6h' }, T0);
    openList(db, at(7 * 3_600_000));
    expect(decide(db, 'shogun', r.id!, 'いま入れる', undefined, at(7 * 3_600_000)).ok).toBe(false);
  });
});
