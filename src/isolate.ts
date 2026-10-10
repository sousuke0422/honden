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

import { lstatSync, realpathSync } from 'node:fs';
import { shellQuote } from './config';

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
 * 中の命は `bash -lc` に**単引用で**渡す。tmux send-keys を経るゆえ、二重引用では
 * `!` が履歴の展開に食われる。中身の単引用は `'\''` で抜けて包む（足軽ごとの env の
 * 値が単引用で来る）。前は拒んでおったが、抜けば包めぬ形は残らぬ。
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
  /**
   * codex の足軽の実効の CODEX_HOME（settings の env。src/config.ts の codexHomeOf）。
   * 在れば codex の書き道の `~/.codex` を置き換える。無ければ従来どおり `~/.codex`。
   */
  codexHome?: string;
}

/** 道を比べる形に均す。判じを通った絶対の道（.. を含まぬ）ゆえ、// と尻の / を畳むだけでよい。 */
function canon(p: string): string {
  const q = p.replace(/\/+/g, '/');
  return q.length > 1 ? q.replace(/\/$/, '') : q;
}
const within = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);

/**
 * 隔離の下で、CODEX_HOME として rw で bind してはならぬ道か。ならぬなら訳を返す。
 *
 * - `/tmp` の下: 檻は /tmp を tmpfs で専有する。bind しても tmpfs の影に隠れ、
 *   codex が書く先は檻の中だけの空の道になる（母屋の道と食い違い、信頼も auth も消える）
 * - `$HOME` そのものと、その祖先（`/` を含む）: 家ごと rw になり、fs.default: deny が飾りになる
 * - `~/.honden` の下と、正本の在る dir: 本陣の正本を檻の中から書き換えられる
 * - honden の repo の内・その祖先: repo の `.codex/hooks.json` と皮は門の繋ぎである。
 *   rw になれば、檻の中から門を外せる
 *
 * **字面だけでなく実体（symlink を解いた道）でも判じる。** `~/.codex-a3 → ~/.honden` の
 * ような別名を字面で見ると、どの拒みにも掛からぬまま、bwrap は別名の先（実体）を rw に
 * bind する。ゆえに CODEX_HOME は実体に解き、守る側も字面と実体の両方を並べて比べる
 * （`/tmp` や `$HOME` そのものが symlink の機もある）。道の要素に symlink が在ること
 * そのものは拒まぬ——`/home → /var/home` のように家の祖先が symlink の機を巻き添えに
 * するゆえ。bwrap が rw にするのは実体ゆえ、実体で比べれば足りる。解けぬ symlink
 * （壊れた・輪になった）は実体が判ぜぬゆえ拒む。
 */
export function isolatedCodexHomeProblem(
  path: string,
  where: { home: string; dbDir?: string; repoRoot?: string },
): string | null {
  const real = realOrNearest(path);
  if (real === null) return '解けぬ symlink（壊れておるか、輪になっておる）を道に持つ。実体が判ぜぬゆえ受けぬ';
  const ps = [...new Set([canon(path), real])];
  const forms = (x: string) => [...new Set([canon(x), realOrNearest(x) ?? canon(x)])];
  const via = (p: string) => (p === canon(path) ? '' : `（実体: ${p}）`);
  for (const p of ps) {
    for (const t of forms('/tmp')) {
      if (within(p, t)) return `/tmp の下である${via(p)}。檻は /tmp を tmpfs で専有するゆえ、bind しても隠れ、codex は母屋と違う空の道へ書く`;
    }
    for (const home of forms(where.home)) {
      if (within(home, p)) {
        return p === home
          ? `$HOME そのものである${via(p)}。家ごと rw になり、fs の縛りが飾りになる`
          : `$HOME（${home}）の祖先である${via(p)}。家ごと rw になり、fs の縛りが飾りになる`;
      }
    }
    for (const d of [`${canon(where.home)}/.honden`, ...(where.dbDir ? [where.dbDir] : [])].flatMap(forms)) {
      if (within(p, d) || within(d, p)) return `本陣の正本の在り処（${d}）に掛かる${via(p)}。檻の中から正本を書き換えられる`;
    }
    for (const r of where.repoRoot ? forms(where.repoRoot) : []) {
      if (within(p, r) || within(r, p)) return `honden の repo（${r}）に掛かる${via(p)}。門の繋ぎ（.codex/hooks.json と皮）が檻の中から書ける`;
    }
  }
  return null;
}

