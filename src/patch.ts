/**
 * unified diff を当てる。
 *
 * ## なぜ差分を受けるか
 *
 * 丸ごと置き換えは、**何が在ったかについて何も主張しない**。
 * 長い本文を貼り直すとき、気づかぬうちに一段落落としても誰も止めない。
 *
 * 差分は「いま何が書いてあるか」の主張である。当てれば主張ごと検められる。
 * 文脈の行が合わねば当たらない——**思っていた中身と違う、と分かる**。
 *
 * ## 当て方
 *
 * `@@` の行番号は目安として使う。そこで合わねば、文脈の塊を本文の中から探す。
 *
 *   - 見つからねば断る（思っていた中身と違う）
 *   - 二箇所以上に見つかっても断る（どちらを直すのか決まらぬ）
 *
 * 行番号のずれは許すが、**曖昧さは許さない**。
 * `patch(1)` の fuzz のように文脈を削って当てにいくことはしない——
 * 削った文脈の分だけ、誤った場所へ当たる余地が増える。
 *
 * ## 外の道具を呼ばない
 *
 * `patch(1)` はファイルを取る。ここで扱うのは正本の中の文字列である。
 * 一時ファイルへ書き出して呼ぶと、失敗の筋（書き出し・権限・後始末）が増える。
 */

export interface Hunk {
  /** `@@ -a,b +c,d @@` の a。1 始まり。目安として使う。 */
  oldStart: number;
  /** `@@ -a,b +c,d @@` の b と d。**hunk の終わりを知るために要る。** */
  oldCount: number;
  newCount: number;
  /** ' ' 文脈 / '-' 消す / '+' 足す。 */
  lines: { kind: ' ' | '-' | '+'; text: string }[];
}

export interface FilePatch {
  /** `--- a/<name>` の name。honden では書き換える欄の名。 */
  field: string;
  hunks: Hunk[];
}

export type ParseResult = { ok: true; patches: FilePatch[] } | { ok: false; message: string };

/** unified diff を解く。 */
export function parseUnified(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const patches: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  // いま読んでおる hunk の、残りの旧行数と新行数。
  let oldLeft = 0;
  let newLeft = 0;

  const nameOf = (l: string): string =>
    l
      .slice(4)
      .trim()
      .replace(/^[ab]\//, '')
      .replace(/\t.*$/, '');

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // hunk の中身を読んでおる間は、行頭が --- や +++ でもファイル頭とは見ない。
    //
    // 差分の中身にはそういう行がふつうに出る。SQL のコメント（`-- `）を消す行は
    // 差分上で `--- ` になり、`++ x` を足す行は `+++ x` になる。
    // 見分けるには **hunk の行数を数える**しかない——`@@ -a,b +c,d @@` の b と d である。
    //
    // 数えずにおったため、`-- ` を消す差分が「当たった」と言いながら
    // 黙って何も変えなかった（外部レビューで再現・2026-08-27）。
    // 「全部当たるか何も書かぬか」という約束を、静かに破っておった。
    if (hunk) {
      // @@ と diff --git は紛れようがない。中身の行は必ず ' ' '-' '+' が前に付くゆえ、
      // 素の @@ や diff --git は境目である。
      const isBoundary =
        l.startsWith('@@') ||
        l.startsWith('diff --git ') ||
        // `--- ` の次が `+++ ` なら、それはファイルの頭。
        // 中身の `-- x` と `++ y` が並ぶことは無いとは言えぬが、稀である。
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));

      if (!isBoundary) {
        const k = l[0];
        if (k === ' ' || k === '-' || k === '+') {
          hunk.lines.push({ kind: k, text: l.slice(1) });
          if (k !== '+') oldLeft--;
          if (k !== '-') newLeft--;
          continue;
        }
        if (l === '') {
          // 末尾の空行は中身ではない
          if (i === lines.length - 1) continue;
          hunk.lines.push({ kind: ' ', text: '' });
          oldLeft--;
          newLeft--;
          continue;
        }
        if (l.startsWith('\\')) continue; // "\ No newline at end of file"
        // 印の無い行。数がまだ残っておるなら、それは壊れた差分である。
        // 黙って閉じると fail-open になる——読めなかったものを、
        // 「hunk が終わった」と取り違えて通してしまう。
        if (oldLeft > 0 || newLeft > 0) {
          return { ok: false, message: `hunk の中に読めぬ行がある: ${JSON.stringify(l)}` };
        }
        // 数を使い切った後の印の無い行は、差分の後ろに付いた文である。閉じてよい。
      }
      // 境目に来た。hunk を閉じる。
      hunk = null;
      oldLeft = 0;
      newLeft = 0;
    }

    if (l.startsWith('--- ')) {
      hunk = null;
      continue; // 名は +++ 側で採る
    }
    if (l.startsWith('+++ ')) {
      cur = { field: nameOf(l), hunks: [] };
      patches.push(cur);
      hunk = null;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) return { ok: false, message: `hunk の頭が読めぬ: ${l}` };
      if (!cur) return { ok: false, message: '--- / +++ より先に @@ が来ておる。どの欄への差分か分からぬ。' };
      // 数を省いた `@@ -1 +1 @@` は 1 行の意。
      const oc = m[2] === undefined ? 1 : Number(m[2]);
      const nc = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { oldStart: Number(m[1]), oldCount: oc, newCount: nc, lines: [] };
      oldLeft = oc;
      newLeft = nc;
      cur.hunks.push(hunk);
      continue;
    }
    // ここへ来るのは hunk の外。前置き（diff --git など）は読み飛ばす。
    void i;
  }

  if (patches.length === 0) return { ok: false, message: '差分に --- / +++ の組が無い。どの欄への差分か分からぬ。' };
  for (const p of patches) {
    if (p.hunks.length === 0) return { ok: false, message: `${p.field} への差分に @@ が無い。` };
  }
  return { ok: true, patches };
}

