/**
 * 殿の task 一覧の試験。
 *
 * 肝は三つ——**採番が衝突せぬ**・**取り込みが何度打っても同じ**・
 * **連続が一日で伸びぬ**。三つ目は数の嘘に直結するゆえ、特に念を入れる。
 */
import { describe, expect, test } from 'bun:test';
import { openStore, tx } from '../src/store';
import { add, get, list, nextId, setStatus, streak, touchStreak, importItems, render, day } from '../src/saytask';

const NOW = new Date('2026-08-30T10:00:00Z');
const db0 = () => openStore({ path: ':memory:' });

describe('add / get', () => {
  test('題が無ければ受けぬ', () => {
    const db = db0();
    expect(tx(db, () => add(db, {}, NOW)).ok).toBe(false);
    expect(tx(db, () => add(db, { title: '   ' }, NOW)).ok).toBe(false);
  });

  test('番号を振り、引ける', () => {
    const db = db0();
    const r = tx(db, () => add(db, { title: '鍵の入れ替え', category: 'infra', due: '2026-09-01' }, NOW));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.id).toBe('VF-001');
    expect(get(db, 'VF-001')?.title).toBe('鍵の入れ替え');
    expect(get(db, 'VF-001')?.status).toBe('todo');
  });

  test('知らぬ status は受けぬ', () => {
    const db = db0();
    expect(tx(db, () => add(db, { title: 'x', status: 'いつか' }, NOW)).ok).toBe(false);
  });

  test('同じ番号は二度振らぬ', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a', id: 'VF-009' }, NOW));
    const r = tx(db, () => add(db, { title: 'b', id: 'VF-009' }, NOW));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('既にある');
  });
});

describe('nextId — 最大の次であって、件数の次ではない', () => {
  test('間が空いておっても最大の次を取る', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a', id: 'VF-001' }, NOW));
    tx(db, () => add(db, { title: 'b', id: 'VF-015' }, NOW));
    // 件数の次なら VF-003 になり、**既にある番号を踏む筋が生まれる**
    expect(nextId(db)).toBe('VF-016');
  });

  test('番号の形でないものは数に入れぬ', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a', id: 'ほか-99' }, NOW));
    expect(nextId(db)).toBe('VF-001');
  });
});

describe('setStatus', () => {
  test('済ませれば刻が入る', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a' }, NOW));
    expect(tx(db, () => setStatus(db, 'VF-001', 'done', NOW)).ok).toBe(true);
    expect(get(db, 'VF-001')?.done_at).toBeTruthy();
  });

  test('戻せば刻が消える（済んだ跡を残さぬ）', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a' }, NOW));
    tx(db, () => setStatus(db, 'VF-001', 'done', NOW));
    tx(db, () => setStatus(db, 'VF-001', 'todo', NOW));
    expect(get(db, 'VF-001')?.done_at).toBeNull();
  });

  test('無い番号と、同じ状態への付け替えは断る', () => {
    const db = db0();
    tx(db, () => add(db, { title: 'a' }, NOW));
    expect(tx(db, () => setStatus(db, 'VF-999', 'done', NOW)).ok).toBe(false);
    expect(tx(db, () => setStatus(db, 'VF-001', 'todo', NOW)).ok).toBe(false);
  });
});

describe('連続（streak）— 数の嘘を作らぬ', () => {
  test('**同じ日に二度数えぬ**', () => {
    const db = db0();
    const a = tx(db, () => touchStreak(db, NOW));
    const b = tx(db, () => touchStreak(db, new Date('2026-08-30T23:00:00Z')));
    expect(a.current).toBe(1);
    expect(b.current).toBe(1); // 伸びてはならぬ
  });

  test('昨日から続けば伸びる', () => {
    const db = db0();
    tx(db, () => touchStreak(db, new Date('2026-08-29T10:00:00Z')));
    const s = tx(db, () => touchStreak(db, new Date('2026-08-30T10:00:00Z')));
    expect(s.current).toBe(2);
    expect(s.longest).toBe(2);
  });

  test('間が空けば一から。されど最長は残る', () => {
    const db = db0();
    tx(db, () => touchStreak(db, new Date('2026-08-25T10:00:00Z')));
    tx(db, () => touchStreak(db, new Date('2026-08-26T10:00:00Z')));
    const s = tx(db, () => touchStreak(db, new Date('2026-08-30T10:00:00Z')));
    expect(s.current).toBe(1);
    expect(s.longest).toBe(2);
  });

  test('日で数える（時刻は落とす）', () => {
    expect(day(new Date('2026-08-30T23:59:59Z'))).toBe('2026-08-30');
  });
});

describe('取り込み — 何度打っても同じ', () => {
  const items = [
    { id: 'VF-015', title: 'rBus — 標準内部通信', category: 'shogun-system', status: 'pending', tags: ['grpc'] },
    { id: 'VF-016', title: '投資の雑務', status: 'todo' },
  ];

  test('入り、二度目は飛ばす（手で直した分を消さぬ）', () => {
    const db = db0();
    const a = tx(db, () => importItems(db, items, NOW));
    expect(a.added).toBe(2);
    // 手で直しておく
    tx(db, () => setStatus(db, 'VF-015', 'done', NOW));
    const b = tx(db, () => importItems(db, items, NOW));
    expect(b.added).toBe(0);
    expect(b.skipped).toBe(2);
    expect(get(db, 'VF-015')?.status).toBe('done'); // 直した分が残る
  });

  test('欄が欠けた物は落第として数える（黙って捨てぬ）', () => {
    const db = db0();
    const r = tx(db, () => importItems(db, [{ id: 'VF-001' }], NOW));
    expect(r.added).toBe(0);
    expect(r.failed[0]!.id).toBe('VF-001');
  });

  test('一覧でない物を渡されても壊れぬ', () => {
    const db = db0();
    expect(tx(db, () => importItems(db, null, NOW)).added).toBe(0);
  });

  test('tags は一覧として保たれる', () => {
    const db = db0();
    tx(db, () => importItems(db, items, NOW));
    expect(get(db, 'VF-015')?.tags).toEqual(['grpc']);
  });
});

describe('list / render', () => {
  test('済んだ物は後ろへ、期限のある物は前へ', () => {
    const db = db0();
    tx(db, () => {
      add(db, { title: '済', id: 'VF-001' }, NOW);
      add(db, { title: '急ぎ', id: 'VF-002', due: '2026-09-01' }, NOW);
      add(db, { title: '未定', id: 'VF-003' }, NOW);
    });
    tx(db, () => setStatus(db, 'VF-001', 'done', NOW));
    expect(list(db).map((i) => i.id)).toEqual(['VF-002', 'VF-003', 'VF-001']);
  });

  test('状態で絞れる', () => {
    const db = db0();
    tx(db, () => {
      add(db, { title: 'a' }, NOW);
      add(db, { title: 'b', id: 'VF-002', status: 'pending' }, NOW);
    });
    expect(list(db, 'pending').map((i) => i.id)).toEqual(['VF-002']);
  });

  test('空でも読める形を返す', () => {
    const db = db0();
    expect(render(list(db), streak(db))).toContain('無い');
  });

  test('残りと連続を末尾に出す', () => {
    const db = db0();
    tx(db, () => {
      add(db, { title: 'a' }, NOW);
      add(db, { title: 'b', id: 'VF-002' }, NOW);
    });
    tx(db, () => setStatus(db, 'VF-002', 'done', NOW));
    tx(db, () => touchStreak(db, NOW));
    const out = render(list(db), streak(db));
    expect(out).toContain('残り 1 / 全 2');
    expect(out).toContain('連続 1 日');
  });
});
