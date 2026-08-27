/**
 * 布陣の外から役職を名乗って権を振るえぬこと。
 *
 * inbox write は最初からこれを塞いでいたが、**同じ防御が
 * task assign / cmd new / report qc へ配線されておらず**、外から
 * karo を名乗れば足軽へ振れた——しかも振られた報せの差出人は 'karo'
 * として受け箱に載る。inbox write が塞いだ当のものが、別の戸から
 * 入っていた（権限表の突き合わせで発覚・2026-08-28）。
 *
 * 陰陽の対をここで固める。片側だけだと、門が死んでも試験は緑になる。
 */
import { describe, expect, test } from 'bun:test';
import { mayActAs, resolve } from '../src/identity';

/** 布陣の中に居る者。pane から名乗りが引ける。 */
const inside = (id: string) =>
  resolve({ tmuxPane: '%1', agentIdEnv: undefined, lookup: () => id });

/** 布陣の外。環境変数の名乗りしか無い。 */
const outside = (id: string | undefined) =>
  resolve({ tmuxPane: '', agentIdEnv: id, lookup: () => null });

describe('布陣の外から役職を名乗れぬ', () => {
  test('外から karo を名乗って振ろうとすれば断られる', () => {
    const r = mayActAs(outside('karo'), 'karo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('布陣の外から karo');
  });

  test('外から shogun を名乗って司令を書こうとすれば断られる', () => {
    expect(mayActAs(outside('shogun'), 'shogun').ok).toBe(false);
  });

  test('外から gunshi を名乗って検めを出そうとすれば断られる', () => {
    expect(mayActAs(outside('gunshi'), 'gunshi').ok).toBe(false);
  });
});

describe('塞ぎすぎておらぬ（門が邪魔者にならぬこと）', () => {
  test('布陣の中の家老は通る', () => {
    expect(mayActAs(inside('karo'), 'karo').ok).toBe(true);
  });

  test('布陣の中の将軍は通る', () => {
    expect(mayActAs(inside('shogun'), 'shogun').ok).toBe(true);
  });

  test('外から別の名（review_session 等）を名乗る分には、この門は通す', () => {
    // その先で「karo だけである」と弾かれる。二重に断る必要は無い。
    expect(mayActAs(outside('review_session'), 'karo').ok).toBe(true);
  });

  test('名乗りが無い者も、この門は通す（先の門が弾く）', () => {
    expect(mayActAs(outside(undefined), 'karo').ok).toBe(true);
  });
});

describe('名乗りの出所そのもの', () => {
  test('布陣の中では pane が勝ち、環境変数では上書きできぬ', () => {
    const id = resolve({ tmuxPane: '%1', agentIdEnv: 'shogun', lookup: () => 'ashigaru1' });
    expect(id.id).toBe('ashigaru1');
    expect(id.insideFormation).toBe(true);
  });

  test('pane が引けなんだ時は環境変数へ落ちぬ（他人を名乗る道を塞ぐ）', () => {
    const id = resolve({ tmuxPane: '%1', agentIdEnv: 'karo', lookup: () => null });
    expect(id.id).toBeUndefined();
  });
});
