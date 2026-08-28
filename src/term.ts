/**
 * 端末へ出す字の見栄え。
 *
 * 文中の `**強調**` は、書く側にとっては読みやすい印だが、**端末へそのまま出ると
 * ただの記号**である（殿の指摘・2026-08-28「美しさにも欠ける」）。
 * 端末なら太字にし、パイプやファイルへ落ちるなら印ごと外す。
 *
 * 色は使わぬ。太さだけにしておく——端末の配色は人それぞれで、色を決め打てば
 * 読めぬ組み合わせが必ず出る。太さは背景に依らぬ。
 */

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const UNBOLD = `${ESC}[22m`;

/** 出し先が人の目か（端末か）。パイプ・ファイル・捕獲の先では false。 */
export function isTty(stream: { isTTY?: boolean } = process.stdout): boolean {
  // NO_COLOR は色の話だが、飾りを厭う意思表示として尊ぶ（慣例）。
  if (process.env.NO_COLOR !== undefined) return false;
  return stream.isTTY === true;
}

/**
 * `**…**` を太字にする。端末でなければ印を外すだけ。
 *
 * 入れ子や跨ぎは追わぬ——飾りのために本文を壊す方が損である。
 */
export function emphasize(s: string, tty: boolean = isTty()): string {
  return s.replace(/\*\*([\s\S]+?)\*\*/g, tty ? `${BOLD}$1${UNBOLD}` : '$1');
}
