/**
 * レビュー指摘を、投入する前に検める。
 *
 * # なぜ要るか
 *
 * `/honden-review` は人向けの markdown を吐く。それを task へ入れるのは、
 * **後から走らせる別のスキル**が己の指摘を構造へ書き写す形になる
 * （スキル自体は改めぬ・殿の下知 2026-08-31）。
 *
 * ゆえに危ういのは「書式のずれ」ではない。**書き写す時の落とし・言い換え・
 * 作り足し**である。人が目で見比べても気づけぬ——指摘が十件あれば、
 * 一件消えても読み手には分からぬ。
 *
 * ここは**機械が数える**所である。
 *
 * # 何を検めるか
 *
 * 一、投入先の約定（severity の綴り・要る欄・`head_sha` の形）
 * 二、**申告した件数と、実際の件数が合うか**（落とし・作り足しの検め）
 * 三、**💥 の印が付いた指摘は `high` になっておるか**（言い換えの検め）
 *
 * 二番目が肝である。書き写す者に「重大度ごとに何件か」を先に言わせ、
 * 出来上がった物と突き合わせる。**同じ者が両方を書くゆえ完全ではない**——
 * 数え違いと書き落としが同時に起きれば通る。だが一方だけの誤りは必ず捕らえる。
 *
 * # 重大度の対応づけ
 *
 * task は四段階で `critical` を持たぬ（綴り違いは投入時に弾かれる）。
 * `/honden-review` は五段階。**💥 Critical と 🚨 High が一つに潰れる。**
 *
 * 潰れてもマージを止めるか否かは変わらぬ（task では `high` も `medium` も
 * 止める）。失うのは表示の細かさだけゆえ、**題の頭に 💥 を残して見分ける**。
 */

/** 投入先が受ける重大度。**`critical` は無い。** */
export const SEVERITIES = ['high', 'medium', 'low', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `/honden-review` の印と、投入先の重大度の対応。 */
export const BADGE_TO_SEVERITY: Record<string, Severity> = {
  '💥': 'high', // Critical。潰れる先ゆえ題に印を残す
  '🚨': 'high',
  '🔴': 'medium',
  '🟡': 'low',
  '🔵': 'nit',
};

/** 潰れる印。これが付いた題は `high` でなければならぬ。 */
export const COLLAPSED_BADGE = '💥';

/** commit の名。**40 桁の小文字 16 進のみ。** */
export const SHA_RE = /^[0-9a-f]{40}$/;

export interface Finding {
  severity: string;
  title: string;
  body: string;
  file?: string;
  line?: number;
}

export interface Payload {
  head_sha?: string;
  summary?: string;
  findings?: unknown;
}

export type Tally = Partial<Record<Severity, number>>;

export interface Problem {
  /** どの指摘の、どの欄か。**添字を必ず添える**——十件あれば人は探せぬ */
  where: string;
  what: string;
}

/**
 * 申告を解く。`high=2,medium=3` の形。
 *
 * **知らぬ名は捨てぬ。** 捨てれば「申告した物が数に入っておらぬ」状態が
 * 黙って生まれ、突き合わせが素通りになる。
 */
export function parseTally(s: string): { ok: true; tally: Tally } | { ok: false; message: string } {
  const tally: Tally = {};
  for (const part of s.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const m = /^([a-z]+)=(\d+)$/.exec(t);
    if (!m) return { ok: false, message: `申告の形が違う: ${t}（high=2,medium=3 の形で書かれよ）` };
    const k = m[1] as Severity;
    if (!(SEVERITIES as readonly string[]).includes(k)) {
      return { ok: false, message: `知らぬ重大度: ${k}（${SEVERITIES.join(' / ')} のいずれか）` };
    }
    tally[k] = Number(m[2]);
  }
  if (Object.keys(tally).length === 0) return { ok: false, message: '申告が空である' };
  return { ok: true, tally };
}

/** 実際の件数を数える。 */
export function tallyOf(findings: Finding[]): Tally {
  const t: Tally = {};
  for (const f of findings) {
    const s = f.severity as Severity;
    if ((SEVERITIES as readonly string[]).includes(s)) t[s] = (t[s] ?? 0) + 1;
  }
  return t;
}

/**
 * 一件ずつ検める。**添字を必ず添える。**
 *
 * 「title is required」だけでは、十件のどれか分からぬ。投入先の CLI も
 * 同じ流儀で `findings[0].severity` と言うており、そこへ揃える。
 */
export function checkFinding(f: unknown, i: number): Problem[] {
  const at = (k: string) => `findings[${i}].${k}`;
  const out: Problem[] = [];
  if (typeof f !== 'object' || f === null) {
    return [{ where: `findings[${i}]`, what: '物ではない' }];
  }
  const o = f as Record<string, unknown>;

  const sev = o['severity'];
  if (typeof sev !== 'string' || sev === '') {
    out.push({ where: at('severity'), what: '要る' });
  } else if (!(SEVERITIES as readonly string[]).includes(sev)) {
    // **`critical` はここで死ぬ。** 投入先が受けぬ綴りを手前で止める
    out.push({ where: at('severity'), what: `知らぬ重大度「${sev}」（${SEVERITIES.join(' / ')} のいずれか）` });
  }

  const title = o['title'];
  if (typeof title !== 'string' || title.trim() === '') out.push({ where: at('title'), what: '要る' });

  const body = o['body'];
  if (typeof body !== 'string' || body.trim() === '') out.push({ where: at('body'), what: '要る' });

  const line = o['line'];
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    out.push({ where: at('line'), what: '整数（1 以上）でなければならぬ' });
  }

  const file = o['file'];
  if (file !== undefined && (typeof file !== 'string' || file.trim() === '')) {
    out.push({ where: at('file'), what: '空にするなら欄ごと落とせ' });
  }

  // **💥 の印は `high` でなければならぬ。** 潰した先を取り違えれば、
  // マージを止めるべき指摘が繰り延べ可の箱に入る
  if (typeof title === 'string' && title.trimStart().startsWith(COLLAPSED_BADGE) && sev !== 'high') {
    out.push({
      where: at('severity'),
      what: `${COLLAPSED_BADGE} が付いておるのに ${String(sev)}。Critical は high へ潰す定めである`,
    });
  }

  return out;
}

