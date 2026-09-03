/**
 * honden-bot — GitHub App 名義の書き込み CLI（別 binary・同 repo）。
 *
 * 旧 scripts/github_issue_create.sh（bash 391 行）の後継。芯は src/bot.ts。
 * 秘密（app.pem / config）は殿の家 ~/.shogun/github-app/ に住む。DrvFs は
 * 600 が効かぬゆえ WSL ネイティブが正（旧版からの決め）。
 *
 * ## 誰が使えるか
 *
 * **布陣（tmux）の中で、系譜から錨の取れた者のみ**（src/anchor.ts）。
 * 司令層（shogun/karo/gunshi）は無条件。それ以外は**許状**（src/charter.ts）
 * ——将軍が cmd に縛って切る多回券——を持つ者だけが、その repo・その verb に限り通る。
 *
 * ## token の扱い（旧版 §6-2 の原則を継ぐ）
 *
 * - 標準出力・log へ出さぬ。失敗表示にも混ぜぬ（bot.ts の fail が守る）。
 * - keyring（gh の hosts.yml）に触れぬ。fetch へ直に渡すのみ。
 * - 写しは token.cache.json。**600 が本当に効いたかを確かめ、効かねば写さぬ**
 *   ——DrvFs 等の錠が効かぬ土地では、黙って世に晒すより写さぬ方がよい。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseFlags, EXIT_OK, EXIT_SYSTEM, EXIT_INVALID } from './cli';
import { resolve as resolveIdentity } from './identity';
import { anchorFrom, realProbe } from './anchor';
import { openStore, tx } from './store';
import { findCharter, useCharter } from './charter';
import {
  guardBot, parseAppConfig, mintJwt, tokenFresh, mintInstallationToken, appInfo,
  validRepo, dupMatch, searchIssues, filterLabels, listLabels, createIssue, commentIssue,
  normalizeRepoUrl, resolveRepo,
  installationRepos, explainRepoAccess, pemPermWarning,
  type InstallationToken, type BotRank,
} from './bot';
import { gateConfig, gateEnv } from './reviewgate';
import { get as configGet } from './config';

const APP_DIR = process.env['SHOGUN_GH_APP_DIR'] ?? join(homedir(), '.shogun', 'github-app');
const AUDIT_DIR = process.env['SHOGUN_GITHUB_APP_AUDIT_DIR'] ?? join(APP_DIR, 'audit');
const CACHE = join(APP_DIR, 'token.cache.json');

const USAGE = `honden-bot — GitHub App（shogun-bot 名義・Issues:write のみ）の書き口

  honden-bot whoami
      App の素性と token 鋳造まで通しで検める（auth の陽性対照）。司令層のみ
  honden-bot repos
      App が入っておる repo を並べる（書ける先の一覧）。司令層のみ
  honden-bot issue create --repo OWNER/REPO --title 題 --body-file 道 [旗]
      --project <id> で所在の repo:（無ければ remote）から宛先を引ける。食い違いは拒む
      --to task で GitHub でなく task へ起こす（司令層のみ・宛先は review.gate(s) の設定）
      --body-file -      本文を標準入力から
      --labels a,b       既存ラベルのみ付く。無い名は付けずに報せる
      --search-key 鍵    重複探しの鍵（省くと題）
      --no-dup-check     重複探しを飛ばす
      --dry-run          token 鋳造まで。起票せぬ
  honden-bot issue comment --repo OWNER/REPO --number N --body-file 道 [--dry-run]

  布陣（tmux）の pane の中からのみ使える。名乗りは系譜で錨を取る——
  環境変数では偽れぬ。司令層（shogun/karo/gunshi）は無条件、それ以外は
  将軍の許状（honden guard charter）が要る。
  秘密の家: ~/.shogun/github-app/（SHOGUN_GH_APP_DIR で差し替え可）`;

function audit(entry: Record<string, string>): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(AUDIT_DIR, `${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 監査が書けぬことを理由に本務を止めぬ */
  }
}

function readBody(bodyFile: string): string {
  if (bodyFile === '-') return readFileSync(0, 'utf-8');
  return readFileSync(bodyFile, 'utf-8');
}

