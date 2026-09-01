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
import { openStore, pragmas, tx, journal, legacy, indexDoc, search, segment } from '../src/store';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('判定型', () => {
  const insReport = (db: ReturnType<typeof mem>) =>
    db.prepare('INSERT INTO report(agent, verdict, raw, legacy) VALUES (?,?,?,?)');

  test('規定の 4 値は通る', () => {
    const db = mem(); const ins = insReport(db);
    for (const v of ['APPROVED','APPROVED_WITH_CONCERNS','CHANGES_REQUESTED','REJECTED']) {
      ins.run('gunshi', v, 'x', null);
    }
    const n = db.query('SELECT count(*) c FROM report').get() as { c: number };
    expect(n.c).toBe(4);
  });

  // 実データで最多だった値。廃止された qa_decision の値が欄の名だけ変わって残ったもの。
  // gunshi_at.md は pass → APPROVED / APPROVED_WITH_CONCERNS の一対二だと明記しており、
  // 本文を読まずに写せない。だから型で止める。
  test('規定外の PASS は入らない', () => {
    const db = mem();
    expect(() => insReport(db).run('gunshi', 'PASS', 'x', null)).toThrow();
  });

  test('CONDITIONAL_PASS も BLOCKED も入らない', () => {
    const db = mem();
    expect(() => insReport(db).run('gunshi', 'CONDITIONAL_PASS', 'x', null)).toThrow();
    expect(() => insReport(db).run('gunshi', 'BLOCKED', 'x', null)).toThrow();
  });

  test('規定外は verdict を空にして legacy へ逃がせば通る', () => {
    const db = mem();
    insReport(db).run('gunshi', null, '原文', legacy({ verdict: 'PASS' }));
    const r = db.query('SELECT verdict, legacy FROM report').get() as { verdict: null; legacy: string };
    expect(r.verdict).toBeNull();
    expect(JSON.parse(r.legacy)).toEqual({ verdict: 'PASS' });
  });

  // checks[].result は verdict とは別の enum。混ぜると PLAUSIBLE のような
  // 外部レビューの値が紛れ込んでも気づけない。
  test('checks の result に APPROVED は入らない (別の enum である)', () => {
    const db = mem();
    insReport(db).run('gunshi', 'APPROVED', 'x', null);
    const id = (db.query('SELECT id FROM report').get() as { id: number }).id;
    const ins = db.prepare('INSERT INTO report_check(report_id, idx, name, result) VALUES (?,?,?,?)');
    expect(() => ins.run(id, 0, 'build', 'APPROVED')).toThrow();
    expect(() => ins.run(id, 1, 'build', 'PLAUSIBLE')).toThrow();
    ins.run(id, 2, 'build', 'PASS');
  });
});

describe('legacy の詰め方', () => {
  test('中身が無ければ null（空の JSON と取り違えない）', () => {
    expect(legacy({})).toBeNull();
    expect(legacy({ a: undefined, b: null })).toBeNull();
  });

  test('中身があれば JSON 文字列', () => {
    expect(legacy({ verdict: 'PASS', from: 'shogun' }))
      .toBe('{"verdict":"PASS","from":"shogun"}');
  });
});