export interface CheckResult {
  ok: boolean;
  problems: Problem[];
  /** 実際に数えた件数。通っても落ちても返す——人が目で見るため */
  actual: Tally;
}

/**
 * 投入する物ぜんたいを検める。
 *
 * `expected` を渡せば、申告と実際を突き合わせる。渡さねばその検めは行わぬ
 * ——**「申告しておらぬ」と「申告が合うた」を混ぜぬ**。
 */
export function check(payload: unknown, expected?: Tally): CheckResult {
  const problems: Problem[] = [];
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, problems: [{ where: '（全体）', what: 'JSON の物ではない' }], actual: {} };
  }
  const p = payload as Payload;

  const sha = p.head_sha;
  if (typeof sha !== 'string' || sha === '') {
    problems.push({ where: 'head_sha', what: '要る' });
  } else if (!SHA_RE.test(sha)) {
    // 短縮を渡すと、そのラウンドは指摘を全部解消しても通らなくなる。
    // しかも「同じ commit に見えるのに再レビューを要求される」形で出るゆえ、
    // 画面から原因を辿れぬ。**取る所で確かめる。**
    problems.push({
      where: 'head_sha',
      what: `40 桁の小文字 16 進でなければならぬ（${sha.slice(0, 12)}…）。` +
        'git rev-parse か gh pr view --json headRefOid で取れ',
    });
  }

  const raw = p.findings;
  if (!Array.isArray(raw)) {
    problems.push({ where: 'findings', what: '一覧でなければならぬ（指摘ゼロなら空の一覧）' });
    return { ok: false, problems, actual: {} };
  }
  raw.forEach((f, i) => problems.push(...checkFinding(f, i)));

  const actual = tallyOf(raw as Finding[]);

  if (expected) {
    for (const s of SEVERITIES) {
      const want = expected[s] ?? 0;
      const got = actual[s] ?? 0;
      if (want !== got) {
        problems.push({
          where: `件数（${s}）`,
          what: `申告 ${want} 件に対し ${got} 件。**書き写す時に落としたか、足したか**`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, actual };
}

/** 人が読む形へ。通った時も件数を出す——黙って通せば、検めたことが見えぬ。 */
export function render(r: CheckResult, expected?: Tally): string {
  const counts = SEVERITIES.map((s) => `${s}=${r.actual[s] ?? 0}`).join(' ');
  if (r.ok) {
    return `  検めを通った（${counts}）${expected ? '・申告と一致' : '・申告は渡されておらぬ'}`;
  }
  return [`  投入せぬ。${r.problems.length} 件の不備がある（${counts}）:`, ...r.problems.map((p) => `    ${p.where}: ${p.what}`)].join('\n');
}
