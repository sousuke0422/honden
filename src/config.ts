/**
 * 環境の設定を読む狭い口。
 *
 * ## なぜ狭くするか
 *
 * 現行では shell が YAML を直に読んでおる。`lib/cli_adapter.sh` の
 * python 呼び出し 17 箇所は、**すべて `config/settings.yaml` を読むため**である
 * （実測 2026-08-26）。そのために PyYAML だけを入れた venv が要る。
 *
 * honden は `Bun.YAML` を内に持つので、その venv は要らなくなる。
 * だが**汎用の YAML 読み口は開けない**。
 *
 *   honden yaml get <ファイル> <path>
 *
 * これを作ると、それが honden を迂回する道になる。誰かが
 * `queue/tasks/ashigaru1.yaml` を直に読み、`honden task` を通らなくなる。
 * 殿が閉じたかったのは、まさにその経路である。
 *
 * ## 設定の在り処は名簿を入れた時に覚える
 *
 * 引数でファイルを取らない。取れば汎用の読み口と同じになる。
 * `honden roster sync --settings <path>` が唯一の入口で、そこで覚える。
 *
 * ## 枝は返さない
 *
 * `cli.agents` のような枝を求められたら、値を並べて返すのではなく断る。
 * YAML や JSON を吐くと、受け取った shell がそれを解きにかかる——
 * **解く仕事を shell へ戻してしまう。** 何が下に在るかだけ示す。
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { type Cli, isCli } from './rosteredit';
import { getSetting } from './settings';

export const SETTINGS_PATH_KEY = 'settings_path';

export interface ConfigResult {
  ok: boolean;
  /** 見つかった値。scalar のみ。 */
  value?: string;
  message?: string;
}

export function settingsPath(db: Database): string | null {
  return getSetting(db, SETTINGS_PATH_KEY);
}

