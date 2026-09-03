/**
 * 司令を閉じる前に、外の review 台帳へ伺いを立てる門。
 *
 * # なぜ要るか
 *
 * `honden cmd done` は、受け入れ条件が覆われ軍師の是が在るかを見る。
 * **どちらも honden の中の話である。** PR に残った指摘は見ていない。
 *
 * koyori-app/task の review-findings が、その置き場になる
 * （`honden review check` で数を検め、`skills/honden-review-to-task` で書き写す）。
 * 書き写した先で high / medium が残っていれば、司令はまだ閉じられぬ。
 *
 * # 名乗り出ない
 *
 * ntfy と同じ流儀で、**設定が無ければ何もしない。**
 * honden は MIT の単体で立つ物であり、task を要る物にしてはならない。
 *
 * # 「効かなんだ」を「通ってよし」に化けさせぬ
 *
 * 外の道具は、塞がれた時も壊れた時も非 0 で終わる。
 * **終了の数だけを見ると、道具が無い・鍵が無い・網が落ちた、いずれも
 * 「塞がれた」と読める。** 逆は起きぬので安全側に見えるが、実際には
 * 「壊れておるのに塞がれたと出る」ため、原因が画面から辿れない。
 *
 * ゆえに `--json` で受け、**中身が読めた時だけ判定を信じる**。
 * 読めなければ `unknown` にして、その旨を述べたまま閉じさせぬ。
 * 頼んだ門が働かなかったときに黙って通すことはせぬ。
 */

/** 外の命を呼ぶ手。試験では注ぎ替える。 */
export type Runner = (argv: string[]) => { code: number; stdout: string; stderr: string } | null;

export const realRunner: Runner = (argv) => {
  try {
    const p = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
    const d = new TextDecoder();
    return { code: p.exitCode ?? 0, stdout: d.decode(p.stdout), stderr: d.decode(p.stderr) };
  } catch {
    return null; // 起こせなんだ。「塞がれた」ではない
  }
};

export interface GateConfig {
  /** task 側の project 鍵。これが無ければ門は名乗り出ない。 */
  project: string;
  /** 呼ぶ命。既定は `task`。道を通したい時のために設定で差せる。 */
  bin: string[];
  /** 見に行く repo（`owner/name`）。省けば task 側の既定に従う。 */
  repo?: string;
}

export type Verdict =
  | { state: 'mergeable' }
  | { state: 'blocked'; reason: string }
  | { state: 'unknown'; reason: string };

/**
 * 設定から門の構えを起こす。
 *
 * `read` は `honden config get` と同じ引き方をする手。
 * **project が無ければ null**——それが「名乗り出ない」の形である。
 */
export function gateConfig(read: (key: string) => string | undefined): GateConfig | null {
  const project = read('review.gate.project')?.trim();
  if (!project) return null;
  const bin = read('review.gate.bin')?.trim();
  const repo = read('review.gate.repo')?.trim();
  return {
    project,
    bin: bin ? bin.split(/\s+/) : ['task'],
    ...(repo ? { repo } : {}),
  };
}

/** 司令の原文から PR の番号を拾う。宣していなければ null。 */
export function prOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = (raw as Record<string, unknown>)['pr'];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 伺いを立てる。
 *
 * `--head-check` は渡さない。**司令を閉じるのと、作業樹が PR の頭に
 * 揃っているのは別の話である。** 家老が閉じる時、手元の樹は別の枝に
 * 居るのが普通で、そこで揃えを求めると常に塞がる。
 * 見たいのは「指摘が残っておらぬか」だけなので、頭の照合は task 側へ譲る。
 */
export function summaryVerdict(cfg: GateConfig, pr: number, run: Runner): Verdict {
  const argv = [
    ...cfg.bin,
    'review',
    'summary',
    '--project',
    cfg.project,
    '--pr',
    String(pr),
    '--no-head-check',
    '--json',
  ];
  if (cfg.repo) argv.push('--repo', cfg.repo);

  const r = run(argv);
  if (r === null) {
    return { state: 'unknown', reason: `${cfg.bin[0]} を起こせなんだ（入っておらぬか、道に無い）` };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    const hint = (r.stderr.trim() || r.stdout.trim() || '(何も言わぬ)').split('\n')[0]!.slice(0, 160);
    return { state: 'unknown', reason: `応えが読めなんだ（終了 ${r.code}）: ${hint}` };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { state: 'unknown', reason: '応えが物ではない' };
  }
  const o = doc as Record<string, unknown>;

  // **`blocked_reason` の有無で判ずる。** 終了の数ではない。
  // 数は「塞がれた」と「壊れた」を同じ 1 で返すが、この鍵は塞がれた時だけ埋まる。
  const why = o['blocked_reason'];
  if (why === null || why === undefined) {
    // 鍵そのものが無いなら、それは summary の応えではない
    if (!('blocked_reason' in o)) {
      return { state: 'unknown', reason: '応えに blocked_reason が無い（版が違うか、別の命の応え）' };
    }
    return { state: 'mergeable' };
  }
  return { state: 'blocked', reason: String(why) };
}
