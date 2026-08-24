/**
 * 取り込みの試験。
 *
 * honden が単体で動くまで取り込みは何度も走るので、
 * ここで確かめるのは「何度走らせても同じ結果になること」が中心になる。
 */

import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, search } from '../src/store';
import { importTree, importFile, collectYaml } from '../src/import';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'honden-import-'));
  mkdirSync(join(root, 'queue', 'tasks'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, body: string) => writeFileSync(join(root, rel), body, 'utf8');
const mem = () => openStore({ path: ':memory:' });
const counts = (db: ReturnType<typeof mem>) => ({
  doc: (db.query('SELECT count(*) c FROM doc').get() as { c: number }).c,
  fts: (db.query('SELECT count(*) c FROM doc_fts').get() as { c: number }).c,
  src: (db.query('SELECT count(*) c FROM source').get() as { c: number }).c,
});

describe('繰り返し取り込み', () => {
  test('二度目は何も足さない (足すだけの造りなら doc が倍になる)', () => {
    put('queue/tasks/a.yaml', 'agent: ashigaru1\nstatus: assigned\n');
    const db = mem();
    const first = importTree(db, root, ['queue']);
    expect(first.imported).toBe(1);
    expect(counts(db)).toEqual({ doc: 1, fts: 1, src: 1 });

    const second = importTree(db, root, ['queue']);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(counts(db)).toEqual({ doc: 1, fts: 1, src: 1 });
  });

  test('中身が変われば入れ替わる (増えない)', () => {
    put('queue/tasks/a.yaml', 'status: 検証\n');
    const db = mem();
    importTree(db, root, ['queue']);
    expect(search(db, '検証').length).toBe(1);

    put('queue/tasks/a.yaml', 'status: 実装\n');
    const r = importTree(db, root, ['queue']);
    expect(r.imported).toBe(1);
    expect(counts(db)).toEqual({ doc: 1, fts: 1, src: 1 });
    // 古い本文が索引に残っていないこと。残ると検索が過去を返し続ける。
    expect(search(db, '検証').length).toBe(0);
    expect(search(db, '実装').length).toBe(1);
  });

  test('三度走らせても件数は変わらない', () => {
    put('queue/tasks/a.yaml', 'status: 検証\n');
    put('queue/tasks/b.yaml', 'status: 実装\n');
    const db = mem();
    for (let i = 0; i < 3; i++) importTree(db, root, ['queue']);
    expect(counts(db)).toEqual({ doc: 2, fts: 2, src: 2 });
  });
});

describe('読めないもの', () => {
  test('YAML として読めなくても本文は取り込み、記録を残す', () => {
    put('queue/tasks/broken.yaml', 'a: 1\n  b: 2\n c: 3\n'); // 字下げが壊れている
    const db = mem();
    const r = importTree(db, root, ['queue']);
    expect(r.issues.map((i) => i.kind)).toEqual(['parse']);
    // 本文は入っている。構造化より先に、引ける状態にすることを優先する。
    expect(counts(db).doc).toBe(1);
    const rec = db.query('SELECT kind FROM import_issue').all() as { kind: string }[];
    expect(rec).toEqual([{ kind: 'parse' }]);
  });

  test('NUL が混じったファイルは記録して取り込まない', () => {
    put('queue/tasks/nul.yaml', 'a: 1\n\0\nb: 2\n');
    const db = mem();
    const r = importTree(db, root, ['queue']);
    expect(r.issues[0]?.kind).toBe('encoding');
    expect(counts(db).doc).toBe(0);
  });

  test('1 本読めなくても他は入る (全体が止まらない)', () => {
    put('queue/tasks/ok.yaml', 'status: 検証\n');
    put('queue/tasks/nul.yaml', 'a\0b');
    const db = mem();
    const r = importTree(db, root, ['queue']);
    expect(r.scanned).toBe(2);
    expect(r.imported).toBe(1);
    expect(r.issues.length).toBe(1);
    expect(search(db, '検証').length).toBe(1);
  });

  test('直れば記録は消える (直したのに残り続けない)', () => {
    put('queue/tasks/x.yaml', 'a\0b');
    const db = mem();
    importTree(db, root, ['queue']);
    expect((db.query('SELECT count(*) c FROM import_issue').get() as { c: number }).c).toBe(1);

    put('queue/tasks/x.yaml', 'status: 実装\n');
    importTree(db, root, ['queue']);
    expect((db.query('SELECT count(*) c FROM import_issue').get() as { c: number }).c).toBe(0);
  });
});

describe('残っている難あり', () => {
  // 実データで踏んだ穴: 1 回目は 8 件出たのに 2 回目は 1 件に見えた。
  // sha256 が変わっていないファイルは素通りするので、当たった件数だけを見ると
  // 残りが消えたように見える。outstanding は表を数えるので減らない。
  test('二度目でも残数は減らない', () => {
    put('queue/tasks/ok.yaml', 'status: 検証\n');
    put('queue/tasks/broken.yaml', 'a: 1\n  b: 2\n c: 3\n');
    const db = mem();

    const first = importTree(db, root, ['queue']);
    expect(first.issues.length).toBe(1);
    expect(first.outstanding).toBe(1);

    const second = importTree(db, root, ['queue']);
    expect(second.issues.length).toBe(0); // 素通りしたので当たらない
    expect(second.outstanding).toBe(1); // だが残っている
  });

  test('直せば残数も減る', () => {
    put('queue/tasks/broken.yaml', 'a: 1\n  b: 2\n c: 3\n');
    const db = mem();
    expect(importTree(db, root, ['queue']).outstanding).toBe(1);
    put('queue/tasks/broken.yaml', 'a: 1\n');
    expect(importTree(db, root, ['queue']).outstanding).toBe(0);
  });
});

describe('集め方', () => {
  // 2026-08-25: readdirSync の withFileTypes は 9p の上で嘘をつく。
  // queue 直下で inbox だけがファイルと報告され、配下 10 本が取り込みからも
  // 索引からも初めから漏れていた。エラーは出ず 0 件になるだけ。
  //
  // ただし断っておくと、**この試験はその欠陥を検出しない**。試験は /tmp
  // (ext4) で走り、そこでは withFileTypes が正しく動く。statSync へ戻しても
  // 緑のままになる。ここで固定しているのは「入れ子を取りこぼさない」という
  // 意図であって、9p の嘘そのものではない。
  //
  // 嘘のほうは実データで確かめた。statSync へ切り替えたら
  // inbox の取り込みが 0 件から 145 件になった。
  test('入れ子のディレクトリを取りこぼさぬ', () => {
    mkdirSync(join(root, 'queue', 'inbox'), { recursive: true });
    mkdirSync(join(root, 'queue', 'a', 'b', 'c'), { recursive: true });
    put('queue/inbox/karo.yaml', 'messages: []\n');
    put('queue/tasks/x.yaml', 'x: 1\n');
    put('queue/a/b/c/deep.yaml', 'x: 1\n');
    const found = collectYaml(join(root, 'queue'));
    expect(found.length).toBe(3);
    expect(found.filter((p) => p.includes('/inbox/')).length).toBe(1);
    expect(found.filter((p) => p.includes('/c/')).length).toBe(1);
  });

  test('yaml でないものは拾わぬ', () => {
    put('queue/tasks/x.yaml', 'x: 1\n');
    put('queue/tasks/x.yaml.lock', '');
    put('queue/tasks/readme.md', '#');
    expect(collectYaml(join(root, 'queue')).length).toBe(1);
  });
});

describe('分類', () => {
  test('置き場所から kind が決まる', () => {
    mkdirSync(join(root, 'queue', 'inbox'), { recursive: true });
    mkdirSync(join(root, 'queue', 'archive'), { recursive: true });
    put('queue/tasks/a.yaml', 'x: 1\n');
    put('queue/inbox/b.yaml', 'x: 1\n');
    put('queue/archive/c.yaml', 'x: 1\n');
    const db = mem();
    importTree(db, root, ['queue']);
    const kinds = (db.query('SELECT kind FROM doc ORDER BY kind').all() as { kind: string }[]).map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(['archive', 'inbox', 'task']);
  });
});

describe('台帳', () => {
  test('取り込みは台帳に残り、変更は update として区別される', () => {
    put('queue/tasks/a.yaml', 'x: 1\n');
    const db = mem();
    importTree(db, root, ['queue']);
    put('queue/tasks/a.yaml', 'x: 2\n');
    importTree(db, root, ['queue']);
    const acts = (db.query('SELECT action FROM ledger ORDER BY id').all() as { action: string }[]).map(
      (r) => r.action,
    );
    expect(acts).toEqual(['source.add', 'source.update']);
  });

  test('触らなかったファイルは台帳を汚さない', () => {
    put('queue/tasks/a.yaml', 'x: 1\n');
    const db = mem();
    importTree(db, root, ['queue']);
    importTree(db, root, ['queue']);
    importTree(db, root, ['queue']);
    expect((db.query('SELECT count(*) c FROM ledger').get() as { c: number }).c).toBe(1);
  });
});
