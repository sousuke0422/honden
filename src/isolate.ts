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
  /**
   * file の縛り（cmd_2 の実測調査に基づく・2026-09-03）。
   * 無ければ v1 のまま（--dev-bind / / = file 素通し）——今の状態が既定。
   */
  fs?: { write: string[] };
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
  const fsNode = o['fs'];
  let fs: { write: string[] } | undefined;
  if (fsNode !== undefined && fsNode !== null) {
    if (typeof fsNode !== 'object') return { ok: false, message: 'isolation.fs は枝であるべきだが、値が書いてある。' };
    const f = fsNode as Record<string, unknown>;
    if (f['default'] !== 'deny') {
      return { ok: false, message: `isolation.fs.default は deny だけを受ける（受け取った値: ${JSON.stringify(f['default'])}）。` };
    }
    const write = Array.isArray(f['write']) ? f['write'].map((x) => String(x).trim()) : [];
    for (const w of write) {
      if (!w.startsWith('/') && !w.startsWith('~/')) {
        return { ok: false, message: `isolation.fs.write の ${JSON.stringify(w)}: 絶対の道か ~/ で書かれよ。` };
      }
    }
    for (const k of Object.keys(f)) {
      if (k !== 'default' && k !== 'write') return { ok: false, message: `isolation.fs に知らぬ鍵がある: ${k}（受けるのは default / write）。` };
    }
    fs = { write };
  }
  return { ok: true, cfg: { level: 'bwrap', outbound, tcpPorts, ...(fs ? { fs } : {}) } };
}

/**
 * CLI が働くのに要る書き道（cmd_2 の実測・報告 #464）。
 *
 * `fs.default: deny` の時、`--cli` で名乗られた CLI のぶんを write へ自動で足す。
 * codex は `~/.codex` を rw にした上で **packages を ro で重ねる**——
 * 自己更新の道（#13 の事故）だけを封じ、auth や帳は書ける。
 */
export const CLI_WRITES: Record<string, { rw: string[]; ro: string[] }> = {
  claude: { rw: ['~/.claude', '~/.claude.json'], ro: [] },
  codex: { rw: ['~/.codex'], ro: ['~/.codex/packages'] },
  cursor: { rw: ['~/.cache/cursor-compile-cache', '~/.cursor', '~/.config/cursor'], ro: [] },
  opencode: { rw: ['~/.local/share/opencode', '~/.cache/opencode', '~/.config/opencode'], ro: [] },
};

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
export interface WrapOpts {
  /** 起こす CLI の名。fs の縛りで、その CLI の書き道を自動で足すのに使う。 */
  cli?: string;
  /** 道が在るかの検め。試験で注ぎ替える。 */
  exists?: (p: string) => boolean;
  /** ~ の展開先。試験で注ぎ替える。 */
  home?: string;
}

/**
 * fs の縛りの bwrap 引数を組む（cmd_2 の実測どおり）。
 *
 *   --ro-bind / / を**先に**（後の rw が勝つ。順序を誤ると /tmp まで ro・実測 D）
 *   --dev /dev と --proc /proc --unshare-pid は**必須**（抜くと /dev/null が
 *     EACCES で道具が悉く壊れ、母屋の process が見える・実測 C）
 *   /tmp は --tmpfs で専有（母屋と共有すると socket 置換の道・実測 罠2）
 *   rw の道に .git が在れば hooks と config を ro で重ねる（檻の中から
 *     pre-commit を仕込ませぬ・実測 罠1。commit そのものはできる）
 */
