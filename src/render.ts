/**
 * 戦況の md を HTML へ組む。**自前で組む。借り物の描画器は使わぬ。**
 *
 * 当初は marked を CDN から引き、`innerHTML` へ流していた。敵対レビューが
 * critical を二つ立てた（2026-08-29）:
 *
 * - **蓄積型 XSS**: 司令の本文・裁可の問いは配下が書く。注入された足軽が
 *   `<img onerror=…>` を司令に混ぜれば、殿がその頁を開いた時に走る。
 * - **素性も版も留めぬ外部 script**: 内部の戦況を映す頁が、毎回よそから
 *   落としてきた code を信じておった。
 *
 * どちらも「借り物へ丸投げして、入る文字を検めなんだ」ことに帰する。
 * 戦況の md は**我らが組んだもの**で、形は決まっておる——見出し・箇条・表・
 * 強調・小さな code だけ。ならば自前で組める。組むなら、**差し込む文字は
 * 全て escape してから**組める。頁は外へ一切繋がらず、`innerHTML` へ渡るのは
 * 我らが作った HTML だけになる。
 */

/** HTML で意味を持つ字を殺す。**差し込む文字は必ずここを通す。** */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 行の中の飾り。**escape してから**飾るゆえ、飾りの記号が本文に化けても
 * tag にはならぬ。link は作らぬ——作れば javascript: を弾く手間が増える。
 */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const isTableRow = (l: string) => l.startsWith('|') && l.endsWith('|');
const isTableSep = (l: string) => /^\|[\s:|-]+\|$/.test(l);
const cells = (l: string) => l.slice(1, -1).split('|').map((c) => c.trim());

/**
 * 戦況の md を HTML へ。**我らが出す形だけを解する**——
 * 見出し（# / ##）・箇条（- ）・表（| … |）・その他は段落。
 * 解せぬ形は段落として出る。落とさぬゆえ、見落としにはならぬ。
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();

    if (t === '') {
      i++;
      continue;
    }

    if (t.startsWith('## ')) {
      out.push(`<h2>${inline(t.slice(3))}</h2>`);
      i++;
      continue;
    }
    if (t.startsWith('# ')) {
      out.push(`<h1>${inline(t.slice(2))}</h1>`);
      i++;
      continue;
    }

    if (t.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('- ')) {
        items.push(`<li>${inline(lines[i]!.trim().slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (isTableRow(t)) {
      const head = cells(t);
      i++;
      // 二行目が区切りなら表。違えば、ただの段落として畳む。
      if (i < lines.length && isTableSep(lines[i]!.trim())) {
        i++;
        const body: string[] = [];
        while (i < lines.length && isTableRow(lines[i]!.trim()) && !isTableSep(lines[i]!.trim())) {
          body.push(`<tr>${cells(lines[i]!.trim()).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
          i++;
        }
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${body.join('')}</tbody></table>`,
        );
        continue;
      }
      out.push(`<p>${inline(t)}</p>`);
      continue;
    }

    out.push(`<p>${inline(t)}</p>`);
    i++;
  }

  return out.join('\n');
}
