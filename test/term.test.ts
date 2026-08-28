/**
 * 端末の見栄えの試験。
 *
 * `**強調**` は書く側の読みやすさのための印であって、**端末へそのまま出れば
 * ただの記号**である（殿の指摘・2026-08-28「美しさにも欠ける」）。
 * 端末なら太字、そうでなければ印ごと外す——**どちらでも記号は残さぬ**のが要。
 */
import { describe, expect, test } from 'bun:test';
import { emphasize, isTty } from '../src/term';

const ESC = String.fromCharCode(27);

describe('印は残さぬ', () => {
  test('端末でなければ印だけ外して中身は残る', () => {
    expect(emphasize('これは**大事**である', false)).toBe('これは大事である');
  });

  test('端末なら太字に変わり、印は消える', () => {
    const out = emphasize('これは**大事**である', true);
    expect(out).toContain(ESC + '[1m');
    expect(out).toContain(ESC + '[22m');
    expect(out).not.toContain('**');
  });

  test('一行に幾つあっても全て落ちる', () => {
    expect(emphasize('**あ**と**い**と**う**', false)).toBe('あといとう');
  });

  test('行を跨ぐものは飾りと認めぬ（段を越える飾りは大抵誤読）', () => {
    const s = '**一行目\n二行目**';
    expect(emphasize(s, false)).toBe(s); // 触らぬ
  });

  test('印が閉じておらねば触らぬ（本文を壊さぬ）', () => {
    expect(emphasize('**閉じておらぬ', false)).toBe('**閉じておらぬ');
  });

  test('印が無ければそのまま', () => {
    expect(emphasize('ただの文', false)).toBe('ただの文');
    expect(emphasize('', false)).toBe('');
  });

  test('掛け算の星は消さぬ（一つ星は印ではない）', () => {
    expect(emphasize('2 * 3 = 6', false)).toBe('2 * 3 = 6');
  });
});

describe('本文を壊さぬ — 殿の指摘（素直に読めば glob を潰す）', () => {
  // 「`**` を見たら飾り」と素直に読むと、二つの glob の `**` を開きと閉じと
  // 誤読して間を飾り、glob そのものを消す。しかもこの文字列は
  // 門の自衛の一覧を出す時に実際に並ぶ。
  const keep = [
    'Edit(agents/**) と Edit(.cursor/hooks/**) を塞ぐ',
    'instructions/**/*.md を数える',
    '--sub queue,** で取り込む',
    'Edit(.codex/hooks/**)',
    '2 * 3 = 6',
    '** 開きの直後が空白 **',
  ];
  for (const c of keep) {
    test(`壊さぬ: ${c}`, () => {
      expect(emphasize(c, false)).toBe(c);
      expect(emphasize(c, true)).toBe(c);
    });
  }

  test('glob と飾りが同じ行に居ても、飾りだけが落ちる', () => {
    expect(emphasize('Edit(agents/**) は**大事**である', false)).toBe('Edit(agents/**) は大事である');
  });
});

describe('出し先の見立て', () => {
  test('端末なら真', () => {
    expect(isTty({ isTTY: true })).toBe(true);
  });

  test('パイプなら偽', () => {
    expect(isTty({ isTTY: false })).toBe(false);
    expect(isTty({})).toBe(false);
  });

  test('NO_COLOR が置かれておれば飾らぬ（飾りを厭う意思を尊ぶ）', () => {
    const had = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      expect(isTty({ isTTY: true })).toBe(false);
    } finally {
      if (had === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = had;
    }
  });
});
