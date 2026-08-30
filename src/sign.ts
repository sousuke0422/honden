/**
 * 出し物の署名。**鍵を持たぬ形（Sigstore keyless）で。**
 *
 * # なぜ鍵を置かぬか
 *
 * 鍵を持てば、鍵を守る仕事が増える。どこに置くか、誰が触れるか、漏れたら
 * どう回すか——**守り切れぬ鍵は、無い鍵より悪い**（あると思うて安心する）。
 *
 * cosign の keyless は鍵を作らぬ。出す時に GitHub Actions の OIDC で
 * 身元を示し、Fulcio が短命の証書を出し、Rekor（公の台帳）に跡が残る。
 * 秘密鍵はどこにも残らぬゆえ、盗まれる物も回す物も無い。
 *
 * # 縛るのは「誰が署名したか」である
 *
 * **ここが全てである。** cosign の verify を身元の指定なしに走らせると、
 * *Sigstore で署名された物なら誰の物でも通る*。誰でも自分の workflow で
 * 署名できるゆえ、それは検めになっておらぬ——「署名がある」は
 * 「我らが署名した」ではない。
 *
 * ゆえに二つを必ず渡す:
 *   `--certificate-identity-regexp`  我らの release.yml が、札から走った物だけ
 *   `--certificate-oidc-issuer`      GitHub Actions の OIDC だけ
 *
 * 札（`refs/tags/`）に縛るのも意図である。枝から走らせた物を認めれば、
 * 枝へ書ける者が通る署名を作れてしまう。
 *
 * # 何に署名するか
 *
 * `SHA256SUMS` 一枚だけに署名する。binary は既にその紙で縛られておるゆえ、
 * **紙を縛れば全部が縛られる**。署名を 12 枚に増やしても強くはならず、
 * 検める段が増えるだけである。
 *
 *   署名 → SHA256SUMS → 各 binary
 *
 * # 検めが無い時は、降ろさぬ
 *
 * cosign が無ければ**断る**。「あれば検める」にすると、無い機体では
 * 黙って素通りになり、**守れておるつもりで守れておらぬ**状態が生まれる。
 * これは honden が何度も踏んだ型（新しい層は fail-open として生まれる）ゆえ、
 * 最初から閉じて生む。
 *
 * 抜け道は残すが、長く醜い旗にして台帳へ残す。押しにくくしておく。
 */
import { REPO } from './version';

/** 署名の束。cosign が一枚に畳んだ物（証書・署名・台帳の控え）。 */
export const BUNDLE = 'SHA256SUMS.cosign.bundle';

/** 出した者の身元。**札から走った我らの release.yml だけ。** */
export const IDENTITY_RE = `^https://github\\.com/${REPO.replace(/[.]/g, '\\.')}/\\.github/workflows/release\\.yml@refs/tags/`;

/** 身元を保証する者。GitHub Actions の OIDC 以外は認めぬ。 */
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** 抜け道の旗。**長く醜い名にしてある**——気軽に押されては困る。 */
export const SKIP_FLAG = 'insecure-skip-signature';

/**
 * cosign に渡す言葉。
 *
 * `--bundle` 一枚で足りる（証書も署名も台帳の控えも入っておる）。
 * `--new-bundle-format` を付けぬのは、cosign が束の形を見て判ずるゆえ。
 */
export function verifyArgs(bundlePath: string, blobPath: string): string[] {
  return [
    'cosign', 'verify-blob',
    '--bundle', bundlePath,
    '--certificate-identity-regexp', IDENTITY_RE,
    '--certificate-oidc-issuer', OIDC_ISSUER,
    blobPath,
  ];
}

export type SignCheck =
  | { kind: 'verify' }
  | { kind: 'skip'; warning: string }
  | { kind: 'refuse'; message: string };

/**
 * 検めるか、断るか、飛ばすか。
 *
 * **既定は「検める」。** cosign が無ければ断り、旗が明示された時だけ飛ばす。
 * 三つを一つの型に畳んでおるのは意図で、呼ぶ側に「どれでもない」を
 * 作らせぬため——曖昧な四つ目が生まれると、そこが素通りの口になる。
 */
export function signCheck(opts: { hasCosign: boolean; skip: boolean }): SignCheck {
  if (opts.skip) {
    return {
      kind: 'skip',
      warning:
        `署名を検めずに降ろす（--${SKIP_FLAG}）。**数は壊れと途中切れしか守らぬ**——` +
        '出し物そのものが差し替えられておっても気づけぬ',
    };
  }
  if (!opts.hasCosign) {
    return {
      kind: 'refuse',
      message:
        '署名を検める道具が無い（cosign）。**検められぬ物は置かぬ。**\n' +
        '    入れる:   https://docs.sigstore.dev/cosign/system_config/installation/\n' +
        `    どうしても急ぐなら: --${SKIP_FLAG}（その旨は台帳に残る）`,
    };
  }
  return { kind: 'verify' };
}

/**
 * cosign の答えを読む。
 *
 * **終了コードだけを見る。** 通った時に何と言うかは版で変わるが、
 * 通らねば 0 以外を返すのは変わらぬ。文面で判ずると、版が上がった日に
 * 黙って素通りになる（ntfy で curl の終了コードだけを見て 404 を
 * 「届いた」と誤ったのと同じ型）。
 */
export function readVerify(r: { ok: boolean; stderr?: string }): { ok: true } | { ok: false; message: string } {
  if (r.ok) return { ok: true };
  const tail = (r.stderr ?? '').trim().split('\n').slice(-3).join('\n');
  return {
    ok: false,
    message:
      '署名が我らの物と認められなんだ。**一つも置かぬ。**\n' +
      `    身元は ${IDENTITY_RE} に限る（札から走った release.yml のみ）\n` +
      (tail ? `    cosign: ${tail}` : ''),
  };
}
