/**
 * bot cli の芯 — GitHub App 名義の書き込み窓口（旧 scripts/github_issue_create.sh の後継）。
 *
 * gh.exe（殿の個人 token・将軍専用）とは別の道である:
 * - 名義が App（shogun-bot）で、権限は Issues:write のみ。個人 token の repo 全権を晒さぬ。
 * - 司令層（shogun/karo/gunshi）専用。足軽は秘密に触れさせぬ。
 * - 旧 bash 版は openssl + python3 + gh の三道具に頼った。ここは Bun の
 *   crypto + fetch で賄う——別 binary に焼いても外の道具が要らぬ。
 *
 * この箱は純関数と注入可能な fetch だけ。プロセス・環境・入出力は botmain.ts が持つ。
 */
import { createSign } from 'node:crypto';

/** 司令層。旧 bash 版の SHOGUN_AGENT_ID guard と同じ顔ぶれ。 */
export const COMMANDERS = new Set(['shogun', 'karo', 'gunshi']);

export interface BotIdentityView {
  id?: string;
  insideFormation: boolean;
  /** 名乗りが系譜から出ておるか（src/anchor.ts）。env では偽れぬ出所。 */
  anchored?: boolean;
}

export type BotRank = 'commander' | 'retainer';

/**
 * bot の門。**布陣内・系譜で錨を取れた者のみ**通す。
 *
 * 当初は「布陣外は殿の手」として通しておったが、これは誤りであった
 * （敵対レビュー 2026-08-29・critical）。`TMUX_PANE=` と空にするだけで
 * 足軽が「布陣外」を騙れる——fail-open は騙りの的になる。honden 本体は
 * 元より「布陣外では権を振るえぬ」で fail-closed（identity.ts の mayActAs）
 * であり、bot だけが逆を向いておった。向きを揃える。
 *
 * 殿がお使いになる時は pane の中から。外からは gh.exe（殿の個人 token）が
 * 元より全権を持つゆえ、bot を外へ開ける益は無い。
 *
 * 返す位は二つ。司令層は無条件、それ以外は**許状**（src/charter.ts）を要する。
 */
export function guardBot(who: BotIdentityView): { ok: true; rank: BotRank } | { ok: false; message: string } {
  if (!who.anchored) {
    return {
      ok: false,
      message:
        'そなたが誰であるか、系譜から確かめられぬ。bot は錨の取れた名乗りしか通さぬ。\n' +
        '  布陣（tmux）の pane の中から行われよ。環境変数の名乗りは偽れるゆえ採らぬ。',
    };
  }
  if (!who.id) {
    return { ok: false, message: 'この pane には @agent_id が付いておらぬ。持ち場からは名乗れぬ。' };
  }
  if (COMMANDERS.has(who.id)) return { ok: true, rank: 'commander' };
  return { ok: true, rank: 'retainer' };
}

/**
 * App config（~/.shogun/github-app/config）を読む。
 * 実物は `CLIENT_ID: 値` 形だが、歴史的に `key: 値` と `KEY=値` が混在した
 * （旧版は d125921 で dotenv 対応を後付け）。大文字小文字と区切りの両方に寛容に読む。
 */
export function parseAppConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(t);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!.toLowerCase()] = v;
  }
  return out;
}

/**
 * 秘密鍵の錠を検める。旧 bash 版が持っておった護りで、移植で落としておった
 * （2026-08-29 に「移植で締めを写さぬ」型の掃きで発覚）。
 *
 * 写しを作る側（token.cache.json）は錠が効かねば**書かぬ**と決めたが、鍵は
 * 読む側ゆえ拒めば道具ごと死ぬ。旧に倣って**声を上げるに留める**。
 * ただし 777 は DrvFs の常であり、そこに鍵を置くこと自体が誤りゆえ、
 * その旨まで言う。
 */
