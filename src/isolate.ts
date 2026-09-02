/**
 * 隔離（床）— 足軽の CLI を、網を縛った名前空間の中で起こす。
 *
 * # 何を縛り、何を縛らぬ):
 *
 * v1 が縛るのは**網**だけである。母屋の loopback（`127.0.0.1` で待つ常駐の口）へ
 * 届かず、外（記事・git・API）へは届く。file の縛りは後の段。
 *
 * 形（実測は Issue #12。五行の表で確かめた・2026-09-01）:
 *
 * ```
 * pasta --config-net -T none -U none -- bwrap <束ね> -- bash -lc '<CLI>'
 * ```
 *
 * 順序が肝である。**pasta が名前空間を作り、その中で bwrap が束ねる。**
 * bwrap へ `--unshare-net` を渡すと pasta の路まで切れて外へ出られなくなる。
 * `-T none -U none` は省けない——pasta の既定（auto）は名前空間の口を母屋へ
 * 橋渡しし、母屋の loopback が中から見える。**pasta は既定では隔てない。**
 *
 * # 黙って弱い方へ倒れない
 *
 * 三箇所とも、頼んで得られなかったときは**起動を拒む**。
 *
 *   未実装の段（systemd-run / lxc）      予約語。受けるが起こさぬ
 *   縛れぬ規則（udp/<口>）               Landlock の網は TCP のみ。拒む
 *   道具（pasta / bwrap / 檻）が無い      包む所で止まる
 *
 * 「隔離したつもり」を作らない。層は放っておくと fail-open として生まれる
 * （#12 冒頭の表がその記録である）。
 *
 * # 既定は none — 今の状態
 *
 * 設定に `isolation:` が無ければ何もしない（殿の下知・2026-09-02）。
 * ntfy や review gate と同じ流儀——繋いだ時だけ効く。
 */

export const LEVELS = ['none', 'bwrap', 'systemd-run', 'lxc'] as const;
export type Level = (typeof LEVELS)[number];

/** v1 で実装済みの段。残りは予約語で、書かれたら起動を拒む。 */
export const IMPLEMENTED: readonly Level[] = ['none', 'bwrap'];

export interface IsolationCfg {
  level: Level;
  /** `outbound`（外へ全開）が書かれておるか。 */
  outbound: boolean;
  /**
   * `tcp/<口>` の許し。fw 機器の流儀の口指定（殿の求め・2026-09-02）。
   * 空でなければ honden-cage（Landlock）が「この口へしか connect できぬ」枷をはめる。
   * `outbound` とは混ぜられぬ——広い方が勝って口の意図が消える。
   */
  tcpPorts: number[];
}

export type ParseResult = { ok: true; cfg: IsolationCfg } | { ok: false; message: string };

/**
 * settings.yaml の `isolation:` を解く。
 *
 * fw 機器の流儀（既定拒否・明示許可）で書く。v1 が受ける形は狭い——
 * **書けるが効かぬ規則を受けると、書いた者は守られたつもりになる**ゆえ、
 * 支えられぬ物は名指しで拒む。
 *
 * ```yaml
 * isolation:
 *   level: bwrap
 *   net:
 *     default: deny
 *     allow:
 *       - outbound        # 外へは通す（pasta が与える粒度そのまま）
 * ```
 */
