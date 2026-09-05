/**
 * 入力の検査。
 *
 * ## 追い返し方の作法
 *
 * 変な値を無理やり通してはならない。だが、追い返された側が手を止めても困る。
 * だからここが返すのは「駄目だ」ではなく **「何が・どう駄目で・どう直すか」** になる。
 *
 * 1. **落ちたものを全部並べる。** 1 件ずつ返すと、直す側が往復を繰り返す。
 *    3 つ間違っていれば 3 つとも一度に見せる。
 * 2. **受け取った値をそのまま見せる。** 「不正な値」だけでは、自分が何を
 *    送ったのか確かめる術がない (シェルの引用符で化けている場合がある)。
 * 3. **選べる値を並べる。綴りが近いものがあれば名指しする。**
 *    見るのは綴りだけで、意味は見ない。`urgent` に `high` を勧めたりはしない
 *    (それは推測であって訂正ではない)。選べる値が並んでいれば、それで足りる。
 * 4. **知らない鍵は捨てずに指摘する。** `acceptance_criteia` のような一文字違いを
 *    黙って捨てると、受け入れ条件の無い cmd が出来上がる。
 * 5. **「書き込んでいない」と明言する。** 半端に入ったかもしれないと思わせると、
 *    直す側が確認から始めることになる。
 */

export interface Problem {
  field: string;
  got?: unknown;
  message: string;
  /** そのまま実行できる直し方。無い場合もある。 */
  hint?: string;
}

export interface FieldSpec {
  required?: boolean;
  /** 取りうる値。指定すると、外れた値は近いものを添えて返す。 */
  oneOf?: readonly string[];
  /** 配列を受ける欄。 */
  list?: boolean;
  /**
   * 形をここでは見ない欄。
   *
   * 対応でも並びでも受ける所（report の acceptance など）に使う。
   * 形の検めは呼び出し側が受け持つ。ここで文字列を強いると、
   * 正しく書かれた対応が「文字列で書く項目」として弾かれる。
   */
  structured?: boolean;
  /** 空文字を許すか。既定は許さない。 */
  allowEmpty?: boolean;
  /** 何のための欄か。追い返すときに添える。 */
  about?: string;
}

export type Schema = Record<string, FieldSpec>;

/** 編集距離。近い候補を名指しするためだけに使う短い実装。 */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/** 候補の中から、綴りが近いものを 1 つ返す。遠すぎれば返さない。 */
export function nearest(value: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(value.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // 半分以上違うものを「近い」とは言わない。的外れな助言は害になる。
  const limit = Math.max(2, Math.floor(Math.max(value.length, best?.length ?? 0) / 2));
  return bestD <= limit ? best : undefined;
}

export function validate(schema: Schema, input: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  const known = Object.keys(schema);

  for (const key of Object.keys(input)) {
    if (key in schema) continue;
    const near = nearest(key, known);
    problems.push({
      field: key,
      message: '知らない項目',
      hint: near
        ? `${near} の綴り違いではないか。受け付ける項目: ${known.join(' / ')}`
        : `受け付ける項目: ${known.join(' / ')}`,
    });
  }

  for (const [key, spec] of Object.entries(schema)) {
    const v = input[key];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

    if (missing) {
      if (spec.required) {
        problems.push({
          field: key,
          message: '必須の項目が無い',
          hint: spec.about,
        });
      }
      continue;
    }

    if (spec.list) {
      if (!Array.isArray(v)) {
        problems.push({
          field: key,
          got: v,
          message: '一覧で書く項目',
          hint: `YAML なら\n  ${key}:\n    - 一つ目\n    - 二つ目`,
        });
      } else if (v.length === 0 && !spec.allowEmpty) {
        problems.push({ field: key, message: '一覧が空', hint: spec.about });
      } else {
        // 一覧の中身は文であること。YAML は `- 報告に載せる: HEAD の sha` を
        // 写像 {報告に載せる: "…"} と読む。素通しすると正本に "[object Object]" が
        // 入り、足軽が「読めぬ」と報告して一巡が無駄になる（実害 2026-09-05）。
        v.forEach((item, i) => {
          if (typeof item !== 'string' || item.trim() === '') {
            problems.push({
              field: `${key}[${i + 1}]`,
              got: item,
              message: '一覧の中身が文ではない',
              hint:
                '「語: 続き」の形は YAML が写像と読む。折り畳み（>-）で包むか、コロンの後の空白を外されよ',
            });
          }
        });
      }
      continue;
    }

    if (spec.structured) continue;

    if (typeof v !== 'string') {
      problems.push({ field: key, got: v, message: '文字列で書く項目' });
      continue;
    }

    if (spec.oneOf && !spec.oneOf.includes(v)) {
      const near = nearest(v, spec.oneOf);
      problems.push({
        field: key,
        got: v,
        message: `取りうる値の外`,
        hint: `${spec.oneOf.join(' / ')} のいずれか${near ? `。近いのは ${near}` : ''}`,
      });
    }
  }

  return problems;
}

/**
 * 追い返す文面を組む。
 *
 * 最後に必ず「書き込んでいない」と言う。半端に入ったかもしれないと思わせると、
 * 直す側が確認から始めることになり、そこで手が止まる。
 */
export function explain(problems: Problem[], retryHint?: string): string {
  const lines: string[] = [
    `受け付けられぬ点が ${problems.length} 件ござる。直して再度お試しくだされ。`,
    '',
  ];
  for (const p of problems) {
    lines.push(`  ● ${p.field}: ${p.message}`);
    if (p.got !== undefined) lines.push(`      受け取った値: ${JSON.stringify(p.got)}`);
    if (p.hint) for (const h of p.hint.split('\n')) lines.push(`      ${h}`);
  }
  lines.push('');
  lines.push('  書き込みは行っておらぬ。同じ命令をそのまま直して撃ち直してよい。');
  if (retryHint) lines.push(`  ${retryHint}`);
  return lines.join('\n');
}

/**
 * 迂回の理由として受け付けるか。
 *
 * 空も、それらしいだけの短文も弾く。理由が形だけになると、
 * 後から「なぜ迂回したのか」が誰にも分からなくなる。
 */
/**
 * 理由が理由になっているか。
 *
 * `what` は何のための理由かを言う言葉。既定は「迂回」だが、
 * 迂回でない所——他の者の持ち場を覗くなど——でも使うので差し替えられる。
 * 「迂回には理由が要る」と出しておいて迂回ではない、では読む者が混乱する。
 */
export function checkReason(reason: string | undefined, example?: string, what = '迂回'): string | null {
  const r = (reason ?? '').trim();
  if (r === '')
    return `${what}には理由が要る。--reason "${example ?? '家老が沈黙して 40 分'}" のように書かれよ。`;
  if ([...r].length < 8) return `理由が短すぎる: ${JSON.stringify(r)}\n  何が起きて迂回するのかを書かれよ。`;
  if (/^(test|テスト|試験|tmp|x+|あ+)$/i.test(r)) {
    return `それは理由になっておらぬ: ${JSON.stringify(r)}`;
  }
  return null;
}

