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
export const VERSION = '0.1.0';

/** 出す先。更新はここからしか取らぬ。 */
export const REPO = 'sousuke0422/honden';

/** 版を数の並びへ。比べられぬ形なら `null`。 */
export function parseVersion(s: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-|\+|$)/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * `a` は `b` より新しいか。
 *
 * **解けぬ版は「新しくない」と見る。** 解けぬ物を新しいと見れば、
 * 壊れた札一つで全員が降ってくる。fail-closed の側へ倒す。
 */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i]! > y[i]!) return true;
    if (x[i]! < y[i]!) return false;
  }
  return false;
}