export function parseIsolation(doc: unknown): ParseResult {
  const none: IsolationCfg = { level: 'none', outbound: false, tcpPorts: [] };
  if (typeof doc !== 'object' || doc === null) return { ok: true, cfg: none };
  const iso = (doc as Record<string, unknown>)['isolation'];
  if (iso === undefined || iso === null) return { ok: true, cfg: none }; // 書かねば今の状態
  if (typeof iso !== 'object') return { ok: false, message: 'isolation は枝であるべきだが、値が書いてある。' };

  const o = iso as Record<string, unknown>;
  const level = typeof o['level'] === 'string' ? o['level'].trim() : 'none';
  if (!(LEVELS as readonly string[]).includes(level)) {
    return { ok: false, message: `isolation.level: ${level} は知らぬ段である（${LEVELS.join(' / ')}）。` };
  }
  if (!IMPLEMENTED.includes(level as Level)) {
    // 予約語。**「隔離なし」に落とさぬ**——設定した者は隔離したつもりでいる
    return {
      ok: false,
      message:
        `isolation.level: ${level} はまだ実装されておらぬ（予約語）。\n` +
        `  隔離を頼んで得られぬまま起こすことはせぬ。bwrap を使うか、isolation を外されよ。`,
    };
  }
  if (level === 'none') return { ok: true, cfg: none };

  const net = o['net'];
  if (typeof net !== 'object' || net === null) {
    return { ok: false, message: 'isolation.level: bwrap には net の節が要る（default: deny と allow）。' };
  }
  const n = net as Record<string, unknown>;
  if (n['default'] !== 'deny') {
    // 既定拒否だけを受ける。`allow` を既定にすると、書き漏らしが全通しになる
    return { ok: false, message: `isolation.net.default は deny だけを受ける（受け取った値: ${JSON.stringify(n['default'])}）。` };
  }
  const allow = Array.isArray(n['allow']) ? n['allow'] : [];
  let outbound = false;
  const tcpPorts: number[] = [];
  for (const a of allow) {
    const s = String(a).trim();
    if (s === 'outbound') { outbound = true; continue; }
    const m = /^tcp\/(\d+)$/.exec(s);
    if (m) {
      const port = Number(m[1]);
      if (port < 1 || port > 65535) return { ok: false, message: `isolation.net.allow の ${s}: 口は 1〜65535。` };
      tcpPorts.push(port);
      continue;
    }
    if (/^udp\/\d+$/.test(s)) {
      // Landlock の網は TCP だけ。縛れぬ規則を受けると、書いた者は守られたつもりになる
      return {
        ok: false,
        message:
          `isolation.net.allow の ${s} は縛れぬ——Landlock の網は TCP の口だけを見る。\n` +
          `  UDP を口で濾す段はまだ無い。tcp/<口> か outbound を使われよ。`,
      };
    }
    return { ok: false, message: `isolation.net.allow に知らぬ形がある: ${JSON.stringify(a)}（受けるのは outbound / tcp/<口>）。` };
  }
  if (outbound && tcpPorts.length > 0) {
    // 広い方（outbound）が勝ち、口の並びが飾りになる。書いた意図が判ぜぬゆえ拒む
    return { ok: false, message: 'isolation.net.allow に outbound と tcp/<口> が混ざっておる。どちらか一方に。' };
  }
  if (n['deny'] !== undefined) {
    return { ok: false, message: 'isolation.net.deny は受けぬ。既定が deny であり、許す物だけを並べる。' };
  }
  return { ok: true, cfg: { level: 'bwrap', outbound, tcpPorts } };
}

/** この構えで要る道具。出陣の関所が在るかを確かめる。 */
export function requiredTools(cfg: IsolationCfg): string[] {
  if (cfg.level !== 'bwrap') return [];
  // 口の許しも外へ出る形ゆえ pasta が要る（母屋の隔てと NAT）。檻はその内側
  return cfg.outbound || cfg.tcpPorts.length > 0 ? ['bwrap', 'pasta'] : ['bwrap'];
}

/**
 * 一体を起こす命を包む。
 *
 * 中の命は `bash -lc` に**単引用で**渡す。tmux send-keys を経るゆえ、
 * 中身に単引用があれば包めぬ——その時は拒む（黙って裸で起こさぬ）。
 *
 * file は縛らぬ（`--dev-bind / /`）。v1 の床は網だけである。
 * `--die-with-parent` で、pane が消えれば中身も残らぬ。
 */
export function wrapLaunch(
  cfg: IsolationCfg,
  inner: string,
  /** 口の許し（tcpPorts）を使う時の檻の在り処。無ければ呼び手が先に拒む。 */
  cageBin?: string,
): { ok: true; cmd: string } | { ok: false; message: string } {
  if (cfg.level === 'none') return { ok: true, cmd: inner };
  if (inner.includes("'")) {
    return { ok: false, message: `起こす命に単引用が含まれ、包めぬ: ${inner}` };
  }
  if (!cfg.outbound && cfg.tcpPorts.length === 0) {
    // 外も要らぬなら pasta ごと要らぬ。bwrap が網を切る（空の loopback だけ残る）
    return { ok: true, cmd: `bwrap --dev-bind / / --die-with-parent --unshare-net -- bash -lc '${inner}'` };
  }
  let core = `bash -lc '${inner}'`;
  if (cfg.tcpPorts.length > 0) {
    if (!cageBin) return { ok: false, message: '口の許し（tcp/<口>）には honden-cage が要るが、在り処が渡されておらぬ。' };
    // 檻が最も内側。pasta（母屋の隔て）→ bwrap（束ね）→ 檻（口の枷）→ CLI
    const flags = cfg.tcpPorts.map((p) => `--tcp ${p}`).join(' ');
    core = `${cageBin} ${flags} -- ${core}`;
  }
  const bw = `bwrap --dev-bind / / --die-with-parent -- ${core}`;
  return { ok: true, cmd: `pasta --config-net -T none -U none --quiet -- ${bw}` };
}
