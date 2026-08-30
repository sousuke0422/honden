/**
 * 署名の検めの試験。
 *
 * この層の値打ちは**身元を縛ること**に尽きる。縛りが外れても cosign は
 * 何も言わず通す——*Sigstore で署名された物なら誰の物でも通る*ゆえ、
 * 「署名がある」が「我らが署名した」に化ける。
 *
 * ゆえに釘は、縛りが渡っておるかと、道具が無い時に閉じるかへ厚く打つ。
 */
import { describe, expect, test } from 'bun:test';
import { REPO } from '../src/version';
import {
  BUNDLE, IDENTITY_RE, OIDC_ISSUER, SKIP_FLAG, MIN_COSIGN, verifyArgs, signCheck, readVerify, parseCosignVersion,
} from '../src/sign';

describe('身元の縛り — ここが全て', () => {
  test('我らの release.yml が、**札から**走った物だけを認める', () => {
    const re = new RegExp(IDENTITY_RE);
    expect(re.test(`https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v1.0.0`)).toBe(true);
  });

  test('**枝から走った物は認めぬ**（枝へ書ける者が署名を作れてしまう）', () => {
    const re = new RegExp(IDENTITY_RE);
    expect(re.test(`https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main`)).toBe(false);
  });

  test('**よその repo は認めぬ**（誰でも自分の workflow で署名できる）', () => {
    const re = new RegExp(IDENTITY_RE);
    expect(re.test('https://github.com/evil/honden/.github/workflows/release.yml@refs/tags/v1.0.0')).toBe(false);
    expect(re.test(`https://github.com/${REPO}-evil/.github/workflows/release.yml@refs/tags/v1.0.0`)).toBe(false);
  });

  test('よその workflow も認めぬ（同じ repo でも別の書なら別人と見る）', () => {
    const re = new RegExp(IDENTITY_RE);
    expect(re.test(`https://github.com/${REPO}/.github/workflows/ci.yml@refs/tags/v1.0.0`)).toBe(false);
  });

  test('`.` を字として縛る（正規表現の穴を開けぬ）', () => {
    const re = new RegExp(IDENTITY_RE);
    // `github.com` の `.` を任意の一字にすると `githubXcom` が通る
    expect(re.test(`https://githubXcom/${REPO}/.github/workflows/release.yml@refs/tags/v1`)).toBe(false);
    expect(re.test(`https://github.com/${REPO}/Xgithub/workflows/release.yml@refs/tags/v1`)).toBe(false);
  });
});

describe('verifyArgs — 縛りを必ず渡す', () => {
  const a = verifyArgs('/tmp/b', '/tmp/s');

  test('身元と発行者の両方を渡す', () => {
    // **どちらか一方でも欠ければ検めにならぬ。**
    expect(a).toContain('--certificate-identity-regexp');
    expect(a).toContain(IDENTITY_RE);
    expect(a).toContain('--certificate-oidc-issuer');
    expect(a).toContain(OIDC_ISSUER);
  });

  test('束と、検める相手を渡す', () => {
    expect(a).toContain('--bundle');
    expect(a).toContain('/tmp/b');
    expect(a[a.length - 1]).toBe('/tmp/s');
    expect(a[0]).toBe('cosign');
    expect(a[1]).toBe('verify-blob');
  });

  test('発行者は GitHub Actions の OIDC だけ', () => {
    expect(OIDC_ISSUER).toBe('https://token.actions.githubusercontent.com');
  });
});

