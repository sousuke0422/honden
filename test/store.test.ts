/**
 * 正本の開き口の試験。
 *
 * ここに置くのは「正しく動くこと」の確認ではなく、
 * **shogun で実際に起きた壊れ方が、この造りでは起こせないこと** の確認になる。
 *
 * 陽性対照のない試験は検出器として無価値なので、
 * 各件が「守りを外したら落ちる」形になっているかを見ること。
 */

import { expect, test, describe } from 'bun:test';
import { openStore, pragmas, tx, journal } from '../src/store';

const mem = () => openStore({ path: ':memory:' });

describe('pragma', () => {
  test('busy_timeout が入っている (0 なら錠を待たずに即死する)', () => {
    const db = mem();
    expect(pragmas(db).busyTimeout).toBe(5000);
  });

  test('外部キーが有効 (既定は無効なので明示していないと 0 になる)', () => {
    const db = mem();
    expect(pragmas(db).foreignKeys).toBe(1);
  });
});

describe('id の重複', () => {
  // 2026-08-24 の実例: shogun_to_karo.yaml で cmd_668 を二重に採番し、
  // 既存の 36 件を上書きしかけた。grep が行頭一致で入れ子の id を拾えなかった。
  test('同じ cmd id は二度入らない', () => {
    const db = mem();
    const ins = db.prepare(
      'INSERT INTO cmd(id, created_at, raw) VALUES (?, ?, ?)',
    );
    ins.run('cmd_668', '2026-08-19T07:10:00', 'x');
    expect(() => ins.run('cmd_668', '2026-08-24T12:00:00', 'y')).toThrow();
  });

  test('先に入っていた側が残る (後から来たもので黙って置き換わらない)', () => {
    const db = mem();
    const ins = db.prepare('INSERT INTO cmd(id, created_at, raw) VALUES (?, ?, ?)');
    ins.run('cmd_668', '2026-08-19T07:10:00', 'もとの中身');
    try { ins.run('cmd_668', '2026-08-24T12:00:00', '上書き'); } catch {}
    const got = db.query('SELECT raw FROM cmd WHERE id = ?').get('cmd_668') as { raw: string };
    expect(got.raw).toBe('もとの中身');
  });
});

describe('値の検査', () => {
  test('status に無い値は入らない', () => {
    const db = mem();
    expect(() =>
      db.prepare('INSERT INTO cmd(id, created_at, status, raw) VALUES (?, ?, ?, ?)')
        .run('cmd_1', 'now', 'とりあえず', 'x'),
    ).toThrow();
  });

  test('read は 0 か 1 しか受けない', () => {
    const db = mem();
    const ins = db.prepare(
      'INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,?)',
    );
    expect(() => ins.run('m1', 'karo', 'now', 'cmd_new', 'shogun', 'body', 2)).toThrow();
  });

  test('存在しない cmd を指す受け入れ条件は入らない', () => {
    const db = mem();
    expect(() =>
      db.prepare('INSERT INTO cmd_acceptance(cmd_id, idx, text) VALUES (?,?,?)')
        .run('cmd_ない', 0, 'x'),
    ).toThrow();
  });
});

describe('取引', () => {
  // 2026-08-24: 家老が同じ YAML を編集している最中に将軍が書き込み、
  // 目印が消えていて一度失敗した。半端な状態が残らないことが要る。
  test('途中で落ちたら何も残らない', () => {
    const db = mem();
    const ins = db.prepare('INSERT INTO cmd(id, created_at, raw) VALUES (?,?,?)');
    expect(() =>
      tx(db, () => {
        ins.run('cmd_a', 'now', 'x');
        ins.run('cmd_b', 'now', 'y');
        throw new Error('途中で失敗');
      }),
    ).toThrow('途中で失敗');
    const n = db.query('SELECT count(*) c FROM cmd').get() as { c: number };
    expect(n.c).toBe(0);
  });

  test('通れば全部残る', () => {
    const db = mem();
    const ins = db.prepare('INSERT INTO cmd(id, created_at, raw) VALUES (?,?,?)');
    tx(db, () => { ins.run('cmd_a', 'now', 'x'); ins.run('cmd_b', 'now', 'y'); });
    const n = db.query('SELECT count(*) c FROM cmd').get() as { c: number };
    expect(n.c).toBe(2);
  });
});

describe('台帳', () => {
  test('落ちた取引の台帳行は残らない (記録だけ残る嘘を作らない)', () => {
    const db = mem();
    try {
      tx(db, () => {
        journal(db, { actor: 'shogun', action: 'cmd.create', target: 'cmd_704' });
        throw new Error('失敗');
      });
    } catch {}
    const n = db.query('SELECT count(*) c FROM ledger').get() as { c: number };
    expect(n.c).toBe(0);
  });

  test('通った取引の台帳行は残る', () => {
    const db = mem();
    tx(db, () => journal(db, { actor: 'shogun', action: 'cmd.create', target: 'cmd_704' }));
    const r = db.query('SELECT actor, action, target FROM ledger').all();
    expect(r).toEqual([{ actor: 'shogun', action: 'cmd.create', target: 'cmd_704' }]);
  });
});

describe('置き場所', () => {
  test('9p の上に正本を置こうとしたら止める', () => {
    expect(() => openStore({ path: '/mnt/c/Users/aki/work/honden/x.db' })).toThrow(/9p/);
  });

  test('試験用の抜け道は効く (この抜け道が効かないと上の試験が測れない)', () => {
    // allowSlowFs を渡しても、経路自体は同じであることの確認。
    // 実ファイルは作らず、判定が通ることだけを見る。
    expect(() => openStore({ path: '/mnt/c/nonexistent-dir-for-test/x.db', allowSlowFs: true }))
      .not.toThrow(/9p/);
  });
});