/** 覚えた設定を読む。 */
export function load(db: Database): { ok: true; doc: unknown; path: string } | { ok: false; message: string } {
  const p = settingsPath(db);
  if (!p) {
    return {
      ok: false,
      message:
        '設定の在り処を覚えておらぬ。\n' +
        '  honden roster sync --settings <settings.yaml> で入れられよ。\n' +
        '  そこが唯一の入口である——ここでファイルを取ると、汎用の YAML 読み口になり、\n' +
        '  honden を迂回する道が開く。',
    };
  }
  try {
    return { ok: true, doc: Bun.YAML.parse(readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { ok: false, message: `${p} を読めぬ: ${String(e).slice(0, 160)}` };
  }
}

/** `cli.agents.karo.model` のような道を辿る。数字は一覧の添字。 */
export function dig(doc: unknown, dotted: string): { kind: 'scalar'; value: string } | { kind: 'branch'; keys: string[] } | { kind: 'none'; at: string } {
  const parts = dotted.split('.').filter((s) => s !== '');
  let cur: unknown = doc;
  const walked: string[] = [];
  for (const p of parts) {
    walked.push(p);
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { kind: 'none', at: walked.join('.') };
      cur = cur[i];
      continue;
    }
    if (cur === null || typeof cur !== 'object') return { kind: 'none', at: walked.join('.') };
    if (!(p in (cur as Record<string, unknown>))) return { kind: 'none', at: walked.join('.') };
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === null) return { kind: 'scalar', value: '' };
  if (Array.isArray(cur)) return { kind: 'branch', keys: cur.map((_, i) => String(i)) };
  if (typeof cur === 'object') return { kind: 'branch', keys: Object.keys(cur as Record<string, unknown>) };
  return { kind: 'scalar', value: String(cur) };
}

/**
 * 足軽ごとの env で許す名。
 *
 * **名簿で許す。すべては許さぬ。** env の値は起こす命の字面に載り、tmux の pane・
 * shell の履歴・`ps` に残る。何でも許せば、API の鍵や token をここへ書く道が開く。
 * 秘密は env の欄ではなく、別の置き場（鍵の file）で渡すのが筋である。
 * ここに載せるのは、CLI の設定の在り処を足軽ごとに分ける名だけとする。
 * 名を足す時は、秘密を運ばぬ名かを判じて、この名簿へ足す（試験も足す）。
 *
 * - `CODEX_HOME`: codex の設定の在り処（dir の道）。秘密は運ばぬ。
 * - `HINDSIGHT_CONFIG`: hindsight の hook が読む設定の file の道。値は道であって秘密ではない。
 *   token（apiToken）はその file の中に在り、hook が読む——命の字面には載らぬ。hook が env
 *   から読む `HINDSIGHT_API_TOKEN` 等の秘密の名は、ここへ足さぬ。
 */
export const AGENT_ENV_ALLOWED: readonly string[] = ['CODEX_HOME', 'HINDSIGHT_CONFIG'];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * 名ごとの値の掟。名の判じと同じ所で、値も判ずる。外れれば理由と直し方を返す。
 *
 * **CODEX_HOME は `/` で始まる絶対の道に限る。** 値は単引用で命に載るゆえ、`~` も
 * `$HOME` も展開されぬ。`~/.codex-x` は codex の側では「今の dir の下の `~` という dir」
 * になり、selftest が `~` を展開して読めば、見張る先と codex が使う先が食い違う。
 * 相対の道も同じく、起こした dir 次第で先が変わる。
 *
 * **`..` は畳まずに止める。** 字面で畳むと、symlink を越える道で実の在り処とずれうる
 * （`/a/link/../b` の `..` は、shell では字面で、kernel では link の先で解かれる）。
 * 畳まずに受ける形を一つに絞れば、selftest が読む先と codex が開く先は必ず同じになる。
 *
 * **`.` の区画も畳まずに止める。** `.` は kernel でも shell でも同じく解かれ、在り処は
 * ずれぬ。だが畳まずに通すと、隔離の下の拒み（src/isolate.ts の isolatedCodexHomeProblem。
 * `/tmp`・`$HOME`・`~/.honden`・repo を前方一致で見る）が `/home/me/./.honden` のように
 * `/./` を挟むだけで外れる。畳んで判じる形（canon で均す）にはせぬ——env に載る値と、
 * 判じ・bind に使う値が二つの形になり、どちらが本当の道かを読む者が取り違えるため。
 * 受ける形を「`/` で始まり、`.` も `..` も区画に持たぬ道」一つに絞る。
 *
 * **HINDSIGHT_CONFIG も同じ道の掟を通す。** 値は単引用で載るゆえ `~` は展開されず、hook は
 * 相対の道を起こした dir から読む。読めねば hook は設定を空と見て、既定の送り先（Cloud）へ
 * 落ちる（hindsight-coding-agents@0.7.0 の resolveConfig）。見張る先と読む先を一つに絞るため、
 * 掟を absolutePathRule 一つに括って両方に与える。
 */
function absolutePathRule(example: string): (v: string) => string | null {
  const fix = `$HOME を展開した絶対の道（例: ${example}）で書かれよ`;
  return (v) => {
    if (!v.startsWith('/')) {
      return `絶対の道（/ で始まる）で書かれよ: ${JSON.stringify(v)}。値は単引用で載るゆえ ~ も $HOME も展開されず、相対の道は起こした dir で先が変わる。${fix}`;
    }
    const parts = v.split('/');
    if (parts.includes('..')) {
      return `.. を含む: ${JSON.stringify(v)}。畳むと symlink を越えて実の在り処とずれうるゆえ受けぬ。${fix}`;
    }
    if (parts.includes('.')) {
      return `. の区画を含む: ${JSON.stringify(v)}。/./ を挟むと隔離の拒み（/tmp・$HOME・~/.honden・repo）が前方一致で外れるゆえ、畳まぬ形だけを受ける。${fix}`;
    }
    return null;
  };
}

const ENV_VALUE_RULES: Record<string, (v: string) => string | null> = {
  CODEX_HOME: absolutePathRule('/home/me/.codex-ashigaru3'),
  HINDSIGHT_CONFIG: absolutePathRule('/home/me/.hindsight-ashigaru3/coding-agent.json'),
};

/** shell の単引用で包む。単引用そのものは `'\''` で抜ける。空白・`$`・`!` も崩れぬ。 */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * `cli.agents.<名>.env` を読む。無ければ空。名と値の組の写像であること。
 * 名は `[A-Z_][A-Z0-9_]*` で、AGENT_ENV_ALLOWED に載ること。値は文か数で、
 * 改行などの制御の字を含まぬこと（起こす命が一行で打たれるため）。
 */
export function agentEnv(doc: unknown, agent: string): { ok: true; env: [string, string][] } | { ok: false; message: string } {
  const found = dig(doc, `cli.agents.${agent}.env`);
  if (found.kind === 'none') return { ok: true, env: [] };
  if (found.kind === 'scalar') {
    if (found.value === '') return { ok: true, env: [] };
    return { ok: false, message: `cli.agents.${agent}.env は名と値の組（写像）で書かれよ。値が一つだけ在る。` };
  }
  const raw = (doc as Record<string, any>).cli.agents[agent].env;
  if (Array.isArray(raw)) {
    return { ok: false, message: `cli.agents.${agent}.env は名と値の組（写像）で書かれよ。一覧ではない。` };
  }
  const env: [string, string][] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) {
      return { ok: false, message: `cli.agents.${agent}.env の名 ${JSON.stringify(name)} は [A-Z_][A-Z0-9_]* の形でない。` };
    }
    if (!AGENT_ENV_ALLOWED.includes(name)) {
      return {
        ok: false,
        message:
          `cli.agents.${agent}.env の名 ${name} は許しておらぬ（許す名: ${AGENT_ENV_ALLOWED.join(', ')}）。\n` +
          '  env の値は起こす命の字面に載り、pane や履歴に残る。秘密は鍵の file で渡されよ。',
      };
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return { ok: false, message: `cli.agents.${agent}.env.${name} の値は文で書かれよ。` };
    }
    const v = String(value);
    if (/[\u0000-\u001f\u007f]/.test(v)) {
      return { ok: false, message: `cli.agents.${agent}.env.${name} の値に改行などの制御の字が在る。` };
    }
    const bad = ENV_VALUE_RULES[name]?.(v);
    if (bad) return { ok: false, message: `cli.agents.${agent}.env.${name} の値の誤り——${bad}` };
    env.push([name, v]);
  }
  return { ok: true, env };
}

