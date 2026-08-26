/**
 * 設定を読む狭い口の試験。
 *
 * 眼目は**狭さ**にある。汎用の YAML 読み口にすると、それが honden を
 * 迂回する道になる——誰かが queue の YAML を直に読み、honden の門を通らなくなる。
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { setSetting } from '../src/settings';
import { get, load, dig, SETTINGS_PATH_KEY } from '../src/config';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const YAML = [
  'language: ja',
  'cli:',
  '  agents:',
  '    karo:',
  '      type: cursor',
  '      model: auto',
  '    ashigaru1:',
  '      type: claude',
  'list:',
  '  - 一つ目',
  '  - 二つ目',
  'empty:',
].join('\n');

function withSettings(): { db: ReturnType<typeof openStore>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'honden-config-'));
  const p = join(dir, 'settings.yaml');
  writeFileSync(p, YAML);
  const db = openStore({ path: ':memory:' });
  tx(db, () => setSetting(db, SETTINGS_PATH_KEY, p, 'roster'));
  return { db, dir };
}

describe('在り処', () => {
  test('覚えておらねば読めぬ。ここでファイルは取らぬ', () => {
    const db = openStore({ path: ':memory:' });
    const r = load(db);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('roster sync');
      // なぜ狭くしておるかが読んで分かること
      expect(r.message).toContain('迂回');
    }
  });

  test('覚えておれば読める', () => {
    const { db, dir } = withSettings();
    expect(load(db).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('引く', () => {
  test('値を飾らずに返す', () => {
    const { db, dir } = withSettings();
    expect(get(db, 'cli.agents.karo.type').value).toBe('cursor');
    expect(get(db, 'language').value).toBe('ja');
    rmSync(dir, { recursive: true, force: true });
  });

  test('一覧は添字で引ける', () => {
    const { db, dir } = withSettings();
    expect(get(db, 'list.1').value).toBe('二つ目');
    rmSync(dir, { recursive: true, force: true });
  });

  test('空の値は空文字', () => {
    const { db, dir } = withSettings();
    const r = get(db, 'empty');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  test('無い鍵は、どこで途切れたかを言う', () => {
    const { db, dir } = withSettings();
    const r = get(db, 'cli.agents.ashigaru9.type');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('cli.agents.ashigaru9 で途切れた');
    rmSync(dir, { recursive: true, force: true });
  });

  test('鍵が空なら断る', () => {
    const { db, dir } = withSettings();
    expect(get(db, '').ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('枝は返さぬ', () => {
  test('枝を求められたら断り、下に在るものだけ示す', () => {
    // 枝を YAML や JSON で返すと、受け取った shell がそれを解きにかかる。
    // 解く仕事を shell へ戻してしまう——それが venv の要る理由であった。
    const { db, dir } = withSettings();
    const r = get(db, 'cli.agents');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('まだ枝');
    expect(r.message).toContain('karo');
    // 中身そのものは出しておらぬこと
    expect(r.message).not.toContain('cursor');
    rmSync(dir, { recursive: true, force: true });
  });

  test('一覧も枝として扱う', () => {
    const { db, dir } = withSettings();
    expect(get(db, 'list').ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('道を辿る', () => {
  test('数字は一覧の添字', () => {
    expect(dig({ a: ['x', 'y'] }, 'a.1')).toEqual({ kind: 'scalar', value: 'y' });
  });
  test('範囲の外は無し', () => {
    expect(dig({ a: ['x'] }, 'a.5').kind).toBe('none');
  });
  test('scalar の先へは進めぬ', () => {
    expect(dig({ a: 'x' }, 'a.b').kind).toBe('none');
  });
});