export type ApplyResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * 一つの欄へ当てる。
 *
 * 当たらねば**何も変えずに断る**。半分当たった状態を残さない。
 */
export function applyHunks(original: string, hunks: Hunk[], field: string): ApplyResult {
  let lines = original.replace(/\r\n?/g, '\n').split('\n');
  // 後ろの hunk から当てる。前を先に当てると、後ろの行番号がずれる。
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const h of ordered) {
    const before = h.lines.filter((l) => l.kind !== '+').map((l) => l.text);
    const after = h.lines.filter((l) => l.kind !== '-').map((l) => l.text);

    const at = locate(lines, before, h.oldStart - 1);
    if (at.kind === 'none') {
      return {
        ok: false,
        message:
          `${field} へ当たらぬ。文脈の行が本文の中に見つからぬ。\n` +
          `  探した塊の先頭: ${JSON.stringify(before[0] ?? '')}\n` +
          '  いまの本文が、差分を書いた時と違うのではないか。\n' +
          '  honden cmd show で今の姿を確かめられよ。何も変えておらぬ。',
      };
    }
    if (at.kind === 'many') {
      return {
        ok: false,
        message:
          `${field} のどこへ当てるか決まらぬ。同じ文脈が ${at.count} 箇所にある。\n` +
          '  文脈の行を増やして、一箇所に定まるようにされよ。何も変えておらぬ。',
      };
    }
    lines = [...lines.slice(0, at.index), ...after, ...lines.slice(at.index + before.length)];
  }
  return { ok: true, text: lines.join('\n') };
}

type Located = { kind: 'one'; index: number } | { kind: 'none' } | { kind: 'many'; count: number };

/**
 * 文脈の塊が本文のどこに在るか。
 *
 * 目安の位置で合えばそこ。合わねば全体から探し、**一箇所に定まる時だけ**返す。
 */
function locate(lines: string[], block: string[], hint: number): Located {
  if (block.length === 0) return { kind: 'none' };
  const matches = (i: number) => block.every((b, k) => lines[i + k] === b);

  if (hint >= 0 && hint + block.length <= lines.length && matches(hint)) {
    return { kind: 'one', index: hint };
  }
  const found: number[] = [];
  for (let i = 0; i + block.length <= lines.length; i++) if (matches(i)) found.push(i);
  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'many', count: found.length };
  return { kind: 'one', index: found[0]! };
}