/**
 * その足軽の実効の CODEX_HOME。env に在ればそれ（agentEnv の判じを通った絶対の道）、
 * 無ければ `<home>/.codex`。**selftest が信頼を読む先と、隔離の包みが rw で bind する先は、
 * ここだけから引く**——二か所で決めると、見張る先と codex が書く先が分かれうる。
 */
export function codexHomeOf(
  doc: unknown,
  agent: string,
  home: string,
): { ok: true; path: string; custom: boolean } | { ok: false; message: string } {
  const r = agentEnv(doc, agent);
  if (!r.ok) return { ok: false, message: r.message };
  const v = r.env.find(([n]) => n === 'CODEX_HOME')?.[1];
  return v === undefined ? { ok: true, path: `${home}/.codex`, custom: false } : { ok: true, path: v, custom: true };
}

/**
 * honden の CLI の名から、hindsight の hook が設定の harnesses の節を引く名へ（0.7.0 の hook の harness）。
 *
 * `Record<Cli, string>` ゆえ、LAUNCHABLE_CLIS に CLI を足して名を足し忘れれば tsc が落ちる。
 * 名の出所（hindsight-coding-agents@0.7.0 の dist）: claude-code・codex・cursor-cli は各 hook が
 * loadConfig へ渡す harness、opencode は dist/index.js の `createPluginEntry("opencode")`（opencode v1 が
 * package.json の main から引く plugin）。`opencode2` は別の CLI（v2 の `opencode2`）が根の index.js から
 * 引く plugin の名で、honden が起こす `opencode` には効かぬ。
 */
