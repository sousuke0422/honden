/**
 * 建てた実体を要する試験の前口上。
 *
 * 切った直後の作業木は `bin/` を持たぬ（白名簿の外ゆえ）。そのまま走らせると
 * 実体を叩く試験が**ただの赤の雨**で落ち、建て忘れか本物の壊れかが読めなんだ
 * （実測 2026-09-17: 1183 pass / 24 fail、どの赤も理由を語らず）。
 *
 * ここは**飛ばさず落とす**——「道具が無いから飛ばす」は fail-open の型であり、
 * 見張りが黙って消える（test/shell.test.ts の頭書きと同じ判断）。ただし赤は
 * 一つに纏め、読める言葉で理由を語らせる。残りの試験は登録せぬ——
 * 意味の無い赤を並べれば、本物の赤が霞むゆえ。
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 要る実体が揃っておれば真。欠けておれば「建てておらぬ」と読める赤を
 * **一つだけ**登録して偽を返す。呼び手は偽なら残りの試験を登録せぬこと。
 */
export function requireBuilt(root: string, where: string, bins: string[] = ['honden-parse']): boolean {
  const missing = bins.filter((b) => !existsSync(join(root, 'bin', b)));
  if (missing.length === 0) return true;
  test(`【建てておらぬ】${missing.map((b) => `bin/${b}`).join(' と ')} が無い（${where}）`, () => {
    expect(
      false,
      `${missing.map((b) => `bin/${b}`).join(' と ')} が無い。本物の赤ではない——` +
        '先に bun run build:all を走らせよ。作業木は bin/ を持たぬゆえ、切った直後は必ず無い。',
    ).toBe(true);
  });
  return false;
}