/**
 * 道の実体（symlink を解いた道）。在らぬ区画は、いちばん近い在る祖先の実体に、残りの区画を
 * 継いで返す（まだ作られておらぬ CODEX_HOME も、在る祖先の実体で判じられる）。在るのに
 * 解けぬ区画（壊れた symlink・輪）が在れば null。隔離の判じと bind の両方がこの値を使い、
 * 判じた道と bwrap へ渡す道を字面で一つに揃える。
 */
export function realOrNearest(path: string): string | null {
  const parts = canon(path).split('/').filter((x) => x !== '');
  for (let i = parts.length; i >= 0; i -= 1) {
    const head = `/${parts.slice(0, i).join('/')}`;
    let real: string;
    try {
      real = realpathSync(head);
    } catch {
      try {
        lstatSync(head);
        return null; // 在るのに解けぬ（壊れた symlink・輪）
      } catch {
        continue; // 在らぬ区画。祖先へ上る
      }
    }
    return canon([real, ...parts.slice(i)].join('/'));
  }
  return null;
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
/**
 * 一つの檻が rw で持つ道と、ro で重ねる道（~ は展開済み。在る無しは問わぬ）。
 * fsArgs（bwrap の引数）と、檻どうしの重なりの判じ（codexHomeSwappable）の両方がここから組む。
 */
export function cageWrites(
  fs: { write: string[] },
  cli: string | undefined,
  home: string,
  /** codex の足軽の実効の CODEX_HOME。在れば `~/.codex` に代えて rw、その packages を ro で重ねる */
  codexHome?: string,
): { rw: string[]; ro: string[] } {
  const expand = (p: string) => (p.startsWith('~/') ? home + p.slice(1) : p);
  const rw: string[] = fs.write.map(expand);
  const ro: string[] = [];
  // 足軽ごとの CODEX_HOME も、~/.codex と同じ守り（rw の上に packages を ro・#13 の封じ）で載せる
  const need =
    cli === 'codex' && codexHome ? { rw: [codexHome], ro: [`${codexHome}/packages`] } : cli ? CLI_WRITES[cli] : undefined;
  if (need) {
    rw.push(...need.rw.map(expand));
    ro.push(...need.ro.map(expand));
  }
  return { rw, ro };
}

/**
 * 判じてから檻が起こるまでの間に、CODEX_HOME（の実体）を差し替えうる檻が在るか。在れば訳を返す。
 *
 * **差し替えを打てるのは、檻の中の足軽が rw で持つ道だけと定める。** 足軽と本陣は同じ uid ゆえ、
 * 檻の外の手（人・将軍）は数えぬ（檻の外では何でも書ける）。陣の全ての檻の rw の道と、
 * CODEX_HOME の実体が重なれば——その道の内に在る（祖先ごと rename・symlink に差し替えられる）、
 * その道と同じ（他の檻が中身を書き、packages を差し替えられる）、その道を内に持つ——止める。
 *
 * 己の檻の、己の CODEX_HOME の項だけは数えぬ。檻の中ではそこが bind の mount 点ゆえ、
 * rename も rmdir も EBUSY で断られ、差し替えられぬ（実機の bwrap で確かめた・cmd_224）。
 * 呼び手は、己の檻の rw をその項を除いて渡すこと。
 */
export function codexHomeSwappable(codexHome: string, cages: { who: string; rw: string[] }[]): string | null {
  const real = realOrNearest(codexHome) ?? canon(codexHome);
  for (const c of cages) {
    for (const w of c.rw) {
      const p = realOrNearest(w) ?? canon(w);
      if (within(real, p) || within(p, real)) {
        const how = real === p ? 'と同じ道である' : within(real, p) ? 'の内に在る' : 'を内に持つ';
        return `${c.who} の檻が rw で持つ道（${p}）${how}。判じてから檻が起こるまでの間に、その檻の中から道を symlink 等に差し替えられる`;
      }
    }
  }
  return null;
}

/**
 * `<CODEX_HOME>/packages` が symlink か。symlink なら訳を返す。packages が無い時は ro の bind が
 * 飛ばされ、檻の中から packages を symlink として作れる（cmd_224 で確かめた）。次に起こす時の
 * `--ro-bind` は symlink の先を ro で檻へ見せる——正本を読ませる形を塞ぐ。
 */
export function codexPackagesProblem(codexHome: string): string | null {
  try {
    if (lstatSync(`${canon(codexHome)}/packages`).isSymbolicLink()) {
      return 'packages が symlink である。次の --ro-bind はその先（守る物かもしれぬ）を檻へ見せる';
    }
  } catch {
    /* 無ければ問わぬ */
  }
  return null;
}

export function fsArgs(
  fs: { write: string[] },
  cli: string | undefined,
  exists: (p: string) => boolean,
  home: string,
  /** codex の足軽の実効の CODEX_HOME。在れば `~/.codex` に代えて rw、その packages を ro で重ねる */
  codexHome?: string,
): string[] {
  const { rw, ro } = cageWrites(fs, cli, home, codexHome);
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
  // **命は argv の配列で組み、最後に一つの口（shellArg）で引用して連ねる。**
  // 文を継ぎ足すと、bind の道（足軽ごとの CODEX_HOME・fs.write）に $(…)・backtick・; が
  // 在れば、檻に入る前にホストの shell が解いて走らせる（#43 の再レビュー）。
  // 内の命（`bash -lc '…'`）も同じ口を通る——命に単引用が在れば `'\''` で抜けて包み、
  // 外の shell が解けば、元の命が一字違わず戻る。
  const exists = opts.exists ?? ((p: string) => require('node:fs').existsSync(p));
  const home = opts.home ?? require('node:os').homedir();
  const binds = cfg.fs ? fsArgs(cfg.fs, opts.cli, exists, home, opts.codexHome) : ['--dev-bind', '/', '/'];
  const shellCmd = ['bash', '-lc', inner];
  // 内の命（argv の最後）は、一語でも前どおり単引用で包む（pane に出る見た目を変えぬ）
  const line = (argv: string[]) => ({
    ok: true as const,
    cmd: argv.map((a, i) => (i === argv.length - 1 ? shellQuote(a) : shellArg(a))).join(' '),
  });
  if (!cfg.outbound && cfg.tcpPorts.length === 0) {
    // 外も要らぬなら pasta ごと要らぬ。bwrap が網を切る（空の loopback だけ残る）
    return line(['bwrap', ...binds, '--die-with-parent', '--unshare-net', '--', ...shellCmd]);
  }
  let core = shellCmd;
  if (cfg.tcpPorts.length > 0) {
    if (!cageBin) return { ok: false, message: '口の許し（tcp/<口>）には honden-cage が要るが、在り処が渡されておらぬ。' };
    // 檻が最も内側。pasta（母屋の隔て）→ bwrap（束ね）→ 檻（口の枷）→ CLI
    core = [cageBin, ...cfg.tcpPorts.flatMap((p) => ['--tcp', String(p)]), '--', ...core];
  }
  return line(['pasta', '--config-net', '-T', 'none', '-U', 'none', '--quiet', '--', 'bwrap', ...binds, '--die-with-parent', '--', ...core]);
}

/**
 * 包む命の引数を一つ、shell の引数として引用する。**引用の口はここ一つ**（中身は
 * src/config.ts の shellQuote——env の前置きと同じ単引用の作法）。引用の要らぬ字
 * （英数と `/ . _ - : = , @ % +`）だけの引数は素のまま返し、普段の命の見た目を変えぬ。
 */
export function shellArg(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
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