/**
 * token の写しを置く。**錠が効いたことを確かめてから**据える。
 *
 * 直に書いて後から chmod すると、(一) 既存ファイルへの上書きでは mode が
 * 効かず、締める前の隙に新しい token が緩い錠で晒される。(二) DrvFs では
 * chmod が黙って空振りし、777 のまま世に出る（実測）。
 * ゆえに: 別名へ O_EXCL 600 で書く → 実際の mode を読み返す → 効いておれば
 * 据え替える。効かねば**写さぬ**（毎回鋳直す方が、晒すよりまし）。
 */
function cacheToken(t: InstallationToken): { cached: boolean; why?: string } {
  const tmp = `${CACHE}.tmp.${process.pid}`;
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600, flag: 'wx' });
    const mode = statSync(tmp).mode & 0o777;
    if (mode !== 0o600) {
      unlinkSync(tmp);
      return { cached: false, why: `錠が効かぬ土地ゆえ写さぬ（mode ${mode.toString(8)}・${APP_DIR}）` };
    }
    renameSync(tmp, CACHE);
    return { cached: true };
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 後始末の失敗は本務を止めぬ */
    }
    return { cached: false, why: e instanceof Error ? e.message : String(e) };
  }
}

function dropCache(): void {
  try {
    if (existsSync(CACHE)) unlinkSync(CACHE);
  } catch {
    /* 消せずとも次の鋳造で上書きされる */
  }
}

interface AppCfg {
  clientId: string;
  installationId: string;
  pem: string;
}

/** 秘密を読む。**要る時にだけ**呼ぶ——空振りの副命令で鍵を抱えぬため。 */
function loadConfig(): AppCfg {
  const configPath = join(APP_DIR, 'config');
  const pemPath = join(APP_DIR, 'app.pem');
  if (!existsSync(pemPath) || !existsSync(configPath)) {
    throw new Error(`秘密の家が整うておらぬ: ${APP_DIR} に config と app.pem が要る`);
  }
  // 鍵の錠を検める（旧 bash 版からの護り）。拒みはせぬが黙りもせぬ。
  try {
    const w = pemPermWarning(statSync(pemPath).mode, pemPath);
    if (w) console.error(`  ※ ${w}`);
  } catch {
    /* 錠が読めぬ土地なら黙って進む */
  }
  const c = parseAppConfig(readFileSync(configPath, 'utf-8'));
  const clientId = c['client_id'] ?? c['app_id'];
  const installationId = c['installation_id'];
  if (!clientId || !installationId) throw new Error(`config に client_id / installation_id が無い（${configPath}）`);
  return { clientId, installationId, pem: readFileSync(pemPath, 'utf-8') };
}

async function mintFresh(cfg: AppCfg): Promise<string> {
  const jwt = mintJwt(cfg.pem, cfg.clientId, Math.floor(Date.now() / 1000));
  const t = await mintInstallationToken(fetch, jwt, cfg.installationId);
  const r = cacheToken(t);
  if (!r.cached && r.why) console.error(`  ※ token を写さなんだ: ${r.why}`);
  return t.token;
}

/** 生きた写しがあれば使い、無ければ鋳る。 */
async function getToken(cfg: AppCfg): Promise<string> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf-8')) as InstallationToken;
      if (tokenFresh(c, new Date())) return c.token;
    } catch {
      /* 壊れた写しは鋳直す */
    }
  }
  return mintFresh(cfg);
}

/**
 * token を使う仕事を回す。**401 なら写しを捨てて一度だけ鋳直す**
 * ——取り消された token が写しに残ると、期限が来るまで CLI が死んだままになる。
 */
async function withToken<T>(cfg: AppCfg, work: (token: string) => Promise<T>): Promise<T> {
  try {
    return await work(await getToken(cfg));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('HTTP 401')) throw e;
    dropCache();
    return work(await mintFresh(cfg));
  }
}

/**
 * repo に触る仕事を回す。**404/422 は権限の話**のことが多いゆえ、
 * その時だけ入居先を引いて因を名指しする（src/bot.ts の explainRepoAccess）。
 */
async function onRepo<T>(cfg: AppCfg, repo: string, work: (token: string) => Promise<T>): Promise<T> {
  return withToken(cfg, async (token) => {
    try {
      return await work(token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('HTTP 404') || msg.includes('HTTP 422')) {
        const why = await explainRepoAccess(fetch, token, repo);
        if (why) throw new Error(`${msg}\n  ${why}`);
      }
      throw e;
    }
  });
}

