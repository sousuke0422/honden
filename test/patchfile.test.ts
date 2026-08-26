/**
 * ファイルへ差分を当てる試験。
 *
 * 眼目は `str.replace` との差にある——**曖昧なら断ること**、
 * そして**全部当たるか何も書かないか**。
 */

import { expect, test, describe } from 'bun:test';
import { patchFiles } from '../src/patchfile';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = (s: string) => s.replace(/^\n/, '');

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'honden-patchfile-'));
  for (const [p, body] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

describe('当てる', () => {
  test('当たれば書く', () => {
    const root = tree({ 'a.txt': ['一行目', '二行目', '三行目'].join('\n') });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 一行目
-二行目
+改めた二行目
 三行目
`), { root });
    expect(r.ok).toBe(true);
    expect(read(root, 'a.txt')).toContain('改めた二行目');
    rmSync(root, { recursive: true, force: true });
  });

  test('--dry-run では書かぬ', () => {
    const body = ['一行目', '二行目'].join('\n');
    const root = tree({ 'a.txt': body });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 一行目
-二行目
+改めた
`), { root, dryRun: true });
    expect(r.ok).toBe(true);
    expect(read(root, 'a.txt')).toBe(body);
    expect(r.out).toContain('まだ書いておらぬ');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('断る', () => {
  test('思っておる中身と違えば断る', () => {
    const body = ['一行目', '二行目'].join('\n');
    const root = tree({ 'a.txt': body });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 在りもせぬ行
-二行目
+改めた
`), { root });
    expect(r.ok).toBe(false);
    expect(read(root, 'a.txt')).toBe(body);
    rmSync(root, { recursive: true, force: true });
  });

  test('文脈が二箇所にあり番号も外れておれば断る（str.replace との差）', () => {
    // str.replace なら両方書き換わる。ここでは断る。
    const body = ['同じ行', '狭間', '同じ行'].join('\n');
    const root = tree({ 'a.txt': body });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -99,1 +99,2 @@
 同じ行
+足す
`), { root });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('2 箇所');
    expect(read(root, 'a.txt')).toBe(body);
    rmSync(root, { recursive: true, force: true });
  });

  test('宛先が無ければ断る。差分で新しいファイルは作らぬ', () => {
    const root = tree({ 'a.txt': '中身' });
    const r = patchFiles(D(`
--- a/そのような.txt
+++ b/そのような.txt
@@ -1,1 +1,1 @@
-旧
+新
`), { root });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('宛先が無い');
    rmSync(root, { recursive: true, force: true });
  });

  test('木の外は当てられぬ', () => {
    const root = tree({ 'a.txt': '中身' });
    const r = patchFiles(D(`
--- a/../そと.txt
+++ b/../そと.txt
@@ -1,1 +1,1 @@
-旧
+新
`), { root });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('木の外');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('全部当たるか、何も書かぬか', () => {
  test('二本のうち一本が当たらねば、当たる方も書かぬ', () => {
    const a = ['一行目'].join('\n');
    const b = ['別の一行目'].join('\n');
    const root = tree({ 'a.txt': a, 'b.txt': b });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-一行目
+改めた
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-在りもせぬ行
+改めた
`), { root });
    expect(r.ok).toBe(false);
    // 半端な状態がディスクに残っておらぬこと
    expect(read(root, 'a.txt')).toBe(a);
    expect(read(root, 'b.txt')).toBe(b);
    rmSync(root, { recursive: true, force: true });
  });

  test('二本とも当たれば二本とも書く', () => {
    const root = tree({ 'a.txt': '一行目', 'b.txt': '別の一行目' });
    const r = patchFiles(D(`
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-一行目
+改めた
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-別の一行目
+別を改めた
`), { root });
    expect(r.ok).toBe(true);
    expect(read(root, 'a.txt')).toBe('改めた');
    expect(read(root, 'b.txt')).toBe('別を改めた');
    expect(r.changed?.length).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
