/**
 * 戦況を HTML へ組む所の試験。**要は「配下の書いた字が tag に化けぬ」こと。**
 *
 * 司令の本文も裁可の問いも配下が書く。注入された足軽がそこへ細工を混ぜても、
 * 殿の頁で走ってはならぬ（敵対レビューの critical・2026-08-29）。
 */
import { describe, expect, test } from 'bun:test';
import { esc, mdToHtml } from '../src/render';

describe('esc', () => {
  test('HTML で意味を持つ字を全て殺す', () => {
    expect(esc(`<img src=x onerror="alert(1)">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(esc("it's & that")).toBe('it&#39;s &amp; that');
  });
});

describe('mdToHtml — 配下の字は tag にならぬ', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">押せ</a>',
    '<iframe src="http://evil"></iframe>',
    '"><svg onload=alert(1)>',
  ];

  test('見出し・箇条・表・段落、どこへ混ぜても生きた tag は出ぬ', () => {
    for (const a of attacks) {
      for (const md of [`# ${a}`, `## ${a}`, `- ${a}`, `${a}`, `| 欄 |\n|---|\n| ${a} |`]) {
        const html = mdToHtml(md);
        // 生きた tag が出ぬこと。字として残るのは構わぬ——`onerror` の
        // 六文字が escape 済みの本文に見えても、それは text であって属性ではない。
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('<iframe');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('<a ');
        // 開き括弧は escape され、我らの tag だけが生きた `<` を持つ。
        expect(html).toContain('&lt;');
      }
    }
  });

  test('陽性対照——escape を通さねば通り抜ける（試験が効いておる証）', () => {
    // esc を通さぬ素の埋め込みなら、上の検めは当然すり抜ける。
    const naive = `<p><img src=x onerror=alert(1)></p>`;
    expect(naive).toContain('<img');
  });
});

describe('mdToHtml — 我らの形を正しく組む', () => {
  test('見出し', () => {
    expect(mdToHtml('# 戦況報告')).toBe('<h1>戦況報告</h1>');
    expect(mdToHtml('## 要対応')).toBe('<h2>要対応</h2>');
  });

  test('箇条は一つの ul に畳む', () => {
    expect(mdToHtml('- 一\n- 二')).toBe('<ul><li>一</li><li>二</li></ul>');
  });

  test('表は thead と tbody に分かれる', () => {
    const html = mdToHtml('| 時刻 | 任務 |\n|------|------|\n| 12:00 | 検分 |');
    expect(html).toContain('<th>時刻</th>');
    expect(html).toContain('<td>12:00</td>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
  });

  test('区切りの無い | 行は表にせず段落にする', () => {
    expect(mdToHtml('| これは表ではない |')).toBe('<p>| これは表ではない |</p>');
  });

  test('強調と小さな code は飾る', () => {
    expect(mdToHtml('**強く** と `命`')).toBe('<p><strong>強く</strong> と <code>命</code></p>');
  });

  test('飾りの記号が本文に化けても tag にはならぬ', () => {
    expect(mdToHtml('`<b>` と **<i>**')).toBe(
      '<p><code>&lt;b&gt;</code> と <strong>&lt;i&gt;</strong></p>',
    );
  });

  test('空行は落ちる。解せぬ形は段落として残す（黙って捨てぬ）', () => {
    expect(mdToHtml('あ\n\n\nい')).toBe('<p>あ</p>\n<p>い</p>');
    expect(mdToHtml('> 引用は解さぬ')).toBe('<p>&gt; 引用は解さぬ</p>');
  });
});