export const HINDSIGHT_HARNESS: Record<Cli, string> = {
  claude: 'claude-code',
  cursor: 'cursor-cli',
  codex: 'codex',
  opencode: 'opencode',
};

/** 0.7.0 の resolveConfig が Cloud へ向かわぬ serverMode（daemon は 127.0.0.1 の手元の server）。 */
const HINDSIGHT_LOCAL_MODES = ['self-hosted', 'daemon'];

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** serverMode の値が Cloud へ向かうなら訳（向かわぬなら null）。 */
function modeProblem(mode: unknown): string | null {
  if (typeof mode === 'string' && HINDSIGHT_LOCAL_MODES.includes(mode)) return null;
  return mode === undefined ? 'serverMode が無い' : mode === 'cloud' ? 'serverMode が cloud である' : 'serverMode が self-hosted・daemon のどれでもない';
}

/** apiUrl の値が自前の server を指さぬなら訳（指すなら null）。値そのものは訳に載せぬ。 */
function urlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return 'apiUrl が無い';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return 'apiUrl が URL として読めぬ';
  }
  return host === 'vectorize.io' || host.endsWith('.vectorize.io') ? 'apiUrl が Cloud（vectorize.io）を指す' : null;
}

/**
 * banks の写像の節を一つずつ検める。applyBankConfig は効く bank の節を、serverMode・apiUrl を
 * 除かずに上へ重ねる（BANK_OVERRIDE_EXCLUDED に無い）。どの bank が効くかは作業の dir で決まるゆえ、
 * 全ての節を見る。節が書いた鍵だけが重なる（resolvePartial）ゆえ、書いた鍵だけを判じる。
 */
function banksProblem(where: string, banks: unknown, fix: string): string | null {
  if (banks === undefined) return null;
  if (!isMap(banks)) return `${where} が写像（{…}）でなく、節を判じられぬ。Cloud へ向ける節を見落としうる。${fix}`;
  for (const [id, sec] of Object.entries(banks)) {
    if (!isMap(sec)) continue;
    const name = `${where}.${id}`;
    const why = ('serverMode' in sec ? modeProblem(sec['serverMode']) : null) ?? ('apiUrl' in sec ? urlProblem(sec['apiUrl']) : null);
    if (why) return `${name} の節の ${why}。この bank へ書く時、hook は Cloud へ送る。${fix}`;
  }
  return null;
}

/**
 * HINDSIGHT_CONFIG の file が、hindsight の hook を自前の server へ向けるかを検める。向けぬなら訳。
 *
 * hindsight-coding-agents@0.7.0 の hook は、設定の file を読めねば（在らぬ・壊れた JSON）空と見て、
 * 既定の送り先（Cloud）へ会話を送る。読めても、効く serverMode が self-hosted・daemon でなければ
 * cloud となり、self-hosted でも apiUrl が無ければ Cloud の URL になる（resolveConfig）。
 * 効く値は、上の段に harnesses.<harness> の節を重ねた物（applyLayer）ゆえ、足軽の CLI の
 * harness の節まで重ねて見る。CLI の harness の名が分からねば（type が無い・表に無い）、
 * file に harnesses の鍵が在る限りどの節が効くか判じられぬゆえ止める。
 * さらに banks.<id> と harnesses.<harness>.banks.<id> の節も、同じ判じにかける（banksProblem）。
 *
 * **見るのは serverMode と apiUrl の二つの名だけ。** apiToken（鍵）は読まず出さぬ。訳の文には
 * file の中の値を載せぬ（壊れた JSON の例外の文は値の一部を含みうるゆえ使わず、文を自分で組む）。
 * env の層（HINDSIGHT_SERVER_MODE 等）は file の下に敷かれるが、足軽の起こす命には載らぬゆえ数えず、
 * file だけで判じる（file に書かれておらねば止める側へ倒す）。
 */
