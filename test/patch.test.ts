/**
 * 差分を当てる試験。
 *
 * 眼目は「当たること」ではなく **「当たらぬ時に断ること」**。
 * 丸ごと置き換えは何が在ったかについて何も主張せぬが、差分は主張する。
 * その主張が外れた時に黙って通せば、差分で受ける値打ちが消える。
 */

import { expect, test, describe } from 'bun:test';
import { parseUnified, applyHunks } from '../src/patch';

const BODY = ['一行目', '二行目', '三行目', '四行目'].join('\n');
const D = (s: string) => s.replace(/^\n/, '');

describe('解く', () => {
  test('欄の名は +++ 側から採る', () => {
    const r = parseUnified(D(`
--- a/command
+++ b/command
@@ -1,2 +1,2 @@
 一行目
-二行目
+改めた二行目
`));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patches[0]!.field).toBe('command');
      expect(r.patches[0]!.hunks.length).toBe(1);
    }
  });

  test('--- / +++ が無ければ断る。どの欄か分からぬゆえ', () => {
    const r = parseUnified('@@ -1,1 +1,1 @@\n-a\n+b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('どの欄');
  });

  test('差分の体を成しておらねば断る', () => {
    // --- も +++ も @@ も無い、ただの文章
    const r = parseUnified('これは差分ではない。ただの文章である。');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('どの欄');
    expect(parseUnified('').ok).toBe(false);
  });

  test('@@ が無ければ断る', () => {
    const r = parseUnified('--- a/command\n+++ b/command\n');
    expect(r.ok).toBe(false);
  });

  test('読めぬ行があれば断る', () => {
    const r = parseUnified('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\nこれは印の無い行');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('読めぬ行');
  });

  test('複数の欄を一度に受ける', () => {
    const r = parseUnified(D(`
--- a/purpose
+++ b/purpose
@@ -1,1 +1,1 @@
-旧
+新
--- a/command
+++ b/command
@@ -1,1 +1,1 @@
-旧
+新
`));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patches.map((p) => p.field)).toEqual(['purpose', 'command']);
  });
});

describe('当てる', () => {
  const hunks = (s: string) => {
    const r = parseUnified(s);
    if (!r.ok) throw new Error(r.message);
    return r.patches[0]!.hunks;
  };

  test('置き換わる', () => {
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -1,3 +1,3 @@
 一行目
-二行目
+改めた二行目
 三行目
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toBe(['一行目', '改めた二行目', '三行目', '四行目'].join('\n'));
  });

  test('行番号がずれておっても、文脈が一箇所に定まれば当たる', () => {
    // 手で書いた差分は @@ の数がずれる。そこで断ると使い物にならぬ。
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -99,3 +99,3 @@
 三行目
-四行目
+改めた四行目
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toContain('改めた四行目');
  });

  test('文脈が見つからねば断る。何も変えぬ', () => {
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 そのような行は無い
-二行目
+改めた
`)), 'x');
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.message).toContain('見つからぬ');
      expect(got.message).toContain('何も変えておらぬ');
    }
  });

  test('行番号が合えばそこで決まる。他所に同じ文脈があってもよい', () => {
    // 番号が合っておるなら、書いた者はそこを指しておる。
    const dup = ['同じ行', '狭間', '同じ行'].join('\n');
    const got = applyHunks(dup, hunks(D(`
--- a/x
+++ b/x
@@ -1,1 +1,2 @@
 同じ行
+足す
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text.split('\n')).toEqual(['同じ行', '足す', '狭間', '同じ行']);
  });

  test('番号が外れ、同じ文脈が二箇所にあれば断る', () => {
    // 探しに行った時だけ曖昧さが問われる。曖昧なまま当てると、
    // 書いた者の意図しておらぬ所を直す。
    const dup = ['同じ行', '狭間', '同じ行'].join('\n');
    const got = applyHunks(dup, hunks(D(`
--- a/x
+++ b/x
@@ -99,1 +99,2 @@
 同じ行
+足す
`)), 'x');
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.message).toContain('2 箇所');
      expect(got.message).toContain('文脈の行を増やして');
    }
  });

  test('複数の hunk が一度に当たる', () => {
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-一行目
+改めた一行目
@@ -4,1 +4,1 @@
-四行目
+改めた四行目
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text).toBe(['改めた一行目', '二行目', '三行目', '改めた四行目'].join('\n'));
  });

  test('後ろの hunk から当てる。前から当てると後ろの位置がずれる', () => {
    // 前の hunk が行を増やすと、後ろの hunk の行番号が狂う。
    // 同じ文脈が他所にもある本文では、狂った番号のせいで
    // 探しに行くはめになり、曖昧として断られる。
    const body = ['A', 'X', 'B', 'X'].join('\n');
    const got = applyHunks(body, hunks(D(`
--- a/x
+++ b/x
@@ -1,1 +1,2 @@
 A
+足した行
@@ -2,1 +2,1 @@
-X
+Y
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text.split('\n')).toEqual(['A', '足した行', 'Y', 'B', 'X']);
  });

  test('一つでも当たらねば、他も当てぬ', () => {
    // 半分当たった状態を残さぬこと
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-一行目
+改めた一行目
@@ -4,1 +4,1 @@
-そのような行は無い
+改めた
`)), 'x');
    expect(got.ok).toBe(false);
  });

  test('足すだけの hunk も当たる', () => {
    const got = applyHunks(BODY, hunks(D(`
--- a/x
+++ b/x
@@ -2,1 +2,2 @@
 二行目
+足した行
`)), 'x');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.text.split('\n')).toEqual(['一行目', '二行目', '足した行', '三行目', '四行目']);
  });
});
