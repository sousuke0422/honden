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
export type Runner = (
  argv: string[],
  env?: Record<string, string>,
) => { code: number; stdout: string; stderr: string } | null;

export const realRunner: Runner = (argv, env) => {
  try {
    const p = Bun.spawnSync(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      // 案件ごとに別の task へ向ける口（TASK_API_URL 等）。無ければ親のまま
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
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
  /**
   * 別の task を立てておる案件のための宛先（殿の先読み・2026-09-03）。
   * token は値でなく **env の名**で間接に指す——settings は秘密の置き場ではない。
   */
  apiUrl?: string;
  tenant?: string;
  tokenEnv?: string;
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
/**
 * api_url を書かなんだ時の暗黙の宛先（殿の定め・2026-09-03）。
 * 本番の task の API はここに居る（頁は / 、API は /api の下——実測 2026-09-04。
 * /api を欠くと暗黙の宛先が頁の 404 へ向く）。暗黙を持つのは宛先だけ——tenant と token は
 * 暗黙にすると**取り違えたまま成功**しうるゆえ、書かねば CLI 側の設定に任せる。
 */
export const DEFAULT_API_URL = 'https://task.koyori.app/api';

export function gateConfig(
  read: (key: string) => string | undefined,
  /** honden の案件 id（司令の project:）。在れば `review.gates.<id>.*` が勝つ。 */
  hondenProject?: string,
): GateConfig | null {
  // 鍵ごとに落ちる。gates.<id>.bin が無ければ gate.bin へ——半端な上書きでも壊れぬ
  const pick = (k: string): string | undefined => {
    if (hondenProject) {
      const o = read(`review.gates.${hondenProject}.${k}`)?.trim();
      if (o) return o;
    }
    return read(`review.gate.${k}`)?.trim();
  };
  const project = pick('project');
  if (!project) return null;
  const bin = pick('bin');
  const repo = pick('repo');
  const apiUrl = pick('api_url') ?? DEFAULT_API_URL;
  const tenant = pick('tenant');
  const tokenEnv = pick('token_env');
  return {
    project,
    bin: bin ? bin.split(/\s+/) : ['task'],
    ...(repo ? { repo } : {}),
    apiUrl,
    ...(tenant ? { tenant } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
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
/**
 * 宛先の env を組む。門（summary）と起票（--to task）の両方がここを通る
 * ——別の道で組むと、閉じる基準と書き込む先が別の backend になりうる。
 *
 * token は env の名で間接に指す。**名を指したのに空なら拒む**——
 * 鍵なしで叩けば CLI 側の既定の鍵で別の backend を取り違えて叩く。
 */
export function gateEnv(cfg: GateConfig): { ok: true; env?: Record<string, string> } | { ok: false; message: string } {
  if (!cfg.apiUrl && !cfg.tenant && !cfg.tokenEnv) return { ok: true };
  const env: Record<string, string> = {};
  if (cfg.apiUrl) env['TASK_API_URL'] = cfg.apiUrl;
  if (cfg.tenant) env['TASK_TENANT'] = cfg.tenant;
  if (cfg.tokenEnv) {
    const tok = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[cfg.tokenEnv];
    if (!tok) return { ok: false, message: `token_env に ${cfg.tokenEnv} を指したが、その env が空である` };
    env['TASK_TOKEN'] = tok;
  }
  return { ok: true, env };
}

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

  const ge = gateEnv(cfg);
  if (!ge.ok) return { state: 'unknown', reason: ge.message };
  const r = run(argv, ge.env);
  if (r === null) {
    return { state: 'unknown', reason: `${cfg.bin[0]} を起こせなんだ（入っておらぬか、道に無い）。bash scripts/setup_task_cli.sh で入れられる` };
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