export function pemPermWarning(mode: number, path: string): string | undefined {
  const perm = mode & 0o777;
  if (perm === 0o600) return undefined;
  const loose = (perm & 0o077) !== 0;
  return (
    `鍵の錠が緩い（${perm.toString(8)}・${path}）。${loose ? '己以外にも読める。' : ''}\n` +
    '  chmod 600 で締められよ。777 と出るなら DrvFs（/mnt/c 配下）に置いておる——\n' +
    '  DrvFs は錠を保たぬゆえ、鍵は WSL ネイティブ（~/.shogun）へ移されよ。'
  );
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

/**
 * GitHub App の JWT（RS256）。iat は時計ずれ許容で 60 秒戻し、
 * exp は iat + 600（上限 10 分）に収める。iss は Client ID。
 */
export function mintJwt(pem: string, clientId: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: clientId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(pem).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
}

/** installation token がまだ使えるか。期限の 5 分手前で捨てる（道中の時差を呑む）。 */
export function tokenFresh(t: InstallationToken, now: Date): boolean {
  const exp = Date.parse(t.expires_at);
  if (Number.isNaN(exp)) return false;
  return exp - now.getTime() > 5 * 60 * 1000;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';
const HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'honden-bot',
};

/** 失敗応答を人の読める形へ。token や Authorization は決して混ぜぬ。 */
async function fail(r: Response, doing: string): Promise<never> {
  let detail = '';
  try {
    const j = (await r.json()) as { message?: string };
    detail = j.message ?? '';
  } catch {
    /* 本文が JSON でない失敗はそのまま */
  }
  throw new Error(`${doing} に失敗した（HTTP ${r.status}${detail ? `: ${detail}` : ''}）`);
}

/** JWT → installation token。1 時間有効。 */
export async function mintInstallationToken(
  f: FetchLike,
  jwt: string,
  installationId: string,
): Promise<InstallationToken> {
  const r = await f(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...HEADERS_BASE, Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) await fail(r, 'installation token の鋳造');
  const j = (await r.json()) as InstallationToken;
  if (!j.token) throw new Error('応答に token が無い');
  return { token: j.token, expires_at: j.expires_at };
}

/** App の素性（slug 等）。JWT で引く。auth の陽性対照に使う。 */
export async function appInfo(f: FetchLike, jwt: string): Promise<{ slug: string; name: string }> {
  const r = await f(`${API}/app`, { headers: { ...HEADERS_BASE, Authorization: `Bearer ${jwt}` } });
  if (!r.ok) await fail(r, 'App 素性の取得');
  const j = (await r.json()) as { slug: string; name: string };
  return { slug: j.slug, name: j.name };
}

const auth = (token: string) => ({ ...HEADERS_BASE, Authorization: `Bearer ${token}` });

/** repo の形の検め。API の URL へ埋めるゆえ、通す形を狭く取る。 */
export function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

/**
 * 重複探し。search API の in:title で当て、題の完全一致か
 * 「鍵が 10 字超で題に含まれる」を重複と見る（旧版と同じ判定）。
 */
export function dupMatch(items: { title: string; url: string }[], key: string): string | undefined {
  const k = key.toLowerCase();
  for (const i of items) {
    const t = i.title.toLowerCase();
    if (k === t || (k.length > 10 && t.includes(k))) return i.url;
  }
  return undefined;
}

/**
 * 探索の鍵は丈を切る。GitHub の検索文字列は 256 字までで、
 * 超えれば 422 で落ちる——**長い題の起票が重複検めで死ぬ**（レビュー指摘）。
 */
export const SEARCH_KEY_MAX = 120;
export function trimKey(key: string): string {
  return key.length <= SEARCH_KEY_MAX ? key : key.slice(0, SEARCH_KEY_MAX);
}

export async function searchIssues(
  f: FetchLike,
  token: string,
  repo: string,
  key: string,
): Promise<{ title: string; url: string }[]> {
  // is:issue を落とすと PR まで拾う。題の似た PR があるだけで
  // 起票が黙って飛ぶ（レビューで実測・GitHub の検索は両方返す）。
  const q = encodeURIComponent(`repo:${repo} is:issue in:title ${trimKey(key)}`);
  const r = await f(`${API}/search/issues?q=${q}&per_page=10`, { headers: auth(token) });
  if (!r.ok) await fail(r, '重複の探索');
  const j = (await r.json()) as { items?: { title: string; html_url: string }[] };
  return (j.items ?? []).map((i) => ({ title: i.title, url: i.html_url }));
}

/**
 * ラベルの検め。**既存ラベルのみ許す**（殿命 2026-07-15）。
 * 無いものは作らず・付けず、名を返して報せる。
 */
export function filterLabels(requested: string[], existing: string[]): { ok: string[]; missing: string[] } {
  const have = new Set(existing.map((l) => l.toLowerCase()));
  const ok: string[] = [];
  const missing: string[] = [];
  for (const l of requested) {
    (have.has(l.toLowerCase()) ? ok : missing).push(l);
  }
  return { ok, missing };
}

/**
 * ラベル一覧。**頁を繰る**——per_page は 100 が上限で、それを超える repo では
 * 黙って切れる。切れた分は「無いラベル」と見なされ、正しい名が付かなくなる。
 */
export async function listLabels(f: FetchLike, token: string, repo: string, maxPages = 5): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await f(`${API}/repos/${repo}/labels?per_page=100&page=${page}`, { headers: auth(token) });
    if (!r.ok) await fail(r, 'ラベル一覧の取得');
    const j = (await r.json()) as { name: string }[];
    names.push(...j.map((l) => l.name));
    if (j.length < 100) break;
  }
  return names;
}