export function fsArgs(
  fs: { write: string[] },
  cli: string | undefined,
  exists: (p: string) => boolean,
  home: string,
): string[] {
  const expand = (p: string) => (p.startsWith('~/') ? home + p.slice(1) : p);
  const rw: string[] = fs.write.map(expand);
  const ro: string[] = [];
  const need = cli ? CLI_WRITES[cli] : undefined;
  if (need) {
    rw.push(...need.rw.map(expand));
    ro.push(...need.ro.map(expand));
  }
  // tmpfs は ro の直後・rw の**前**。後に置くと /tmp 配下の rw 許しが
  // tmpfs の影に覆われて消える（実機 E2E が釣った・2026-09-03）
  const args = ['--ro-bind', '/', '/', '--tmpfs', '/tmp'];
  for (const p of [...new Set(rw)]) {
    if (!exists(p)) continue; // 無い道は bind できぬ。CLI 初回起動前などは黙って飛ばす
    args.push('--bind', p, p);
    // .git の守り
    for (const g of [`${p}/.git/hooks`, `${p}/.git/config`]) {
      if (exists(g)) args.push('--ro-bind', g, g);
    }
  }
  for (const p of [...new Set(ro)]) {
    if (exists(p)) args.push('--ro-bind', p, p);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--unshare-pid');
  return args;
}

export function wrapLaunch(
  cfg: IsolationCfg,
  inner: string,
  /** 口の許し（tcpPorts）を使う時の檻の在り処。無ければ呼び手が先に拒む。 */
  cageBin?: string,
  opts: WrapOpts = {},
): { ok: true; cmd: string } | { ok: false; message: string } {
  if (cfg.level === 'none') return { ok: true, cmd: inner };
  if (inner.includes("'")) {
    return { ok: false, message: `起こす命に単引用が含まれ、包めぬ: ${inner}` };
  }
  const exists = opts.exists ?? ((p: string) => require('node:fs').existsSync(p));
  const home = opts.home ?? require('node:os').homedir();
  const binds = cfg.fs ? fsArgs(cfg.fs, opts.cli, exists, home).join(' ') : '--dev-bind / /';
  if (!cfg.outbound && cfg.tcpPorts.length === 0) {
    // 外も要らぬなら pasta ごと要らぬ。bwrap が網を切る（空の loopback だけ残る）
    return { ok: true, cmd: `bwrap ${binds} --die-with-parent --unshare-net -- bash -lc '${inner}'` };
  }
  let core = `bash -lc '${inner}'`;
  if (cfg.tcpPorts.length > 0) {
    if (!cageBin) return { ok: false, message: '口の許し（tcp/<口>）には honden-cage が要るが、在り処が渡されておらぬ。' };
    // 檻が最も内側。pasta（母屋の隔て）→ bwrap（束ね）→ 檻（口の枷）→ CLI
    const flags = cfg.tcpPorts.map((p) => `--tcp ${p}`).join(' ');
    core = `${cageBin} ${flags} -- ${core}`;
  }
  const bw = `bwrap ${binds} --die-with-parent -- ${core}`;
  return { ok: true, cmd: `pasta --config-net -T none -U none --quiet -- ${bw}` };
}

/**
 * 名前引きが pasta の中で死ぬ機かを、resolv.conf から先に見る。
 *
 * DNS は UDP/53 ゆえ檻（TCP のみ）は触れぬが、**宛先が母屋の loopback
 * （systemd-resolved の 127.0.0.53 など）だと、pasta の中の loopback は
 * 空ゆえ引けぬ**。しかも症状は「名前だけ引けぬ」で、原因が画面から遠い。
 * WSL の resolv.conf は外の宛先を向くゆえ効かぬが、別の機では踏む。
 */
export function dnsWarning(resolvText: string): string | null {
  const ns = resolvText
    .split('\n')
    .map((l) => /^\s*nameserver\s+(\S+)/.exec(l)?.[1])
    .filter((x): x is string => Boolean(x));
  if (ns.length === 0) return null; // 書式が読めぬ時は黙る（別系の resolver かもしれぬ）
  const loop = (a: string) => a.startsWith('127.') || a === '::1';
  if (ns.every(loop)) {
    return (
      `名前引きが母屋の loopback（${ns.join(', ')}）だけを向いておる。\n` +
      '    pasta の中の loopback は空ゆえ、隔離の中では名前が引けぬ。\n' +
      '    resolv.conf を外の宛先へ向けるか、pasta の --dns-forward の普請が要る。'
    );
  }
  return null;
}
