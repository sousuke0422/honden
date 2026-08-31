/**
 * 免許の見分けが、実態とずれておらぬかを見る。
 *
 * # なぜ機械が数えるか
 *
 * 定めはこうである（`docs/decisions.md`・殿下知 2026-08-31）——
 * **既定は MIT。`NOTICE.md` が在る物だけが例外。**
 *
 * この形の定めは、**書いた日から腐り始める**。借り物を足した者が README の
 * 表を直し忘れれば、他人の物を MIT と名乗ったまま配ることになる。しかも
 * 誰も気づかぬ——表は静かに古くなるだけで、何も壊れぬゆえ。
 *
 * ゆえに「紙が在る所」と「表に載っておる所」を突き合わせる。
 *
 * # ここで捕らえられぬもの
 *
 * **借りたのに `NOTICE.md` を置き忘れた場合は捕らえられぬ。** 機械には
 * 「これは他所から来た」が分からぬ。捕らえるのは**紙と表の食い違い**までで
 * ある。そこは人の手に残る——だから定めの側に「置き忘れは、他人の物を MIT と
 * 名乗ることになる」と書いてある。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const SKILLS = join(ROOT, 'skills');

/** `NOTICE.md` を持つ所を、深さを問わず集める。 */
function withNotice(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (existsSync(join(p, 'NOTICE.md'))) out.push(relative(ROOT, p).split('\\').join('/'));
    withNotice(p, out);
  }
  return out;
}

const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * README の**免許の表に載っておる道**だけを拾う。
 *
 * **本文に出てくるだけでは足りぬ。** 初めは README ぜんたいに含まれるかで
 * 見ておったが、同じ道が地の文にも書いてあるため、表から落としても通って
 * しまった（陽性対照で露見・2026-08-31）。表の行だけを見る。
 */
function licensedInReadme(): string[] {
  const t = readme();
  const i = t.indexOf('## ライセンス');
  if (i < 0) return [];
  const section = t.slice(i);
  const out: string[] = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

describe('免許の例外 — 紙と表が合うておるか', () => {
  const dirs = withNotice(SKILLS);

  test('**例外は在る**（無ければこの試験そのものが無意味）', () => {
    // 陽性対照の代わり。一つも無ければ、以下は何も検めておらぬ
    expect(dirs.length).toBeGreaterThan(0);
  });

  test('**紙が在る所は、すべて README の表に載っておる**', () => {
    const listed = licensedInReadme();
    const missing = dirs.filter((d) => !listed.includes(d));
    expect(missing, `README の免許の表に載っておらぬ: ${missing.join(', ')}`).toEqual([]);
  });

  test('**表に載っておるのに紙が無い所は無い**（逆向きも見る）', () => {
    const ghost = licensedInReadme().filter((d) => !dirs.includes(d));
    expect(ghost, `表にあるが NOTICE.md が無い: ${ghost.join(', ')}`).toEqual([]);
  });

  test('紙には免許の名が書いてある', () => {
    for (const d of dirs) {
      const n = readFileSync(join(ROOT, d, 'NOTICE.md'), 'utf8');
      expect(/MIT|Apache|BSD|GPL|ISC/i.test(n), `${d}/NOTICE.md に免許の名が無い`).toBe(true);
    }
  });

  test('紙には出所と版が書いてある（後から辿れねば意味が無い）', () => {
    for (const d of dirs) {
      const n = readFileSync(join(ROOT, d, 'NOTICE.md'), 'utf8');
      // gist も出所になる（`japanese-tech-writing` がそれ）
      expect(/https:\/\/(gist\.)?github\.com\//.test(n), `${d}/NOTICE.md に出所が無い`).toBe(true);
      expect(/[0-9a-f]{12}/.test(n), `${d}/NOTICE.md に版（commit）が無い`).toBe(true);
    }
  });

  test('**Apache-2.0 なら免許の全文を隣に置く**（§4.1）', () => {
    for (const d of dirs) {
      const n = readFileSync(join(ROOT, d, 'NOTICE.md'), 'utf8');
      if (!/Apache/i.test(n)) continue;
      expect(existsSync(join(ROOT, d, 'LICENSE')), `${d} は Apache だが LICENSE が無い`).toBe(true);
    }
  });

  test('LICENSE を置くなら NOTICE も置く（片方だけでは辿れぬ）', () => {
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        if (existsSync(join(p, 'LICENSE'))) all.push(relative(ROOT, p).split('\\').join('/'));
        walk(p);
      }
    };
    walk(SKILLS);
    const orphan = all.filter((d) => !existsSync(join(ROOT, d, 'NOTICE.md')));
    expect(orphan, `LICENSE はあるが NOTICE.md が無い: ${orphan.join(', ')}`).toEqual([]);
  });
});

describe('定めが書いてあること', () => {
  test('README が既定を述べておる', () => {
    const t = readme();
    expect(t).toContain('既定は MIT');
    expect(t).toContain('NOTICE.md');
  });

  test('**置き場では見分けぬ**と明記しておる（我が一度誤った所）', () => {
    // vendor/ は「追える上流があるか」の別であって、免許の別ではない
    expect(readme()).toContain('置き場では見分けない');
  });
});