/**
 * 許状の検め。司令層はそのまま通る。それ以外は生きた許状が要る。
 * 使う前に一回引く——**失敗した弾を無料にすると、失敗し続ける限り無限に撃てる**。
 */
function spendCharterIfNeeded(
  rank: BotRank,
  agent: string,
  repo: string,
  verb: 'create' | 'comment',
  dbPath: string | undefined,
  dryRun: boolean,
  detail: string,
): { ok: true } | { ok: false; message: string } {
  if (rank === 'commander') return { ok: true };
  const db = openStore({ path: dbPath });
  const c = findCharter(db, agent, repo, verb, new Date());
  if (!c) {
    return {
      ok: false,
      message:
        `${repo} への issue ${verb} を許す許状が無い（そなたは ${agent}）。\n` +
        '  将軍に願われよ: honden guard charter --agent <己> --cmd-id <cmd> --repo ' +
        `${repo} --verb ${verb} --reason "<訳>"\n` +
        '  今ある許状は honden guard charters で見える。',
    };
  }
  if (dryRun) return { ok: true }; // 素振りは減らさぬ（外へ何も書かぬゆえ）
  tx(db, () => useCharter(db, c, detail));
  // 失敗しても減る。黙って減らすと「なぜ尽きた」が後から辿れぬ。
  console.error(`  許状 #${c.id} を一つ使うた（残 ${c.uses_left - 1}・失敗も数える）`);
  return { ok: true };
}

/**
 * --repo / --project から宛先を決める。決まらねば便りを出して null。
 *
 * project の repo は正本の raw（projects.yaml の写し）から引く。
 * 設定に無ければ path の git remote origin を読む（読むだけ・書かぬ）。
 */
function resolveRepoFlag(flags: Record<string, string>, dbPath: string | undefined): string | null {
  const project = flags['project']?.trim() || undefined;
  let projectRepo: string | null = null;
  let remoteRepo: string | null = null;
  if (project) {
    const db = openStore({ path: dbPath });
    const row = db.query('SELECT path, raw FROM project WHERE id = ?').get(project) as
      | { path: string | null; raw: string }
      | null;
    if (!row) {
      console.error(`  案件 ${project} は所在に無い（honden projects で確かめられよ）`);
      return null;
    }
    try {
      const raw = JSON.parse(row.raw) as Record<string, unknown>;
      if (typeof raw['repo'] === 'string' && raw['repo'].trim() !== '') {
        projectRepo = normalizeRepoUrl(raw['repo']);
        if (!projectRepo) {
          console.error(`  案件 ${project} の repo（${raw['repo']}）が読めぬ形である`);
          return null;
        }
      }
    } catch { /* raw が読めぬなら設定は無いのと同じ */ }
    if (!projectRepo && row.path) {
      const p = Bun.spawnSync(['git', '-C', row.path, 'remote', 'get-url', 'origin']);
      if (p.success) remoteRepo = normalizeRepoUrl(new TextDecoder().decode(p.stdout));
    }
  }
  const r = resolveRepo({ flag: flags['repo'], project, projectRepo, remoteRepo });
  if (!r.ok) {
    console.error(`  ${r.message}`);
    return null;
  }
  if (r.warn) console.error(`  ※ ${r.warn}`);
  if (r.source !== 'flag') console.error(`  宛先: ${r.repo}（${r.source}）`);
  return r.repo;
}