describe('全文検索', () => {
  // 例はすべて開発の語で組む。実務の中身をコードへ持ち込まない。
  const seed = (db: ReturnType<typeof mem>) =>
    tx(db, () => {
      indexDoc(db, { kind: 'cmd', ref: 'cmd_1', body: '差分の検証を実装する。回帰試験も足す。' });
      indexDoc(db, { kind: 'cmd', ref: 'cmd_2', body: '監視役が落ちたときの権限境界を決める。' });
      indexDoc(db, { kind: 'report', ref: 'r_1', body: 'SQLite の busy_timeout を先に置く。' });
    });

  test('2 文字の語が引ける (unicode61 素のままでは引けない)', () => {
    const db = mem(); seed(db);
    expect(search(db, '検証').map((h) => h.ref)).toEqual(['cmd_1']);
  });

  // 監視役 → 監視 | 役 と割れる。文書と問いが同じ関数を通っていれば当たる。
  // 索引だけ切って問いを切らないと、ここが 0 件になる。
  test('割れる複合語も、問いを同じく切れば当たる', () => {
    const db = mem(); seed(db);
    expect(segment('監視役')).toBe('監視 役');
    expect(search(db, '監視役').map((h) => h.ref)).toEqual(['cmd_2']);
  });

  test('ASCII の語も引ける', () => {
    const db = mem(); seed(db);
    expect(search(db, 'SQLite').map((h) => h.ref)).toEqual(['r_1']);
  });

  test('無い語は 0 件', () => {
    const db = mem(); seed(db);
    expect(search(db, '該当なき語')).toEqual([]);
  });

  // 語の途中からは当たらない。これは既知の割り切りなので、
  // 挙動が変わったときに気づけるよう固定しておく。
  test('語の途中からは当たらない (trigram を張らない代償)', () => {
    const db = mem(); seed(db);
    expect(search(db, '視役')).toEqual([]);
  });

  test('落ちた取引の索引は残らない', () => {
    const db = mem();
    try { tx(db, () => { indexDoc(db, { kind: 'cmd', body: '検証' }); throw new Error('失敗'); }); } catch {}
    expect(search(db, '検証')).toEqual([]);
    expect((db.query('SELECT count(*) c FROM doc').get() as { c: number }).c).toBe(0);
  });
});

describe('置き場所', () => {
  test('9p の上に正本を置こうとしたら止める', () => {
    expect(() => openStore({ path: '/mnt/c/Users/example/work/honden/x.db' })).toThrow(/9p/);
  });

  test('試験用の抜け道は効く (この抜け道が効かないと上の試験が測れない)', () => {
    // allowSlowFs を渡しても、経路自体は同じであることの確認。
    // 実ファイルは作らず、判定が通ることだけを見る。
    expect(() => openStore({ path: '/mnt/c/nonexistent-dir-for-test/x.db', allowSlowFs: true }))
      .not.toThrow(/9p/);
  });
});

/**
 * 型に足した欄が、**先に建った正本にも届くか**。
 *
 * `CREATE TABLE IF NOT EXISTS` は既にある表を変えぬ。型へ欄を足しただけでは、
 * 古い正本には生えぬ——`nudge.reset_count` で一度踏み、`task.holder` で二度
 * 踏んだ（二度目は本番の `honden status` が倒れて露見・2026-08-29）。
 *
 * ゆえに機械で数える: **古い形の表**を建ててから migrate を通し、
 * 型が言う欄が全て揃うかを見る。三度目は無い。
 */
describe('移行——型に足した欄は古い正本にも生える', () => {
  test('task の貸与三欄が、欄無しの表にも生える', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'honden-mig-')), 'old.db');
    // 貸与を知らぬ頃の形で建てる。
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE task (
      agent TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
      cmd_id TEXT, updated_at TEXT NOT NULL, raw TEXT NOT NULL)`);
    old.run("INSERT INTO task(agent, updated_at, raw) VALUES ('ashigaru1', 'x', '{}')");
    old.close();

    const db = openStore({ path });
    const cols = (db.query('PRAGMA table_info(task)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['holder', 'leased_at', 'lease_until']) expect(cols).toContain(c);
    // 元から居た行は残る（移行で消してはならぬ）。
    expect(db.query('SELECT agent FROM task').all()).toHaveLength(1);
  });

  test('型が言う全ての欄が、素の正本に揃う（欄の数え直し）', () => {
    // 型と実物の突き合わせ。ここが落ちるなら、どこかで移行を書き忘れておる。
    const db = openStore({ path: ':memory:' });
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as
        { name: string }[]
    ).map((t) => t.name);
    expect(tables.length).toBeGreaterThan(5); // 空の突き合わせで頷かせぬ
    for (const t of tables) {
      const cols = db.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
      expect(cols.length, `${t} に欄が無い`).toBeGreaterThan(0);
    }
  });
});