export function hindsightConfigProblem(path: string, cli: string | undefined): string | null {
  const cloud = '読めねば hook は設定を空と見て既定の送り先（Cloud）へ送る';
  const fix = '先に file を作り、serverMode（self-hosted か daemon）と apiUrl（自前の server）を書かれよ';
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    const what = code === 'ENOENT' ? '在らぬ' : `読めぬ（${code ?? '訳の分からぬ誤り'}）`;
    return `${what}。${cloud}。${fix}`;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return `JSON として開けぬ。${cloud}。${fix}`;
  }
  if (!isMap(raw)) {
    return `JSON の写像（{…}）でない。${cloud}。${fix}`;
  }
  const top = raw;
  const harness = cli !== undefined && isCli(cli) ? HINDSIGHT_HARNESS[cli] : undefined;
  if (harness === undefined && 'harnesses' in top) {
    const what = cli === undefined ? 'type が無い' : `type（${cli}）が harness の名の表に無い`;
    const how = cli === undefined ? 'type を書く' : 'type を表に在る CLI にする';
    return `${what}ゆえ harness の名が分からぬ。HINDSIGHT_CONFIG の harnesses の節のどれが効くかを判じられず、Cloud へ向ける節を見落としうる。${how}か、file から harnesses の節を除かれよ`;
  }
  // 上の段に、足軽の CLI の harness の節を重ねる（mergeRaw と同じく、節の鍵が勝つ）
  const sections = top['harnesses'];
  const per = harness && isMap(sections) && isMap(sections[harness]) ? sections[harness] : undefined;
  const pick = (key: string) => (per && key in per ? per[key] : top[key]);
  const mode = pick('serverMode');
  const via = per ? `（harnesses.${harness} の節を重ねた値）` : '';
  const bad = modeProblem(mode);
  if (bad) return `${bad}${via}。hook は Cloud へ送る。${fix}`;
  if (mode === 'self-hosted') {
    const why = urlProblem(pick('apiUrl'));
    if (why === 'apiUrl が無い') return `serverMode が self-hosted だが apiUrl が無い${via}。hook は既定の Cloud の URL へ送る。${fix}`;
    if (why === 'apiUrl が URL として読めぬ') return `${why}${via}。Cloud へ落ちうる形は受けぬ。${fix}`;
    if (why) return `${why}${via}。${fix}`;
  }
  return banksProblem('banks', top['banks'], fix) ?? (per ? banksProblem(`harnesses.${harness}.banks`, per['banks'], fix) : null);
}

/** 起こす命の頭に置く代入の並び（`CODEX_HOME='…' `の形）。env が無ければ空。 */
export function envPrefix(env: [string, string][]): string {
  return env.map(([n, v]) => `${n}=${shellQuote(v)}`).join(' ');
}

/** `honden config env <名>` の中身。設定を読み、検めて、前置きを返す。 */
export function envOf(db: Database, agent: string): ConfigResult {
  if (agent.trim() === '') return { ok: false, message: '誰の env か渡されよ。例: honden config env ashigaru3' };
  const doc = load(db);
  if (!doc.ok) return { ok: false, message: doc.message };
  const r = agentEnv(doc.doc, agent);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: envPrefix(r.env) };
}

/**
 * 一つ引く。
 *
 * 値は**そのまま**返す。shell が `$(...)` で受けるゆえ、飾りを付けない。
 */
export function get(db: Database, key: string): ConfigResult {
  if (key.trim() === '') {
    return { ok: false, message: '鍵を渡されよ。例: honden config get cli.agents.karo.model' };
  }
  const doc = load(db);
  if (!doc.ok) return { ok: false, message: doc.message };

  const found = dig(doc.doc, key);
  if (found.kind === 'none') {
    return { ok: false, message: `${key} は無い（${found.at} で途切れた）。\n  honden config で何が在るか見られよ。` };
  }
  if (found.kind === 'branch') {
    return {
      ok: false,
      message:
        `${key} はまだ枝である。値ではない。\n` +
        `  下に在るもの: ${found.keys.slice(0, 12).join(' / ')}${found.keys.length > 12 ? ' …' : ''}\n` +
        '  枝を返すと、受け取った側がそれを解きにかかる。解く仕事を戻さぬため、値だけを返す。',
    };
  }
  return { ok: true, value: found.value };
}