/** App が入っておる repo の名。書ける先はここに限られる。 */
export async function installationRepos(f: FetchLike, token: string): Promise<string[]> {
  const r = await f(`${API}/installation/repositories?per_page=100`, { headers: auth(token) });
  if (!r.ok) await fail(r, '入居先の一覧');
  const j = (await r.json()) as { repositories?: { full_name: string }[] };
  return (j.repositories ?? []).map((x) => x.full_name);
}

/**
 * 「入っておらぬ repo」を名指しで教える。
 *
 * App が入っていない repo に触ると、GitHub は **404（repo 系）か 422（検索）**
 * を返す——どちらも「無い」としか言わず、権限の話だと分からぬ。実測で二度
 * 迷わされた（2026-08-29）。ゆえに失敗したら入居先を引いて突き合わせ、
 * 因を名指しする。happy path では引かぬゆえ、ただ働きにはならぬ。
 */
export async function explainRepoAccess(f: FetchLike, token: string, repo: string): Promise<string | undefined> {
  let repos: string[];
  try {
    repos = await installationRepos(f, token);
  } catch {
    return undefined; // 入居先すら引けぬなら、元の失敗をそのまま見せる
  }
  if (repos.includes(repo)) return undefined;
  return (
    `App は ${repo} に入っておらぬ（ゆえに「無い」と言われる）。\n` +
    `  入っておるのは: ${repos.length > 0 ? repos.join(', ') : '（一つも無い）'}\n` +
    '  入居先を増やすには GitHub の App 設定で repo を足されよ。'
  );
}

export async function createIssue(
  f: FetchLike,
  token: string,
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ url: string; number: number }> {
  const r = await f(`${API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(labels.length > 0 ? { title, body, labels } : { title, body }),
  });
  if (!r.ok) await fail(r, 'issue の起票');
  const j = (await r.json()) as { html_url: string; number: number };
  return { url: j.html_url, number: j.number };
}

export async function commentIssue(
  f: FetchLike,
  token: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ url: string }> {
  const r = await f(`${API}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ body }),
  });
  if (!r.ok) await fail(r, 'comment の投稿');
  const j = (await r.json()) as { html_url: string };
  return { url: j.html_url };
}

