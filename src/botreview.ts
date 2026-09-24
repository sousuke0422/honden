/**
 * honden-bot の review の口 — 入力の検めと写しの規則（純関数）。
 *
 * ## 共通の命とせぬ命（殿の下知・将軍の見立てに沿う）
 *
 * 共通（`--to github|task` を取る）:
 * - 結果を出す（review submit）: github は PR review（body + event + inline
 *   comment）、task は round + findings。どちらにも「一束のレビューを刻む」
 *   意味がある。
 * - 現在地を読む（review status）: github は reviewDecision と review の履歴、
 *   task は summary。どちらにも「いまマージを止めておる物は何か」の意味がある。
 *
 * 共通にできぬ（`--to` を取らせぬ・別の名で置く）:
 * - finding の状態遷移。github に対応物が無い——thread の resolve は
 *   「会話を畳む」ことであって「指摘の状態を open→fixed→verified と運ぶ」
 *   ことではない。ゆえに `finding move`（台帳の言葉。task 自身の help が
 *   resolve を "Move a finding to a new state" と言う）として別に置き、
 *   宛先の旗を最初から持たせぬ。取らぬ旗は間違えようが無い。
 *
 * ## 写しの規則（欄ごと・落ちる欄を隠さぬ）
 *
 * 入力は honden-review-to-task と同じ findings JSON（head_sha / summary /
 * findings[severity,title,body,file,line]）。語彙は task の物である。
 * github へ出す時は次のとおり写す:
 *
 * | 欄 | task へ | github へ |
 * |---|---|---|
 * | head_sha  | そのまま | `commit_id`（review の対象 commit） |
 * | summary   | そのまま | review の body の冒頭 |
 * | severity  | そのまま | **本文の見出し記号へ写す**（🚨/🔴/🟡/🔵）。欄としては落ちる |
 * | title/body| そのまま | comment の本文（記号＋題＋本文） |
 * | file/line | そのまま | 両方あれば inline comment。片方でも欠けば body の列へ（欄は落ちるが中身は落とさぬ） |
 * | state     | （投入時は常に open） | **出さぬ（落ちる）**。github に状態遷移が無いゆえ |
 * | round     | task が採番 | **出さぬ（落ちる）**。github の review は独自の並びを持つゆえ |
 *
 * event は欄ではなく導出である: high か medium が一件でも在れば
 * REQUEST_CHANGES、無ければ COMMENT。APPROVE は出さぬ——機械名義の承認は
 * 保護規則の承認数を黙って満たしてしまう。
 *
 * ## 入力を読む所は一箇所
 *
 * `parseReviewInput` だけが入力の形を知る。YAML を後から受ける時も
 * ここへ一段足すだけで、呼び手（botmain）は触れぬ。
 *
 * ## 落ちた段が判る形
 *
 * この module の返す失敗文は必ず `[入力]` の段名を頭に持つ。呼び手の側も
 * `[宛先]` `[鋳造]` `[github]` `[task cli]` の段名を頭に付ける——三段に
 * なっても、どの段で落ちたかが文の頭で判る（whoami の「CLI は弾くが API は
 * 200」の迷いを繰り返さぬため）。
 */

export type Severity = 'high' | 'medium' | 'low' | 'nit';

export interface ReviewFinding {
  severity: Severity;
  title: string;
  body: string;
  file?: string;
  line?: number;
}

export interface ReviewInput {
  head_sha: string;
  summary: string;
  findings: ReviewFinding[];
}

const SEVERITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'nit']);

/** severity → github 本文の見出し記号。欄が無いゆえ記号として写す。 */
export const SEVERITY_MARK: Record<Severity, string> = {
  high: '🚨',
  medium: '🔴',
  low: '🟡',
  nit: '🔵',
};

/**
 * 入力を読む唯一の口。いまは JSON のみ。YAML はここへ足す（構想は
 * memo/yaml-input-for-structured-files.md——この司令では足さぬ）。
 */