async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  if (rest.length === 0 || flags['help'] === 'true' || rest[0] === 'help') {
    console.log(USAGE);
    return EXIT_OK;
  }

  // 名乗りは系譜から。TMUX_PANE は参考にしかせぬ（src/anchor.ts）。
  const probe = realProbe();
  const who = resolveIdentity({
    tmuxPane: process.env.TMUX_PANE,
    agentIdEnv: process.env.HONDEN_AGENT_ID,
    lookup: (pane) => {
      const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
      return p.success ? new TextDecoder().decode(p.stdout).trim() : null;
    },
    anchor: () => anchorFrom(probe),
  });
  if (who.conflict) console.error(`  ※ ${who.conflict}`);

  const g = guardBot({ id: who.id, insideFormation: who.insideFormation, anchored: who.anchored });
  if (!g.ok) {
    console.error(`  ${g.message}`);
    audit({ action: rest.join(' '), actor: who.id ?? 'unknown', status: 'GUARD_DENIED' });
    return EXIT_INVALID;
  }
  const actor = who.id!;
  const rank = g.rank;
  const dbPath = flags['db'];
  const dryRun = flags['dry-run'] === 'true';

  if (rest[0] === 'whoami') {
    if (rank !== 'commander') {
      console.error('  whoami は司令層のみ。許状は起票と comment にしか効かぬ。');
      return EXIT_INVALID;
    }
    const cfg = loadConfig();
    const jwt = mintJwt(cfg.pem, cfg.clientId, Math.floor(Date.now() / 1000));
    const app = await appInfo(fetch, jwt);
    const token = await getToken(cfg);
    console.log(`  App: ${app.name}（@${app.slug}）`);
    console.log(`  名乗り: ${actor}（系譜で錨あり）`);
    console.log(`  installation token: 鋳造できた（長さ ${token.length}・中身は出さぬ）`);
    return EXIT_OK;
  }

  if (rest[0] === 'repos') {
    if (rank !== 'commander') {
      console.error('  repos は司令層のみ。');
      return EXIT_INVALID;
    }
    const cfg = loadConfig();
    return withToken(cfg, async (token) => {
      const repos = await installationRepos(fetch, token);
      console.log(`  App が入っておる repo（${repos.length} 件）——書ける先はここに限られる:`);
      for (const r of repos) console.log(`   - ${r}`);
      return EXIT_OK;
    });
  }

  if (rest[0] === 'issue' && rest[1] === 'create' && flags['to'] === 'task') {
    // 起票先に task を選ぶ（殿の求め・2026-09-03）。宛先の器は review gate の
    // 設定を使い回す——起票と門で宛先が割れると、閉じる基準と書き込む先が
    // 別の backend になる。
    if (rank !== 'commander') {
      console.error('  --to task は司令層のみ。GitHub の許状は App の repo 権限の物で、task の書き込みには写せぬ。将軍に願われよ。');
      audit({ action: 'task_create', actor, status: 'RANK_DENIED' });
      return EXIT_INVALID;
    }
    const title = flags['title'] ?? '';
    const bodyFile = flags['body-file'] ?? '';
    if (!title) { console.error('  --title が要る'); return EXIT_INVALID; }
    if (!bodyFile) { console.error('  --body-file が要る（- で標準入力）'); return EXIT_INVALID; }
    const db = openStore({ path: dbPath });
    const cfg = gateConfig((k) => {
      const rr = configGet(db, k);
      return rr.ok ? rr.value : undefined;
    }, flags['project']?.trim() || undefined);
    if (!cfg) {
      console.error('  task の宛先が設定に無い。settings.yaml の review.gate.project（か gates.<案件>.project）を書かれよ。');
      return EXIT_INVALID;
    }
    const ge = gateEnv(cfg);
    if (!ge.ok) { console.error(`  ${ge.message}`); return EXIT_INVALID; }
    const argv = [...cfg.bin, 'tasks', 'create', '--project', cfg.project, '--title', title, '--description-file', bodyFile];
    if (flags['priority']) argv.push('--priority', flags['priority']!);
    if (dryRun) {
      console.log(`  [dry-run] ${argv.join(' ')}`);
      if (ge.env) console.log(`  env: ${Object.keys(ge.env).join(' ')}（値は出さぬ）`);
      audit({ action: 'task_create_dry_run', actor, title, status: 'DRY_RUN_OK' });
      return EXIT_OK;
    }
    const p = Bun.spawnSync(argv, {
      stdout: 'inherit',
      stderr: 'inherit',
      ...(ge.env ? { env: { ...process.env, ...ge.env } } : {}),
    });
    audit({ action: 'task_create', actor, title, status: p.exitCode === 0 ? 'SUCCESS' : `EXIT_${p.exitCode}` });
    return p.exitCode ?? EXIT_SYSTEM;
  }

  if (rest[0] === 'issue' && rest[1] === 'create') {
    const repo = resolveRepoFlag(flags, dbPath) ?? '';
    const title = flags['title'] ?? '';
    const bodyFile = flags['body-file'] ?? '';
    if (!validRepo(repo)) { console.error('  --repo は OWNER/REPO の形で'); return EXIT_INVALID; }
    if (!title) { console.error('  --title が要る'); return EXIT_INVALID; }
    if (!bodyFile) { console.error('  --body-file が要る（- で標準入力）'); return EXIT_INVALID; }
    const body = readBody(bodyFile);

    const c = spendCharterIfNeeded(rank, actor, repo, 'create', dbPath, dryRun, `${repo} へ起票「${title}」`);
    if (!c.ok) {
      console.error(`  ${c.message}`);
      audit({ action: 'issue_create', actor, repo, title, status: 'NO_CHARTER' });
      return EXIT_INVALID;
    }

    const cfg = loadConfig();
    if (dryRun) {
      // 素振りは下見である。token だけ鋳えても「その repo へ書けるか」は分からぬ
      // ——入居先まで確かめて初めて下見になる。
      return withToken(cfg, async (token) => {
        const why = await explainRepoAccess(fetch, token, repo);
        if (why) {
          console.error(`  ${why}`);
          audit({ action: 'issue_create_dry_run', actor, repo, title, status: 'NO_INSTALL' });
          return EXIT_INVALID;
        }
        console.log(`  [dry-run] ${repo} へ書ける。「${title}」を起票する所まで来ておる`);
        audit({ action: 'issue_create_dry_run', actor, repo, title, status: 'DRY_RUN_OK' });
        return EXIT_OK;
      });
    }

    return onRepo(cfg, repo, async (token) => {
      if (flags['no-dup-check'] !== 'true') {
        const key = flags['search-key'] ?? title;
        const dup = dupMatch(await searchIssues(fetch, token, repo, key), key);
        if (dup) {
          console.error(`  既に立っておる: ${dup}`);
          console.log(dup);
          audit({ action: 'issue_create', actor, repo, title, url: dup, status: 'DUPLICATE_SKIP' });
          return EXIT_OK;
        }
      }

      // ラベルは既存のみ（殿命 2026-07-15）。無い名は作らず、報せて進む。
      let labels: string[] = [];
      const asked = (flags['labels'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (asked.length > 0) {
        const { ok, missing } = filterLabels(asked, await listLabels(fetch, token, repo));
        if (missing.length > 0) console.error(`  無いラベルは付けぬ: ${missing.join(', ')}`);
        labels = ok;
      }

      const made = await createIssue(fetch, token, repo, title, body, labels);
      console.log(made.url);
      audit({ action: 'issue_create', actor, repo, title, url: made.url, status: 'SUCCESS' });
      return EXIT_OK;
    });
  }

  if (rest[0] === 'issue' && rest[1] === 'comment') {
    const repo = resolveRepoFlag(flags, dbPath) ?? '';
    const num = Number(flags['number'] ?? '');
    const bodyFile = flags['body-file'] ?? '';
    if (!validRepo(repo)) { console.error('  --repo は OWNER/REPO の形で'); return EXIT_INVALID; }
    if (!Number.isInteger(num) || num <= 0) { console.error('  --number は正の整数で'); return EXIT_INVALID; }
    if (!bodyFile) { console.error('  --body-file が要る（- で標準入力）'); return EXIT_INVALID; }
    const body = readBody(bodyFile);

    const c = spendCharterIfNeeded(rank, actor, repo, 'comment', dbPath, dryRun, `${repo}#${num} へ comment`);
    if (!c.ok) {
      console.error(`  ${c.message}`);
      audit({ action: 'issue_comment', actor, repo, number: String(num), status: 'NO_CHARTER' });
      return EXIT_INVALID;
    }

    const cfg = loadConfig();
    if (dryRun) {
      return withToken(cfg, async (token) => {
        const why = await explainRepoAccess(fetch, token, repo);
        if (why) {
          console.error(`  ${why}`);
          audit({ action: 'issue_comment_dry_run', actor, repo, number: String(num), status: 'NO_INSTALL' });
          return EXIT_INVALID;
        }
        console.log(`  [dry-run] ${repo} へ書ける。#${num} へ comment する所まで来ておる`);
        audit({ action: 'issue_comment_dry_run', actor, repo, number: String(num), status: 'DRY_RUN_OK' });
        return EXIT_OK;
      });
    }

    return onRepo(cfg, repo, async (token) => {
      const made = await commentIssue(fetch, token, repo, num, body);
      console.log(made.url);
      audit({ action: 'issue_comment', actor, repo, number: String(num), url: made.url, status: 'SUCCESS' });
      return EXIT_OK;
    });
  }

  console.error(USAGE);
  return EXIT_INVALID;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`  ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EXIT_SYSTEM);
    },
  );
}
