/**
 * 合図の錠の試験。
 *
 * 芯は次の signal が来れば前の子が終わる前に新しい子を起こす。二つの
 * `honden nudge` が同時に走ると、どちらも相手が書く前に状態を読み、
 * `REPEAT_MS` も段の照合も揃って素通りする——**書かれた跡を見て判ずる
 * 仕掛けは、書かれる前に読まれると効かぬ**。
 *
 * 実害を見た（2026-08-28 一巡試験）: 文脈消し `/new-chat` が一秒のうちに
 * 二度飛んだ。一度で足りるものを二度撃てば、立て直しかけた文脈をもう一度潰す。
 */
import { describe, expect, test } from 'bun:test';
import { withNudgeLock } from '../src/nudge';
import { mkdtempSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lock = () => join(mkdtempSync(join(tmpdir(), 'nudgelock-')), 'x.lock');

describe('一つだけ通す', () => {
  test('空いておれば通り、中身を返す', () => {
    expect(withNudgeLock(lock(), () => 'done')).toBe('done');
  });

  test('**入れ子は通さぬ**——二人目は null で退く', () => {
    const p = lock();
    const inner = withNudgeLock(p, () => withNudgeLock(p, () => 'inner'));
    expect(inner).toBeNull(); // 外は通り、内が退いた
  });

  test('抜けた後は次の者が通る（錠を握りっぱなしにせぬ）', () => {
    const p = lock();
    expect(withNudgeLock(p, () => 'first')).toBe('first');
    expect(withNudgeLock(p, () => 'second')).toBe('second');
  });

  test('中で倒れても錠は返る——**握ったまま死ねば以後ずっと撃てぬ**', () => {
    const p = lock();
    expect(() =>
      withNudgeLock(p, () => {
        throw new Error('倒れた');
      }),
    ).toThrow('倒れた');
    expect(existsSync(p)).toBe(false);
    expect(withNudgeLock(p, () => '次は通る')).toBe('次は通る');
  });
});

describe('古い錠は奪う', () => {
  test('撃ち手が死んだ跡（古い錠）なら奪って通る', () => {
    const p = lock();
    writeFileSync(p, '99999');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(p, old, old);
    expect(withNudgeLock(p, () => '奪った')).toBe('奪った');
  });

  test('新しい錠は奪わぬ（生きておる撃ち手を踏まぬ）', () => {
    const p = lock();
    writeFileSync(p, '99999');
    const fresh = new Date(); utimesSync(p, fresh, fresh);
    expect(withNudgeLock(p, () => '奪った')).toBeNull();
  });

  test('古さの境は渡せる', () => {
    const p = lock();
    writeFileSync(p, '1');
    const t = new Date(Date.now() - 5_000);
    utimesSync(p, t, t);
    expect(withNudgeLock(p, () => 'x', { staleMs: 10_000 })).toBeNull(); // まだ新しい
    expect(withNudgeLock(p, () => 'x', { staleMs: 1_000 })).toBe('x'); // もう古い
  });
});
