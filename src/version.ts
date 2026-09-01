/**
 * この版。**一箇所で決める。**
 *
 * `package.json` と札（git tag）にも同じ数が要るが、**正はここ**とする。
 * 建てた本体は package.json を抱えて歩かぬゆえ、走っておる物に己の版を
 * 訊けるのはここだけである。
 *
 * 出す側（.github/workflows/release.yml）が札とこの数の一致を検め、
 * 食い違えば出さぬ。**人が揃えるのではなく、機械が拒む形にする**——
 * 揃え忘れは必ず起きるが、拒まれれば気づく。
 */
export const VERSION = '0.1.0-rc.2';

/** 出す先。更新はここからしか取らぬ。 */
export const REPO = 'sousuke0422/honden';

/**
 * 版の中身。SemVer 2.0.0 の形に従う。
 *
 * `pre` は `-` の後を `.` で割った並び。数だけの札は数として、
 * 字を含む札は字として比べる（順序の決まりが違うゆえ、型で分けておく）。
 * `build`（`+` の後）は**比べに与らぬ**——同じ版を別々に建てただけである。
 */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

// 頭の 0 を許さぬ（SemVer が禁じておる）。`01.2.3` のような札は
// 「解けぬ」に倒す——読み方が二通りある物を当てずっぽうで読まぬため。
const NUM = '0|[1-9]\\d*';
const RE = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})` +
    `(?:-((?:[0-9A-Za-z-]+)(?:\\.[0-9A-Za-z-]+)*))?` +
    `(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

/** 数だけで、かつ頭に 0 が付いておらぬか。 */
const numericId = (s: string): boolean => /^(?:0|[1-9]\d*)$/.test(s);

/**
 * 版を解く。**解けぬ形は `null`。**
 *
 * 部分一致では読まぬ。`v1.2.3.4` や `v1.2.3-` のような、形として
 * 定まっておらぬ物を「だいたい 1.2.3」と読めば、比べた答えが嘘になる。
 */
export function parseVersion(s: string): Semver | null {
  const m = RE.exec(s.trim());
  if (!m) return null;
  const pre: (string | number)[] = [];
  if (m[4] !== undefined) {
    for (const id of m[4].split('.')) {
      if (id === '') return null;
      // 数だけの札に頭 0 があれば形が違う（`rc.01` は認めぬ）
      if (/^\d+$/.test(id)) {
        if (!numericId(id)) return null;
        pre.push(Number(id));
      } else {
        pre.push(id);
      }
    }
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** `pre` の一つぶんを比べる。数は数として、字は ASCII の順で。 */
function cmpId(a: string | number, b: string | number): number {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  // **数は字より低い。** SemVer の定めである（`1.0.0-1` < `1.0.0-alpha`）
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  if (an && bn) return (a as number) - (b as number);
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

/**
 * 二つの版を比べる。`a < b` なら負、等しければ 0、`a > b` なら正。
 * どちらかが解けねば `null`——**「分からぬ」を数で表さぬ。**
 *
 * 0 を返せば「等しい」と読まれ、`null` を 0 と混ぜれば
 * **解けなんだ物が「同じ版」に化ける**。呼ぶ側に区別を強いる。
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;

  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }

  // **仮の版は、同じ数の正式版より低い。** `1.0.0-rc.1` < `1.0.0`
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;

  const n = Math.min(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const c = cmpId(x.pre[i]!, y.pre[i]!);
    if (c !== 0) return c;
  }
  // ここまで同じなら、札の多いほうが上（`alpha` < `alpha.1`）
  return x.pre.length - y.pre.length;
}

/**
 * `a` は `b` より新しいか。
 *
 * **解けぬ版は「新しくない」と見る。** 解けぬ物を新しいと見れば、
 * 壊れた札一つで全員が降ってくる。fail-closed の側へ倒す。
 */
export function isNewer(a: string, b: string): boolean {
  const c = compareVersions(a, b);
  return c !== null && c > 0;
}

/** 仮の版か（`-` の後を持つか）。出す側・降ろす側の判じに使う。 */
export function isPrerelease(s: string): boolean {
  const v = parseVersion(s);
  return v !== null && v.pre.length > 0;
}
