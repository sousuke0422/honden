/**
 * 入口の試験。
 *
 * 影の段では shogun 側へ書かないことが前提になるので、
 * 「読むだけであること」と「難ありを黙って 0 で返さぬこと」を中心に見る。
 */

import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport, runSearch } from '../src/main';
import { EXIT_OK, EXIT_INVALID } from '../src/cli';

let root: string;
let dbDir: string;
let db: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'honden-main-'));
  dbDir = mkdtempSync(join(tmpdir(), 'honden-db-'));
  db = join(dbDir, 'x.db');
  mkdirSync(join(root, 'queue', 'tasks'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const put = (rel: string, body: string) => writeFileSync(join(root, rel), body, 'utf8');

describe('import', () => {
  test('取り込んで件数を出す', () => {
    put('queue/tasks/a.yaml', 'status: 検証\n');
    const r = runImport(db, root, ['queue']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('取込 1');
  });

  test('難ありが残っていれば非ゼロで終わる (黙って 0 を返さぬ)', () => {
    put('queue/tasks/broken.yaml', 'a: 1\n  b: 2\n c: 3\n');
    const r = runImport(db, root, ['queue']);
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.out).toContain('難あり 1 件');
  });

  test('二度目も、当たった数ではなく残っている数で判ずる', () => {
    put('queue/tasks/broken.yaml', 'a: 1\n  b: 2\n c: 3\n');
    runImport(db, root, ['queue']);
    const second = runImport(db, root, ['queue']);
    // sha256 が同じなので当たった件数は 0 になる。だが残っているので非ゼロ。
    expect(second.out).toContain('この回で当たったのは 0 件');
    expect(second.code).toBe(EXIT_INVALID);
  });

  test('shogun 側のファイルを書き換えない (影の段の前提)', () => {
    put('queue/tasks/a.yaml', 'status: 検証\n');
    const before = readdirSync(join(root, 'queue', 'tasks'));
    runImport(db, root, ['queue']);
    runImport(db, root, ['queue']);
    expect(readdirSync(join(root, 'queue', 'tasks'))).toEqual(before);
    expect(Bun.file(join(root, 'queue/tasks/a.yaml')).size).toBe(
      Buffer.byteLength('status: 検証\n'),
    );
  });
});

describe('search', () => {
  test('取り込んだものが引ける', () => {
    put('queue/tasks/a.yaml', 'title: 監視役の権限境界を決める\n');
    runImport(db, root, ['queue']);
    const r = runSearch(db, '監視役', 20);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('1 件');
    expect(r.out).toContain('queue/tasks/a.yaml');
  });

  test('見つからぬときは、引けぬ理由も添える', () => {
    runImport(db, root, ['queue']);
    const r = runSearch(db, '該当なき語', 20);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('語の途中からは当たらぬ');
    expect(r.out).toContain('honden import');
  });

  test('語が無ければ書き方を見せて弾く', () => {
    const r = runSearch(db, '   ', 20);
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('honden search');
  });
});
