/**
 * 受け渡しを読む・既読にする試験。
 *
 * 中心は 2 つ。
 *
 *   1. 他人の報せを既読にできぬこと（既読にすると相手は永久に気づけない）
 *   2. 開く前に分類が分かること（inboxN の曖昧さを消す）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { list, summarize, nudgeText, ack, ackAll } from '../src/inbox';

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  const ins = db.prepare(
    'INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,?)',
  );
  tx(db, () => {
    ins.run('m1', 'karo', '2026-08-24T10:00', 'cmd_new', 'shogun', '司令である', 0);
    ins.run('m2', 'karo', '2026-08-24T11:00', 'report_received', 'ashigaru1', '報告', 0);
    ins.run('m3', 'karo', '2026-08-24T12:00', 'report_received', 'ashigaru2', '報告', 0);
    ins.run('m4', 'karo', '2026-08-24T09:00', 'task_assigned', 'shogun', '古い既読', 1);
    ins.run('g1', 'gunshi', '2026-08-24T10:00', 'report_received', 'ashigaru1', '軍師宛', 0);
  });
  return db;
};

describe('読む', () => {
  test('未読を古い順に返す', () => {
    const m = list(seeded(), 'karo');
    expect(m.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('--all なら既読も返る', () => {
    const m = list(seeded(), 'karo', { all: true });
    expect(m.map((x) => x.id)).toEqual(['m4', 'm1', 'm2', 'm3']);
  });

  test('他人の分は混じらぬ', () => {
    expect(list(seeded(), 'karo').map((x) => x.id)).not.toContain('g1');
  });
});

describe('開く前に分かること', () => {
  // inbox3 は「未読 3 件」とも「足軽 3 号」とも読める。足軽の番号も 1〜7 で
  // 未読数と同じ範囲になるため衝突する。数と分類を分けて書けば消える。
  // 受け取るのは人ではなく各 CLI の裏のモデル。日本語の記号や語の切れ目は
  // モデルごとに揺れるので、key=value で揃える。
  test('内訳が出る', () => {
    const s = summarize(seeded(), 'karo');
    expect(s.total).toBe(3);
    expect(s.byType).toEqual([
      { type: 'report_received', count: 2 },
      { type: 'cmd_new', count: 1 },
    ]);
  });

  test('手を止めるべきものが混じっていれば印が付く', () => {
    const s = summarize(seeded(), 'karo');
    expect(s.urgent).toBe(true);
    expect(nudgeText(s)).toContain('urgent=1');
  });

  test('報告だけなら急がぬ', () => {
    const s = summarize(seeded(), 'gunshi');
    expect(s.urgent).toBe(false);
    expect(nudgeText(s)).toBe('inbox_notice unread=1 report_received=1 urgent=0');
  });

  test('無ければそう言う', () => {
    const db = seeded();
    ackAll(db, 'karo');
    expect(nudgeText(summarize(db, 'karo'))).toBe('inbox_notice unread=0');
  });
});

describe('既読にする', () => {
  test('自分の報せは既読にできる', () => {
    const db = seeded();
    const r = ack(db, 'karo', ['m1', 'm2']);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(['m1', 'm2']);
    expect(summarize(db, 'karo').total).toBe(1);
  });

  test('すでに既読でもエラーにせぬ（何度呼んでも同じ）', () => {
    const db = seeded();
    ack(db, 'karo', ['m1']);
    const r = ack(db, 'karo', ['m1']);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
    expect(r.already).toEqual(['m1']);
  });

  // 他人の報せを既読にすると、その相手は報せが来たことを永久に知らない。
  test('他人の報せは既読にできぬ', () => {
    const db = seeded();
    const r = ack(db, 'karo', ['g1']);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('gunshi 宛である');
    expect(summarize(db, 'gunshi').total).toBe(1);
  });

  // 一部だけ通すと、どこまで済んだのか呼んだ側に分からない。
  test('他人のが混じっていたら一件も触らぬ', () => {
    const db = seeded();
    const r = ack(db, 'karo', ['m1', 'g1']);
    expect(r.ok).toBe(false);
    expect(summarize(db, 'karo').total).toBe(3);
  });

  test('無い id が混じっていたら一件も触らぬ', () => {
    const db = seeded();
    const r = ack(db, 'karo', ['m1', 'そんな id は無い']);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('そのような報せは無い');
    expect(summarize(db, 'karo').total).toBe(3);
  });

  test('id が無ければ断る', () => {
    expect(ack(seeded(), 'karo', []).ok).toBe(false);
  });

  test('全部既読にできる', () => {
    const db = seeded();
    const r = ackAll(db, 'karo');
    expect(r.changed.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(summarize(db, 'karo').total).toBe(0);
    // 他人のには触らぬ
    expect(summarize(db, 'gunshi').total).toBe(1);
  });

  test('既読は台帳に残る', () => {
    const db = seeded();
    ack(db, 'karo', ['m1']);
    const l = db.query("SELECT actor, action, detail FROM ledger WHERE action = 'inbox.ack'").all() as {
      actor: string;
      detail: string;
    }[];
    expect(l[0]?.actor).toBe('karo');
    expect(l[0]?.detail).toContain('m1');
  });

  test('何も変わらねば台帳を汚さぬ', () => {
    const db = seeded();
    ack(db, 'karo', ['m4']); // すでに既読
    const n = (db.query("SELECT count(*) c FROM ledger WHERE action = 'inbox.ack'").get() as {
      c: number;
    }).c;
    expect(n).toBe(0);
  });
});