describe('signCheck — 検められぬ物は置かぬ', () => {
  test('道具があれば検める', () => {
    expect(signCheck({ hasCosign: true, skip: false, version: 'v3.1.3' })).toEqual({ kind: 'verify' });
  });

  test('**道具が無ければ断る**（「あれば検める」にせぬ）', () => {
    const r = signCheck({ hasCosign: false, skip: false });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.message).toContain('cosign');
      expect(r.message).toContain(SKIP_FLAG); // 抜け道の在り処は告げる
    }
  });

  test('**安全な道を、危うい旗より先に示す**', () => {
    const r = signCheck({ hasCosign: false, skip: false });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      // 手元で建てる道は cosign を要さぬ。これを告げねば、急ぐ者は飛ばす旗へ行く
      expect(r.message).toContain('build:all');
      expect(r.message.indexOf('build:all')).toBeLessThan(r.message.indexOf(SKIP_FLAG));
    }
  });

  test('旗が明示された時だけ飛ばし、その時は必ず警める', () => {
    const r = signCheck({ hasCosign: false, skip: true });
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.warning).toContain('壊れと途中切れ');
  });

  test('道具があっても、旗があれば飛ばす（人の断りが勝つ）', () => {
    expect(signCheck({ hasCosign: true, skip: true, version: 'v3.1.3' }).kind).toBe('skip');
  });

  test('**抜け道の旗は長く醜い**（気軽に押されては困る）', () => {
    expect(SKIP_FLAG).toBe('insecure-skip-signature');
    expect(SKIP_FLAG.length).toBeGreaterThan(20);
  });
});

describe('版の下限 — 束の形は版で変わる', () => {
  test('v3 以上なら検める', () => {
    expect(signCheck({ hasCosign: true, skip: false, version: 'v3.0.0' }).kind).toBe('verify');
    expect(signCheck({ hasCosign: true, skip: false, version: 'v3.1.3' }).kind).toBe('verify');
  });

  test('**v2 では断る**（素の apt が配るのはこちらのことがある）', () => {
    // Ubuntu 26.04 の archive は 2.6.2（殿の実測）。入れさせて検められぬのでは
    // 親切が仇になる
    const r = signCheck({ hasCosign: true, skip: false, version: 'v2.6.2' });
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.message).toContain('2.6.2');
      expect(r.message).toContain('apt');
      expect(r.message).toContain('build:all'); // 安全な道が先
    }
  });

  test('**版が読めぬ時も断る**（読めぬ物を新しいと見なさぬ）', () => {
    for (const v of [null, undefined]) {
      expect(signCheck({ hasCosign: true, skip: false, version: v }).kind).toBe('refuse');
    }
    // 形が違う版も同じ
    expect(signCheck({ hasCosign: true, skip: false, version: 'こわれた' }).kind).toBe('refuse');
  });

  test('下限は 3.0.0', () => {
    expect(MIN_COSIGN).toBe('3.0.0');
  });

  test('旗があれば版は問わぬ（人の断りが勝つ）', () => {
    expect(signCheck({ hasCosign: true, skip: true, version: 'v2.0.0' }).kind).toBe('skip');
  });
});

describe('parseCosignVersion', () => {
  test('--json の gitVersion を拾う', () => {
    expect(parseCosignVersion('{"gitVersion":"v3.1.3","goVersion":"go1.26.4"}')).toBe('v3.1.3');
  });

  test('人向けの吐き出しからも拾う（版で形が違うゆえ二つとも見る）', () => {
    expect(parseCosignVersion('cosign: A tool ...\nGitVersion:    v2.6.2\n')).toBe('v2.6.2');
  });

  test('読めねば null（推さぬ）', () => {
    expect(parseCosignVersion('')).toBeNull();
    expect(parseCosignVersion('なにか別の物')).toBeNull();
    expect(parseCosignVersion('{"gitVersion":""}')).toBeNull();
  });
});

describe('readVerify — 終了コードだけを見る', () => {
  test('通れば通る', () => {
    expect(readVerify({ ok: true }).ok).toBe(true);
  });

  test('通らねば止め、身元の縛りを添えて言う', () => {
    const r = readVerify({ ok: false, stderr: 'error: none of the entries could be verified' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('一つも置かぬ');
      expect(r.message).toContain('none of the entries');
    }
  });

  test('**文面では判ぜぬ**（版が上がった日に黙って素通りにせぬ）', () => {
    // cosign が「Verified OK」と言うても、終了コードが 0 でなければ落第
    expect(readVerify({ ok: false, stderr: 'Verified OK' }).ok).toBe(false);
  });

  test('言い分が無くとも止まる', () => {
    expect(readVerify({ ok: false }).ok).toBe(false);
  });
});

describe('束の名', () => {
  test('数の紙に対する束、一枚だけ', () => {
    // 12 本それぞれに署名しても強くはならぬ。紙を縛れば全部が縛られる
    expect(BUNDLE).toBe('SHA256SUMS.cosign.bundle');
  });
});