/**
 * repo の書かれ方を OWNER/REPO へ均す。
 *
 * projects.yaml の repo: は URL 形（https://github.com/o/r）で書かれておる。
 * git remote は ssh 形（git@github.com:o/r.git）もある。均せぬ形は null。
 */
export function normalizeRepoUrl(s: string): string | null {
  const t = s.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m =
    /^https?:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)$/.exec(t) ??
    /^git@github\.com:([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)$/.exec(t);
  if (m) return m[1]!;
  return validRepo(t) ? t : null;
}

/**
 * 宛先 repo を決める（殿の案・2026-09-03）。**取り違えを拒むのが本務。**
 *
 *   設定（project の repo:）が正。手打ち --repo と食い違えば**拒む**——
 *     古い名や写し損じが黙って通るのが一番の事故ゆえ。
 *   remote は参考。食い違いは**警めに留める**——旧名のまま GitHub の
 *     リダイレクトで生きておる案件が実在する（repo_note の教え）。
 */
export function resolveRepo(opts: {
  flag?: string;
  project?: string;
  projectRepo?: string | null;
  remoteRepo?: string | null;
}): { ok: true; repo: string; source: string; warn?: string } | { ok: false; message: string } {
  const flag = opts.flag?.trim() || undefined;
  const cfg = opts.projectRepo ?? undefined;
  const remote = opts.remoteRepo ?? undefined;

  if (flag && cfg && flag !== cfg) {
    return {
      ok: false,
      message:
        `--repo ${flag} は、案件 ${opts.project} の設定（${cfg}）と食い違うておる。\n` +
        '  設定が正である。手打ちを直すか、設定を直してから来られよ。',
    };
  }
  const warn =
    flag && !cfg && remote && flag !== remote
      ? `--repo ${flag} は remote（${remote}）と違う。旧名の redirect なら良いが、確かめられよ`
      : undefined;
  if (flag) return { ok: true, repo: flag, source: 'flag', ...(warn ? { warn } : {}) };
  if (cfg) return { ok: true, repo: cfg, source: `project:${opts.project} の設定` };
  if (remote) return { ok: true, repo: remote, source: `project:${opts.project} の remote` };
  return {
    ok: false,
    message: opts.project
      ? `案件 ${opts.project} に repo が無い（設定にも remote にも）。--repo で示されよ。`
      : '--repo は OWNER/REPO の形で（--project からも引ける）',
  };
}

/**
 * 起票先を決める。手打ち > project の既定 > github。
 *
 * **知らぬ宛先は拒む。** --to は task だけを見て、他は黙って GitHub へ
 * 落ちていた——書き損じが既定に化ける fail-open の型（塞いだ・2026-09-03）。
 * `gh` は `github` の別名（殿の指の癖に合わせる）。
 */
export function resolveDest(opts: {
  flag?: string;
  projectDefault?: string;
}): { ok: true; dest: 'github' | 'task'; source: 'flag' | 'project' | 'default' } | { ok: false; message: string } {
  const norm = (v: string): 'github' | 'task' | null => {
    const t = v.trim().toLowerCase();
    if (t === 'github' || t === 'gh') return 'github';
    if (t === 'task') return 'task';
    return null;
  };
  if (opts.flag?.trim()) {
    const d = norm(opts.flag);
    if (!d) return { ok: false, message: `--to ${opts.flag} は知らぬ宛先である（受けるのは github / gh / task）。` };
    return { ok: true, dest: d, source: 'flag' };
  }
  if (opts.projectDefault?.trim()) {
    const d = norm(opts.projectDefault);
    if (!d) return { ok: false, message: `project の issue_to（${opts.projectDefault}）が知らぬ宛先である（github / gh / task）。` };
    return { ok: true, dest: d, source: 'project' };
  }
  return { ok: true, dest: 'github', source: 'default' };
}
