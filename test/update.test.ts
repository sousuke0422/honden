/**
 * 更新の試験。
 *
 * ここは**外から来た実行可能な物を置く**層である。判断を一つ誤れば、
 * 検めを通らぬ物が `bin/` に座る。ゆえに釘は「置かぬ」側へ厚く打つ。
 */
import { describe, expect, test } from 'bun:test';
import { VERSION, REPO, parseVersion, isNewer } from '../src/version';
import {
  BINARIES, SUMS, platformOf, assetName, parseSums, planFor, decide, tagFrom, verify,
  releaseApiUrl, assetUrl,
} from '../src/update';

describe('版の比べ', () => {
  test('数の並びへ解ける（v は付いても付かなくても）', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v1.2.3-rc1')).toEqual([1, 2, 3]);
  });

  test('形が違えば解かぬ', () => {
    for (const s of ['', 'latest', 'v1.2', 'v1.2.3.4x', 'main']) expect(parseVersion(s)).toBeNull();
  });

  test('段ごとに比べる（10 > 9 を字で誤らぬ）', () => {
    expect(isNewer('v0.10.0', 'v0.9.0')).toBe(true);
    expect(isNewer('v1.0.0', 'v0.99.99')).toBe(true);
    expect(isNewer('v0.1.1', 'v0.1.0')).toBe(true);
  });

  test('同じなら新しくない', () => {
    expect(isNewer('v1.2.3', '1.2.3')).toBe(false);
  });

  test('**解けぬ版は新しくないと見る**（壊れた札一つで全員降ろさぬ）', () => {
    expect(isNewer('latest', '0.1.0')).toBe(false);
    expect(isNewer('v9.9.9', 'こわれた')).toBe(false);
  });
});

describe('decide — 降りるべきか', () => {
  test('新しい札があれば降りる', () => {
    expect(decide('v99.0.0')).toEqual({ kind: 'update', tag: 'v99.0.0' });
  });

  test('同じなら何もせぬ', () => {
    expect(decide(`v${VERSION}`).kind).toBe('current');
  });

  test('**己のほうが新しければ被せぬ**（手元で建てて先へ進んでおる時）', () => {
    expect(decide('v0.0.1')).toEqual({ kind: 'ahead', latest: 'v0.0.1' });
  });

  test('札が取れなんだら、分からぬと言う（黙って現状維持にせぬ）', () => {
    expect(decide(null).kind).toBe('unknown');
  });
});

describe('tagFrom', () => {
  test('拾う', () => {
    expect(tagFrom({ tag_name: 'v1.0.0' })).toBe('v1.0.0');
  });
  test('形が違えば null', () => {
    for (const j of [null, {}, { tag_name: '' }, { tag_name: 42 }, '文字列']) expect(tagFrom(j)).toBeNull();
  });
});

describe('土地', () => {
  test('分かる土地', () => {
    expect(platformOf({ platform: 'linux', arch: 'x64' })).toEqual({ os: 'linux', arch: 'x64' });
    expect(platformOf({ platform: 'darwin', arch: 'arm64' })).toEqual({ os: 'darwin', arch: 'arm64' });
  });

  test('**知らぬ土地には当て推量で渡さぬ**', () => {
    expect(platformOf({ platform: 'win32', arch: 'x64' })).toBeNull();
    expect(platformOf({ platform: 'linux', arch: 'ia32' })).toBeNull();
  });

  test('配り物の名', () => {
    expect(assetName('honden-watch', { os: 'linux', arch: 'arm64' })).toBe('honden-watch-linux-arm64');
  });
});

describe('取りに行く先 — 出所を固定する', () => {
  test('出し物の口も配り物の口も REPO の下だけ', () => {
    expect(releaseApiUrl()).toBe(`https://api.github.com/repos/${REPO}/releases/latest`);
    expect(assetUrl('v1.0.0', 'honden-linux-x64')).toBe(
      `https://github.com/${REPO}/releases/download/v1.0.0/honden-linux-x64`,
    );
  });

  test('札や名に妙な字があっても道を跨がせぬ', () => {
    const u = assetUrl('../../evil', 'a/b');
    expect(u).not.toContain('../');
    expect(u.startsWith(`https://github.com/${REPO}/releases/download/`)).toBe(true);
  });
});

describe('planFor — 四つとも取る', () => {
  test('binary は四つ、数の紙も一枚', () => {
    const p = planFor('v1.0.0', { os: 'linux', arch: 'x64' });
    expect(p.items.map((i) => i.name)).toEqual([...BINARIES]);
    expect(p.items[0]!.asset).toBe('honden-linux-x64');
    expect(p.sumsUrl).toContain(SUMS);
    expect(p.current).toBe(VERSION);
  });
});

describe('parseSums', () => {
  const good = `abc${'0'.repeat(61)}  honden-linux-x64\n${'f'.repeat(64)}  honden-watch-linux-x64\n`;

  test('読める', () => {
    const r = parseSums(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sums.get('honden-linux-x64')).toBe(`abc${'0'.repeat(61)}`);
  });

  test('空行と注記は飛ばす', () => {
    const r = parseSums(`# 覚え\n\n${good}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sums.size).toBe(2);
  });

  test('`*` 付き（binary 扱い）も読む', () => {
    const r = parseSums(`${'a'.repeat(64)}  *honden-linux-x64\n`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sums.has('honden-linux-x64')).toBe(true);
  });

  test('**形が違う行は黙って捨てぬ**（捨てれば「無い」理由が辿れぬ）', () => {
    const r = parseSums(`${'a'.repeat(64)}  ok\nこれは数ではない\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('2 行目');
  });

  test('空なら落第（無い物を通さぬ）', () => {
    expect(parseSums('').ok).toBe(false);
    expect(parseSums('\n# 注記だけ\n').ok).toBe(false);
  });
});

describe('verify — 一つでも違えば一つも置かぬ', () => {
  const sums = new Map([['honden-linux-x64', 'a'.repeat(64)], ['honden-watch-linux-x64', 'b'.repeat(64)]]);

  test('揃って合えば通る', () => {
    expect(verify([{ asset: 'honden-linux-x64', sha256: 'A'.repeat(64) }], sums).ok).toBe(true); // 大小は問わぬ
  });

  test('数が違えば止める', () => {
    const r = verify([{ asset: 'honden-linux-x64', sha256: 'c'.repeat(64) }], sums);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('数が違う');
  });

  test('**紙に載っておらぬ物は通さぬ**（載せ忘れを「無検査で通す」にせぬ）', () => {
    const r = verify([{ asset: 'honden-parse-linux-x64', sha256: 'a'.repeat(64) }], sums);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('載っておらぬ');
  });

  test('駄目な物が二つあれば二つとも言う（一つ直して次で躓かぬ）', () => {
    const r = verify(
      [{ asset: 'honden-linux-x64', sha256: 'c'.repeat(64) }, { asset: 'よそ者', sha256: 'd'.repeat(64) }],
      sums,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('honden-linux-x64');
      expect(r.message).toContain('よそ者');
    }
  });
});