export function parseReviewInput(text: string): { ok: true; input: ReviewInput } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `[入力] JSON として読めぬ: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '[入力] 頂は object でなければならぬ' };
  }
  const o = raw as Record<string, unknown>;
  const sha = o['head_sha'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, message: `[入力] head_sha が 40 桁の小文字 16 進でない: ${String(sha)}` };
  }
  if (typeof o['summary'] !== 'string' || o['summary'].trim() === '') {
    return { ok: false, message: '[入力] summary が無い（総括の文が要る）' };
  }
  if (!Array.isArray(o['findings'])) {
    return { ok: false, message: '[入力] findings が配列でない（指摘ゼロなら []）' };
  }
  const findings: ReviewFinding[] = [];
  for (const [i, f] of (o['findings'] as unknown[]).entries()) {
    if (typeof f !== 'object' || f === null) return { ok: false, message: `[入力] findings[${i}] が object でない` };
    const g = f as Record<string, unknown>;
    if (typeof g['severity'] !== 'string' || !SEVERITIES.has(g['severity'])) {
      return { ok: false, message: `[入力] findings[${i}].severity が high/medium/low/nit のいずれでもない: ${String(g['severity'])}` };
    }
    if (typeof g['title'] !== 'string' || g['title'].trim() === '') {
      return { ok: false, message: `[入力] findings[${i}].title が無い` };
    }
    if (typeof g['body'] !== 'string' || g['body'].trim() === '') {
      return { ok: false, message: `[入力] findings[${i}].body が無い（説明と対処法を書く）` };
    }
    if (g['file'] !== undefined && (typeof g['file'] !== 'string' || g['file'].trim() === '')) {
      return { ok: false, message: `[入力] findings[${i}].file が文字列でない` };
    }
    if (g['line'] !== undefined && (!Number.isInteger(g['line']) || (g['line'] as number) < 1)) {
      return { ok: false, message: `[入力] findings[${i}].line が 1 以上の整数でない: ${String(g['line'])}` };
    }
    findings.push({
      severity: g['severity'] as Severity,
      title: g['title'],
      body: g['body'],
      ...(g['file'] !== undefined ? { file: g['file'] as string } : {}),
      ...(g['line'] !== undefined ? { line: g['line'] as number } : {}),
    });
  }
  return { ok: true, input: { head_sha: sha, summary: o['summary'], findings } };
}

export interface GithubReviewPayload {
  commit_id: string;
  body: string;
  event: 'REQUEST_CHANGES' | 'COMMENT';
  comments: { path: string; line: number; body: string }[];
}

/** 指摘一件の見出し。severity は記号として本文へ写る（欄としては落ちる）。 */
function findingText(f: ReviewFinding): string {
  // 題に既に 💥 等の記号が付いておればそのまま活かし、無ければ severity の記号を添える
  const mark = /^\p{Extended_Pictographic}/u.test(f.title) ? '' : `${SEVERITY_MARK[f.severity]} `;
  return `${mark}**${f.title}**\n\n${f.body}`;
}

/**
 * findings JSON → github の PR review へ写す。
 *
 * file と line が両方ある指摘は inline comment、どちらか欠ける指摘は
 * body の列へ（欄は落ちるが中身は落とさぬ）。state と round は出さぬ
 * ——落ちる欄は module 頭の表のとおり。
 */
export function renderGithubReview(input: ReviewInput): GithubReviewPayload {
  const inline = input.findings.filter((f) => f.file !== undefined && f.line !== undefined);
  const bodyOnly = input.findings.filter((f) => f.file === undefined || f.line === undefined);
  const event = input.findings.some((f) => f.severity === 'high' || f.severity === 'medium')
    ? 'REQUEST_CHANGES'
    : 'COMMENT';
  const parts = [input.summary.trim()];
  if (bodyOnly.length > 0) {
    parts.push(bodyOnly.map((f) => `- ${findingText(f).replace(/\n/g, '\n  ')}`).join('\n'));
  }
  if (inline.length > 0) {
    parts.push(`（行に付く指摘 ${inline.length} 件は inline comment に在る）`);
  }
  return {
    commit_id: input.head_sha,
    body: parts.join('\n\n'),
    event,
    comments: inline.map((f) => ({ path: f.file!, line: f.line!, body: findingText(f) })),
  };
}

/** task へ渡す round の JSON（語彙が同じゆえ写しはそのまま）。 */
export function renderTaskRound(input: ReviewInput): string {
  return JSON.stringify({ head_sha: input.head_sha, summary: input.summary, findings: input.findings });
}

export const FINDING_STATES: ReadonlySet<string> = new Set(['open', 'fixed', 'verified', 'deferred', 'rejected']);

/**
 * github の review の履歴を現在地の一枚へまとめる（読む側の写し）。
 * 現在値（reviewDecision 相当）と履歴の数を分けて返す——現在値だけを
 * 見て過去の CHANGES_REQUESTED を捨てぬため。
 */
export function summarizeReviews(
  reviews: { state: string; user?: string; submittedAt?: string }[],
): { counts: Record<string, number>; lines: string[] } {
  const counts: Record<string, number> = {};
  for (const r of reviews) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const lines = reviews.map(
    (r) => `${r.submittedAt ?? '刻なし'} ${r.state}${r.user ? `（${r.user}）` : ''}`,
  );
  return { counts, lines };
}
