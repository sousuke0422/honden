/**
 * honden の入口。
 *
 * 影の段では、shogun 側へは一切書かない。取り込みと検索だけを提供する。
 *
 * 書き戻し (正本 → queue/**.yaml) を入れると書き手が 2 人になる。honden が
 * 吐いたそばからエージェントが同じファイルへ書き、後から書いたほうが相手を潰す。
 * 切り替えの日を決めるまでは、影に徹するのが安全になる。
 */

import { openStore, search, tx, journal, SearchError, DEFAULT_DB_PATH, type Hit } from './store';
import type { Database } from 'bun:sqlite';
import { resolve as resolveIdentity, mayActAs, type Identity } from './identity';
import { anchorFrom, realProbe } from './anchor';
import { paneInOwn } from './pane';
import { parseIsolation, wrapLaunch, requiredTools, dnsWarning, type IsolationCfg } from './isolate';
import { realRunner as parseRunner } from './parse';
import { pending as notifyPending, streakNotice, dispatch as notifyDispatch, type Sink } from './notify';
import { desktopSink } from './notify/desktop';
import { config as ntfyConfig, ntfySink, topicWarning } from './notify/ntfy';
import { parseLine, listenArgs, streamUrl, backoffMs, receive } from './notify/listen';
import { VERSION, isPrerelease } from './version';
import {
  BINARIES, SUMS, platformOf, planFor, decide, tagFrom, verify, parseSums, releaseApiUrl, assetUrl,
} from './update';
import { BUNDLE, SKIP_FLAG, signCheck, verifyArgs, readVerify, parseCosignVersion } from './sign';
import { check as reviewCheck, render as renderReview, parseTally } from './review';
import {
  add as sayAdd,
  list as sayList,
  get as sayGet,
  setStatus as saySetStatus,
  streak as sayStreak,
  touchStreak as sayTouchStreak,
  importItems as sayImport,
  render as sayRender,
  STATUSES as SAY_STATUSES,
  type Status as SayStatus,
} from './saytask';

/**
 * 己の在処から repo の根を割り出す。構文の解き手（bin/honden-parse）を
 * 探すのに要る。
 *
 * 焼いた binary は `<根>/bin/honden` に据わるゆえ、二つ上が根である。
 * `bun run src/main.ts` で走らせた時は bun の在処が返るゆえ、その時のために
 * source からの道も見る。どちらでも見つからねば `realRunner` が拒みへ倒す
 * ——**根を誤って素通しにはせぬ。**
 */
const REPO_ROOT = (() => {
  const env = process.env.HONDEN_ROOT?.trim();
  if (env) return env;
  const fromBin = dirname(dirname(process.execPath));
  if (existsSync(join(fromBin, 'bin', 'honden-parse'))) return fromBin;
  const fromSrc = dirname(import.meta.dir);
  if (existsSync(join(fromSrc, 'bin', 'honden-parse'))) return fromSrc;
  return fromBin; // 見つからねば realRunner が拒む
})();
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { importTree, collectYaml, type ImportResult } from './import';
import { ingestAll } from './ingest';
import { list, summarize, nudgeText, ack, ackAll, urgentRideAlong } from './inbox';
import { createCmd, assignTask, CMD_AUTHOR, ASSIGNER } from './dispatch';
import { submitReport, submitQc, cmdDone, coverageOf, criteriaOf } from './report';
import { plan, send, record, startClocks, withNudgeLock } from './nudge';
import { captureBusy } from './busy';
import { assemble as assembleBrief } from './brief';
import { lookup as helpFor, render as renderHelp, HELP } from './help';
import { emphasize } from './term';

/** 手引きの鍵。長い方を先に見る（`cmd new` が `cmd` に勝つ）。 */
const HELP_KEY = (rest: string[]): string => {
  const two = rest.slice(0, 2).join(' ');
  return HELP[two] ? two : (rest[0] ?? '');
};
import { collect as collectStatus, render as renderStatus, coreCheck, corePaths } from './status';
import { collect as denialCollect, tally as denialTally, render as denialRender } from './denials';
import { exportAll } from './export';
import { serve as serveHttp, LOOPBACK, DASHBOARD_PORT } from './serve';
import { issueCharter, revokeCharter, listCharters, CHARTER_DEFAULT_TTL_MIN, CHARTER_MAX_TTL_MIN } from './charter';
import { backup as backupDb, KEEP_DEFAULT } from './backup';
import { judge as guardJudge, judgeStructured as guardJudgeStructured, issue as guardIssue, verify as guardVerify, normalize as guardNormalize, splitOtp as guardSplitOtp, facts as guardFacts, selftest as guardSelftest, OTP_DEFAULT_TTL_MS } from './guard';
import { deliver as inboxDeliver, signal as inboxSignal } from './inbox';
import { amendCmd, workersOn } from './amend';
import { patchFiles } from './patchfile';
import { raise as raiseDecision, decide as decideOne, open as openDecisions } from './decision';
import { get as configGet, load as configLoad, dig as configDig, SETTINGS_PATH_KEY } from './config';
import { settingsPath as settingsPathOf } from './config';
import { apply as applyRoster, current as currentRoster, suggestModels, LAUNCHABLE_CLIS, isCli, type Change } from './rosteredit';
import { getMode, setMode, describe as describeMode } from './mode';
import { peek, history, reportCollision } from './peer';
import { readProjectsFromFile, syncProjects, projects as projectList, workRootOf, ProjectError } from './projects';
import { readNorms, select, PROMPT_TIERS } from './norms';
import { normsRoot, setSetting } from './settings';
import { resolve as resolvePath } from 'node:path';
import { live as liveClaims, conflicts as claimConflicts, explainConflict, release as releaseClaim, normalize as normClaim, type Kind } from './claim';
import { summarize as summarizeInbox } from './inbox';
import { roster as rosterOf, roleOf as roleOfId, isWorker } from './roster';
import { leaseState, expired, release, renew, DEFAULT_LEASE_MINUTES } from './lease';
import { pickInput, type InputSource } from './cli';
import { inboxWrite, inboxUnread, parseFlags, fromPositional, EXIT_OK, EXIT_INVALID, EXIT_SYSTEM } from './cli';
import { readRosterFromSettings, syncRoster, roster, RosterError } from './roster';
import { readLimitsFromSettings, syncLimits, recommend } from './routing';
import type { RunResult } from './cli';

/** 取り込む対象。config は秘密を含みうるので既定では入れない。 */
const DEFAULT_SUBDIRS = ['queue', 'saytask'];

export function runImport(
  dbPath: string | undefined,
  root: string,
  subdirs: string[],
  selfId?: string,
): RunResult {
  const db = openStore({ path: dbPath });
  const t0 = Bun.nanoseconds();
  let r: ImportResult;
  try {
    r = importTree(db, root, subdirs, { by: selfId });
  } catch (e) {
    return { code: EXIT_SYSTEM, err: `取り込みが止まった: ${String(e).slice(0, 300)}` };
  }
  // 本文を入れたあと、形が読めたものを型のある表へ写す。
  const files = subdirs
    .flatMap((s) => collectYaml(join(root, s)))
    .map((p) => ({ path: relative(root, p).split('\\').join('/'), body: readFileSync(p, 'utf8') }));
  const ing = ingestAll(db, root, files);
  const ms = ((Bun.nanoseconds() - t0) / 1e6).toFixed(0);

  const lines = [
    `  走査 ${r.scanned}  取込 ${r.imported}  据置 ${r.skipped}  ${ms}ms`,
    `  構造化: inbox ${ing.inbox} / task ${ing.task} / report ${ing.report}（読めず飛ばした ${ing.skipped}）`,
  ];
  if (r.outstanding > 0) {
    // 当たった件数ではなく残っている件数を出す。sha256 が変わっていないファイルは
    // 素通りするので、当たった数だけを見ると残りが消えたように見える。
    lines.push(`  難あり ${r.outstanding} 件が残っておる（この回で当たったのは ${r.issues.length} 件）:`);
    const rows = db
      .query('SELECT path, kind, detail FROM import_issue ORDER BY path')
      .all() as { path: string; kind: string; detail: string }[];
    for (const i of rows) lines.push(`    [${i.kind}] ${i.path}  ${i.detail}`);
  }
  // 難ありが残っているうちは非ゼロで終わる。黙って 0 を返すと、
  // 呼んだ側は「全部入った」と読む。
  return { code: r.outstanding > 0 ? EXIT_INVALID : EXIT_OK, out: lines.join('\n') };
}

/** `honden roster sync --settings <settings.yaml>` — 顔ぶれを入れ替える。 */
export function runRosterSync(dbPath: string | undefined, settingsPath: string | undefined): RunResult {
  if (!settingsPath) {
    return {
      code: EXIT_INVALID,
      err:
        '名簿の出所が要る。\n' +
        '  honden roster sync --settings <環境の settings.yaml>\n' +
        '  cli.agents の鍵がそのまま顔ぶれになる。',
    };
  }
  let entries;
  try {
    entries = readRosterFromSettings(settingsPath);
  } catch (e) {
    if (e instanceof RosterError) return { code: EXIT_INVALID, err: `  ${e.message}` };
    return { code: EXIT_SYSTEM, err: String(e).slice(0, 300) };
  }
  const limits = readLimitsFromSettings(settingsPath);
  const db = openStore({ path: dbPath });
  tx(db, () => {
    syncRoster(db, entries);
    syncLimits(db, limits);
    // 設定の在り処をここで覚える。
    //
    // honden config が引数でファイルを取らぬのは、取れば汎用の YAML 読み口に
    // なり、honden を迂回する道が開くゆえ。入口はここ一つにする。
    setSetting(db, SETTINGS_PATH_KEY, resolvePath(settingsPath), 'roster');
  });
  const w = entries.filter((e) => e.role === 'worker');
  return {
    code: EXIT_OK,
    out:
      `  ${entries.length} 人（上役 ${entries.length - w.length} / 足軽 ${w.length}）\n` +
      entries.map((e) => `    ${e.id.padEnd(10)} ${e.role.padEnd(9)} ${e.cli ?? ''} ${e.model ?? ''}`).join('\n') +
      `\n  能力制限 ${limits.filter((l) => l.maxBloom < 6).length} 件（表に無いモデルは制限なし）` +
      `\n  設定の在り処を覚えた: ${resolvePath(settingsPath)}`,
  };
}

/** 対話の手。試験では注ぎ替える。 */
export interface RosterIo {
  isTTY: boolean;
  /** 問いを出して一行受ける。閉じられたら null。 */
  ask: (q: string) => string | null;
  say: (line: string) => void;
}

export const realRosterIo: RosterIo = {
  isTTY: Boolean(process.stdin.isTTY),
  ask: (q) => prompt(q),
  say: (l) => console.log(l),
};

/**
 * `honden roster set` — 顔ぶれの CLI と模型を差し替え、settings.yaml へ書き戻し、名簿へ写す。
 *
 * 端末なら一人ずつ訊く。旗（`--karo cursor:auto` `--workers 3`）があれば訊かぬ。
 * **CLI と模型は対で扱う。** CLI だけ差して模型が残ると黙って動かぬ
 * （Cursor に claude-fable-5 を指したまま沈黙した・2026-08-04）。
 *
 * 書くのは settings.yaml の**値だけ**で、注釈は残す（`src/rosteredit.ts`）。
 * 立っておる陣には効かぬ——次の出陣から。
 */
export function runRosterSet(
  dbPath: string | undefined,
  flags: Record<string, string>,
  io: RosterIo = realRosterIo,
): RunResult {
  const db = openStore({ path: dbPath });
  const path = flags['settings'] ?? settingsPathOf(db);
  if (!path) {
    return { code: EXIT_INVALID, err: '設定の在り処を知らぬ。先に honden roster sync --settings <settings.yaml> を一度。' };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { code: EXIT_INVALID, err: `${path} を読めぬ: ${String(e).slice(0, 120)}` };
  }
  const cur = currentRoster(text);
  if (cur.length === 0) return { code: EXIT_INVALID, err: `${path} に cli.agents が見当たらぬ。` };
  let doc: unknown = null;
  try { doc = Bun.YAML.parse(text); } catch { /* 勧めが出ぬだけ。書く前の読み返しは apply が行う */ }

  const dryRun = flags['dry-run'] === 'true';
  const yes = flags['yes'] === 'true';
  const changes: Change[] = [];
  let workers: number | undefined;

  // ── 旗から ──
  const known = new Set(cur.map((c) => c.id));
  const flagged = Object.keys(flags).filter((k) => known.has(k) || /^ashigaru[1-7]$/.test(k));
  if (flags['workers'] !== undefined) workers = Number(flags['workers']);
  for (const id of flagged) {
    const [cli, model] = flags[id]!.split(':', 2);
    if (!cli || !isCli(cli)) {
      return { code: EXIT_INVALID, err: `--${id} の CLI が起こせる物に無い: ${cli}（${LAUNCHABLE_CLIS.join(' / ')}）` };
    }
    const c: Change = { id, cli };
    if (model) c.model = model;
    else if (cur.find((x) => x.id === id)?.cli !== cli) {
      return { code: EXIT_INVALID, err: `--${id} ${cli}: CLI を変えるなら模型も対で（例: --${id} ${cli}:<模型>）。模型だけ残すと黙って動かぬ。` };
    }
    changes.push(c);
  }

  // ── 訊く ──
  if (flagged.length === 0 && workers === undefined) {
    if (!io.isTTY) {
      return {
        code: EXIT_INVALID,
        err:
          '端末でないゆえ訊けぬ。旗で渡されよ:\n' +
          '  honden roster set --karo cursor:auto --ashigaru3 codex:gpt-5.6-sol --workers 3 [--dry-run] [--yes]',
      };
    }
    io.say(`  いまの顔ぶれ（${path}）。空で送れば据え置き。`);
    const order = [...cur.filter((c) => !/^ashigaru/.test(c.id) && c.id !== 'gunshi'), ...cur.filter((c) => c.id === 'gunshi')];
    const askOne = (c: { id: string; cli: string | null; model: string | null }): boolean => {
      const a = io.ask(`  ${c.id.padEnd(10)} CLI [${LAUNCHABLE_CLIS.join('/')}] (${c.cli ?? '-'}): `);
      if (a === null) return false;
      const cli = a.trim() || c.cli || '';
      if (!isCli(cli)) { io.say(`    ${cli} は起こせぬ。据え置く`); return true; }
      const sug = suggestModels(doc, cli, cur);
      const keep = cli === c.cli ? c.model : null;
      const hint = keep ? keep : sug.length ? sug.join(' / ') : '自由に';
      const b = io.ask(`  ${' '.repeat(10)} 模型 (${hint}): `);
      if (b === null) return false;
      const model = b.trim() || keep || '';
      if (!model) { io.say('    模型が無い。CLI だけ差すと黙って動かぬゆえ据え置く'); return true; }
      if (cli !== c.cli || model !== c.model) changes.push({ id: c.id, cli, model });
      return true;
    };
    for (const c of order) if (!askOne(c)) return { code: EXIT_INVALID, err: '中断した。何も書いておらぬ。' };
    const ws = cur.filter((c) => /^ashigaru/.test(c.id));
    const n = io.ask(`  足軽の頭数 (${ws.length}): `);
    if (n === null) return { code: EXIT_INVALID, err: '中断した。何も書いておらぬ。' };
    const want = n.trim() ? Number(n.trim()) : ws.length;
    if (!Number.isInteger(want) || want < 1 || want > 7) return { code: EXIT_INVALID, err: '足軽は 1〜7。何も書いておらぬ。' };
    if (want !== ws.length) workers = want;
    for (const c of ws.slice(0, want)) if (!askOne(c)) return { code: EXIT_INVALID, err: '中断した。何も書いておらぬ。' };
    for (let k = ws.length + 1; k <= want; k++) {
      const id = `ashigaru${k}`;
      const a = io.ask(`  ${id.padEnd(10)} CLI [${LAUNCHABLE_CLIS.join('/')}]: `);
      if (a === null || !isCli(a.trim())) return { code: EXIT_INVALID, err: `${id} の CLI が無い。何も書いておらぬ。` };
      const sug = suggestModels(doc, a.trim(), cur);
      const b = io.ask(`  ${' '.repeat(10)} 模型 (${sug.join(' / ') || '自由に'}): `);
      if (b === null || !b.trim()) return { code: EXIT_INVALID, err: `${id} の模型が無い。何も書いておらぬ。` };
      changes.push({ id, cli: a.trim(), model: b.trim() });
    }
  }

  // ── 当てて、見せて、書く ──
  const r = applyRoster(text, { changes, ...(workers !== undefined ? { workers } : {}) });
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  if (r.summary.length === 0) return { code: EXIT_OK, out: '  変わる所が無い。何も書いておらぬ。' };
  const shown = r.summary.join('\n');
  if (dryRun) return { code: EXIT_OK, out: `${shown}\n  （下見。書いておらぬ）` };
  if (!yes) {
    if (!io.isTTY) return { code: EXIT_INVALID, err: `${shown}\n  端末でないゆえ確かめられぬ。--yes で通されよ。` };
    io.say(shown);
    const a = io.ask('  書くか [y/N]: ');
    if (a === null || !/^y(es)?$/i.test(a.trim())) return { code: EXIT_OK, out: '  やめた。何も書いておらぬ。' };
  }
  const tmp = `${path}.${process.pid}.new`;
  writeFileSync(tmp, r.text, 'utf8');
  renameSync(tmp, path);
  const synced = runRosterSync(dbPath, path);
  return {
    code: synced.code,
    out: `${shown}\n  ${path} へ書いた。\n${synced.out ?? synced.err ?? ''}\n  立っておる陣には効かぬ。次の出陣から。`,
  };
}

/** `honden roster` — いまの顔ぶれ。 */
export function runRosterShow(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const r = roster(db);
  if (r.length === 0) {
    return {
      code: EXIT_INVALID,
      err: '名簿が空である。\n  honden roster sync --settings <settings.yaml> で入れられよ。',
    };
  }
  return {
    code: EXIT_OK,
    out: r.map((e) => `  ${e.id.padEnd(10)} ${e.role.padEnd(9)} ${e.cli ?? ''} ${e.model ?? ''}`).join('\n'),
  };
}

/**
 * 働く者が皆の分を見たなら刻む。
 *
 * 旧権限表は queue/tasks/* を役ごとに read_deny で塞いでいた。正本を DB へ
 * 寄せて境界は消えたが、覗くこと自体は禁じぬ（突き合わせに要る・殿の下知）。
 * ただし **跡の残らぬ道は残さぬ**——inbox.peek と同じ流儀で揃える。
 * 差配役が全体を見るのは職分ゆえ刻まぬ。線の意味は「働く者が皆の分を見た」に残す。
 */
function markBroadView(db: Database, selfId: string | undefined, action: string, detail: string): void {
  if (!isWorker(db, selfId)) return;
  journal(db, { actor: selfId ?? '名乗り無し', action, target: '皆', detail });
}

/** `honden lease` — いまの持ち場と貸与。 */
export function runLeaseShow(dbPath: string | undefined, selfId?: string): RunResult {
  const db = openStore({ path: dbPath });
  const rows = db
    .query('SELECT agent, task_id, status, holder, lease_until FROM task ORDER BY agent')
    .all() as { agent: string; task_id: string | null; status: string; holder: string | null; lease_until: string | null }[];
  markBroadView(db, selfId, 'lease.view', `${rows.length} 名の持ち場を見た`);
  if (rows.length === 0) return { code: EXIT_OK, out: '  持ち場の記録が無い。' };
  const now = new Date();
  const lines = rows.map((r) => {
    const st = leaseState({ holder: r.holder, leaseUntil: r.lease_until }, now);
    const mark = st === 'expired' ? '★期限切れ' : st === 'held' ? '働いておる' : '空き';
    return `    ${r.agent.padEnd(10)} ${mark.padEnd(10)} ${(r.task_id ?? '').padEnd(24)} ${r.lease_until ?? ''}`;
  });
  const stale = expired(db, now);
  return {
    code: EXIT_OK,
    out:
      '  持ち場\n' +
      lines.join('\n') +
      (stale.length > 0
        ? `\n  ★期限切れ ${stale.length} 件。自動では返さぬ（やりかけの仕事が失われるため）。\n` +
          '    手放させるなら honden lease release <agent> --force --reason "…"'
        : ''),
  };
}

/** `honden lease release <agent>` — 手放す。他人のものは force と理由が要る。 */
export function runLeaseRelease(
  dbPath: string | undefined,
  selfId: string | undefined,
  agent: string | undefined,
  force: boolean,
  reason: string | undefined,
): RunResult {
  if (!selfId) {
    return { code: EXIT_INVALID, err: '誰であるか確かめられぬ。HONDEN_AGENT_ID を置かれよ。' };
  }
  if (!agent) {
    return {
      code: EXIT_INVALID,
      err: 'どの持ち場か分からぬ。\n  honden lease release <agent> [--force --reason "…"]',
    };
  }
  const db = openStore({ path: dbPath });
  const r = tx(db, () => release(db, { agent, holder: selfId, force, reason }));
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  return {
    code: EXIT_OK,
    out: `  ${agent} の持ち場を空けた${force && selfId !== agent ? '（強制。台帳に跡が残る）' : ''}`,
  };
}

/** `honden cmd new` — 司令を書く。将軍だけ。 */
export function runCmdNew(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    return {
      code: EXIT_OK,
      out: `  読み取り: ${Object.keys(picked.value).join(' / ')}\n  → 書き込んでおらぬ (--dry-run)`,
    };
  }
  const db = openStore({ path: dbPath });
  const r = createCmd(db, selfId, picked.value);
  if (!r.ok) return { code: EXIT_INVALID, err: r.message };
  return { code: EXIT_OK, out: `  ${r.id} を書いた。家老へ渡されよ。` };
}

/** `honden task assign` — 持ち場へ振る。家老だけ。 */
export function runTaskAssign(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    return {
      code: EXIT_OK,
      out: `  読み取り: ${Object.keys(picked.value).join(' / ')}\n  → 書き込んでおらぬ (--dry-run)`,
    };
  }
  const db = openStore({ path: dbPath });
  const r = assignTask(db, selfId, picked.value);
  if (!r.ok) return { code: EXIT_INVALID, err: r.message };
  return {
    code: EXIT_OK,
    out: `  ${r.id} を振った。task_assigned を届けた。` + (r.message ? `\n  ${r.message}` : ''),
  };
}

/** `honden inbox read` — 未読を読む。 */
export function runInboxRead(
  dbPath: string | undefined,
  selfId: string | undefined,
  target: string | undefined,
  all: boolean,
): RunResult {
  const agent = target ?? selfId;
  if (!agent) {
    return {
      code: EXIT_INVALID,
      err: '誰の inbox か分からぬ。\n  HONDEN_AGENT_ID を置くか、--agent <名> を渡されよ。',
    };
  }
  const db = openStore({ path: dbPath });
  const msgs = list(db, agent, { all });
  const s = summarize(db, agent);
  const peeking = target !== undefined && target !== selfId;
  // 他人の受け渡しを覗いたなら跡を残す。
  //
  // 旧環境は queue/inbox/* を **役ごとに read_deny** で塞いでいた
  // （config/opencode-permissions.yaml）。正本を一つの DB に寄せた時、
  // その境界は消える——**構造の変更が、静かに縛りを解いた**。
  // 覗くこと自体は禁じぬ（honden peek と同じく、突き合わせに要る）が、
  // 跡の残らぬ道は残さぬ。peek は跡を残し、こちらは残らぬ——
  // 同じ部屋への戸が二つあって片方だけ帳面に載る、では帳面が嘘になる。
  if (peeking) {
    journal(db, {
      actor: selfId ?? '名乗り無し',
      action: 'inbox.peek',
      target: agent,
      detail: `未読 ${s.total} 件を覗いた`,
    });
  }
  if (msgs.length === 0) {
    return { code: EXIT_OK, out: `  ${agent}: ${all ? '一件も無い' : nudgeText(s)}` };
  }
  const head = `  ${agent}: ${nudgeText(s)}` + (peeking ? '（覗いておるだけ。既読にはできぬ）' : '');
  const body = msgs
    .map((m) => {
      const mark = m.read ? '  ' : '● ';
      return (
        `\n  ${mark}${m.id}  [${m.type}] ${m.sender} → ${m.agent}  ${m.createdAt}\n` +
        m.body
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n')
      );
    })
    .join('\n');
  return { code: EXIT_OK, out: head + body };
}

/** `honden inbox ack <id...>` — 既読にする。自分のものだけ。 */
export function runInboxAck(
  dbPath: string | undefined,
  selfId: string | undefined,
  ids: string[],
  all: boolean,
): RunResult {
  if (!selfId) {
    return {
      code: EXIT_INVALID,
      err:
        '誰であるか確かめられぬ。既読は自分の報せだけである。\n' +
        '  HONDEN_AGENT_ID を置くか、pane の @agent_id を設定されよ。',
    };
  }
  const db = openStore({ path: dbPath });
  const r = all ? ackAll(db, selfId) : ack(db, selfId, ids);
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  const s = summarize(db, selfId);
  return {
    code: EXIT_OK,
    out:
      `  既読にした ${r.changed.length} 件` +
      (r.already.length > 0 ? `（${r.already.length} 件はすでに既読）` : '') +
      `\n  残り: ${nudgeText(s)}`,
  };
}

/** `honden route <bloom>` — 誰に振れるかを挙げる。 */
export function runRoute(
  dbPath: string | undefined,
  bloomRaw: string | undefined,
  role: string | undefined,
  providers: string | undefined,
  busy: string | undefined,
): RunResult {
  const bloom = Number(String(bloomRaw ?? '').replace(/^[Ll]/, ''));
  if (!Number.isFinite(bloom)) {
    return {
      code: EXIT_INVALID,
      err: '難度が要る。\n  honden route <1-6> [--role worker] [--providers openai,anthropic] [--busy a,b]',
    };
  }
  if (role && role !== 'worker' && role !== 'commander') {
    return { code: EXIT_INVALID, err: `役は worker か commander。受け取った値: ${JSON.stringify(role)}` };
  }
  const db = openStore({ path: dbPath });
  const r = recommend(db, {
    bloom,
    role: role as 'worker' | 'commander' | undefined,
    allowedProviders: providers ? providers.split(',').filter(Boolean) : undefined,
    busy: busy ? busy.split(',').filter(Boolean) : undefined,
  });
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  const sw =
    r.switchable.length > 0
      ? '\n  切り替えれば足りる者もおる:\n' +
        r.switchable.map((s) => `    ${s.agent}: ${s.from} → ${s.to}`).join('\n')
      : '';
  return {
    code: EXIT_OK,
    out:
      `  L${bloom} に振れる者（足りる中で軽い順）\n` +
      r.candidates
        .map((c) => `    ${c.agent.padEnd(10)} ${c.model.padEnd(16)} ${c.provider.padEnd(10)} L${c.maxBloom} まで`)
        .join('\n') + sw,
  };
}

export function runSearch(dbPath: string | undefined, query: string, limit: number): RunResult {
  if (query.trim() === '') {
    return {
      code: EXIT_INVALID,
      err: '探す語が無い。\n  honden search <語> [--limit N]',
    };
  }
  const db = openStore({ path: dbPath });
  let hits: Hit[];
  try {
    hits = search(db, query, limit);
  } catch (e) {
    // 引けなかったのは、探し方の問題であって仕組みの故障ではない。
    // 直せる誤りとして返す——EXIT_SYSTEM で返すと「壊れた」と読まれる。
    if (e instanceof SearchError) return { code: EXIT_INVALID, err: e.message };
    return { code: EXIT_SYSTEM, err: `検索が止まった: ${String(e).slice(0, 300)}` };
  }
  if (hits.length === 0) {
    return {
      code: EXIT_OK,
      out:
        `  「${query}」は見つからぬ。\n` +
        '  語の途中からは当たらぬ造りゆえ、語の頭から打たれよ。\n' +
        '  取り込みが済んでおるかは honden import で確かめられる。',
    };
  }
  const lines = [`  「${query}」 ${hits.length} 件`];
  for (const h of hits) lines.push(`    ${h.kind.padEnd(8)} ${h.source ?? h.ref ?? ''}`);
  return { code: EXIT_OK, out: lines.join('\n') };
}

const USAGE = `honden — 多エージェント運用の差配層

  honden roster sync --settings <settings.yaml>        顔ぶれを入れ替える
  honden roster set [--<役> <cli>:<模型>] [--workers N]  顔ぶれを差し替える（端末なら訊く）
  honden isolate [check]                               隔離の構えと効き目（既定 none）
  honden roster                                        いまの顔ぶれ
  honden config                                        設定の在り処と上の段
  honden config get <鍵>                               設定を一つ引く（値だけ返す）
  honden import [--root PATH] [--sub queue,saytask]   shogun の YAML を取り込む
  honden cmd new <<'EOF'                               司令を書く（将軍だけ）
    north_star: …
    purpose: …
    acceptance_criteria:
      - …
    command: |
      …
    project: vrt
    priority: high
  EOF
  honden task assign --agent ashigaru1 --cmd_id cmd_1 --title 実装せよ [--bloom L4]
                     [--workspace .worktrees/x] [--branch feat/y]   重なれば振れぬ
  honden norms [ドメイン] [--root <kagemusha>]          規約の棚と、初稿へ入るもの
  honden norms root <path>                             棚の在り処を決める
  honden projects sync --file <projects.yaml>          案件の所在を写す
  honden projects                                      いまの所在と、働く場所
  honden claim                                         誰がどこを握っておるか
  honden claim check [path|branch] <場所>              そこが空いておるか
  honden claim release <番号> [--force --reason "…"]   手放す／譲らせる
  honden peek <agent> --reason "…"                     他の者の持ち場を覗く（理由必須・台帳に残る）
  honden history [path|branch] <場所>                  そこで何が起きたのかを辿る
  honden task assign … --bypass --reason "…"                 家老を通さぬ迂回（将軍だけ）
  honden cmd amend <<'EOF'                             途中で書き換える（知らせが同時に飛ぶ）
    cmd_id: cmd_713
    reason: skills が whitelist gitignore であることを見落としておった
    acceptance_criteria:                               丸ごと置き換え
      - …
  EOF
  honden cmd amend <<'EOF'                             差分でも受ける
    cmd_id: cmd_713
    reason: …
    diff: |                                            文脈が合わねば当たらぬ
      --- a/command
      +++ b/command
      @@ -3,2 +3,3 @@
       前の行
      +足す行
       後の行
  EOF
  honden decisions                                     殿の裁定を待っておるもの（開いておる分だけ）
  honden decision raise <<'EOF'                        裁定を仰ぐ（上役だけ）
    question: 32 を入れ直すか
    choices: ["いま入れる", "次の区切りまで待つ", "取り下げる"]
    fallback: 次の区切りまで待つ
    until: 08:00
  EOF
  honden decide <番号> "<選び>" [--note "…"]           一語で下ろす（将軍だけ）
  honden cmd show <cmd_id>                             受け入れ条件と覆い具合
  honden cmd done <cmd_id> [--bypass --reason "…"]     司令を閉じる（家老だけ・門あり）
  honden report submit <<'EOF'                          足軽が報せる → 軍師へ自動で行く
    task_id: subtask_1_x
    status: done
    summary: |
      何をしたか
    acceptance:
      1: "cargo test → job 18 / service 195 / exit 0"
      3: "git log で push しておらぬことを確認"
  EOF
  honden report qc <<'EOF'                              軍師が検める → 家老へ自動で行く
    report_id: 12
    verdict: APPROVED
    summary: |
      何をどう検めたか
    checks:
      - name: 試験の独立再現
        result: PASS
        note: 隔離 worktree で同数
  EOF
  honden lease                                         持ち場と貸与の様子
  honden lease renew [--minutes N]                      働いておる当人が期限を延ばす
  honden lease release <agent> [--force --reason "…"]  手放す
  honden route <1-6> [--role worker] [--providers ...] 誰に振れるかを挙げる
  honden search <語> [--limit N]                       取り込んだものを引く
  honden patch [--root DIR] [--dry-run] < change.diff  ファイルへ差分を当てる
                                                       （文脈が一意な時だけ・全部当たるか何も書かぬか）
  honden inbox write <宛先> <本文> <種別> <差出人>      旧 inbox_write.sh と同じ並び
  honden inbox write --to A --from B --type T --body 本文
  honden inbox write <<'EOF'
    to: karo
    from: shogun
    type: cmd_new
    body: |
      本文
  EOF
  honden inbox read [--agent X] [--all]                未読を読む
  honden inbox ack <id...> | --all                     既読にする（自分のだけ）
  honden inbox unread [agent]                          未読の内訳

  --dry-run  読み取り結果だけ見せて書き込まない
  --db PATH  正本の場所 (既定 ~/.honden/honden.db)

並び順・旗・標準入力は、どれか一つを使う。二つ以上渡すと弾かれる。
長い本文は EOF が向いておる。シェルが引用符に手を入れぬゆえ。

布陣の外 (TMUX_PANE が無い) から送るときは、役職を騙れぬ。
review_session / external_audit のような、外だと分かる名を from に使うこと。

報告の路は現行のまま。足軽 → 軍師 → 家老 → dashboard → 将軍。
宛先は引数に無い。飛び越えようがないゆえ、指示書の禁止事項を守る要が無い。
家老から将軍への inbox は開けておらぬ（殿の入力を割り込みで潰さぬため）。

司令は、全条件が証拠つきで覆われ、軍師が是と言うまで閉じられぬ。
「済」だけの証拠は弾く。後から検める者が辿れぬゆえ。

いまは影の段で、shogun 側の YAML へは一切書かない。

顔ぶれは環境ごとに違う。足軽は 1 体から 7 体まで。
まず roster sync で入れること。名簿が空のままでは送れない。
`;

/** `honden report submit` — 足軽が報せる。宛先は選べぬ（軍師へ行く）。 */
export function runReportSubmit(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    return {
      code: EXIT_OK,
      out: `  読み取り: ${Object.keys(picked.value).join(' / ')}\n  → 書き込んでおらぬ (--dry-run)`,
    };
  }
  const db = openStore({ path: dbPath });
  const r = submitReport(db, selfId, picked.value);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/** `honden report qc` — 軍師が検める。結果は家老へ行く。 */
export function runReportQc(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    return { code: EXIT_OK, out: `  読み取り: ${Object.keys(picked.value).join(' / ')}\n  → 書き込んでおらぬ (--dry-run)` };
  }
  const db = openStore({ path: dbPath });
  const r = submitQc(db, selfId, picked.value);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/** `honden cmd done` — 司令を閉じる。家老だけ。門を通らねば閉じられぬ。 */
export function runCmdDone(
  dbPath: string | undefined,
  selfId: string | undefined,
  input: Record<string, unknown>,
): RunResult {
  const db = openStore({ path: dbPath });
  const r = cmdDone(db, selfId, input);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/** `honden cmd show <id>` — 受け入れ条件と、いまどこまで覆っておるか。 */
/**
 * `honden cmd list` — 司令を並べる。既定は生きておるものだけ。
 *
 * **在るものと思って案内しておきながら、実は無かった**（指示書を移した
 * 配下が見つけた・2026-08-28）。二つの hook が起動時の手順として
 * `honden cmd list` を叩けと書いており、叩けば USAGE が出た。
 * cmd_712 が戦った「案内と実物の割れ」を、将軍自身が作っていたことになる。
 *
 * 差配役が今何が動いておるかを見る道は要る。塞ぐのでなく、建てる。
 */
export function runCmdList(dbPath: string | undefined, all: boolean): RunResult {
  const db = openStore({ path: dbPath });
  const rows = db
    .query(
      all
        ? 'SELECT id, status, priority, assigned_to, purpose FROM cmd ORDER BY created_at DESC LIMIT 50'
        : `SELECT id, status, priority, assigned_to, purpose FROM cmd
           WHERE status IN ('pending','in_progress') ORDER BY created_at DESC LIMIT 50`,
    )
    .all() as { id: string; status: string; priority: string; assigned_to: string | null; purpose: string | null }[];
  if (rows.length === 0) {
    return { code: EXIT_OK, out: all ? '  司令が一つも無い。' : '  動いておる司令は無い（済んだものも見るなら --all）。' };
  }
  const lines = rows.map((r) => {
    const who = r.assigned_to ? ` → ${r.assigned_to}` : '';
    const p = r.purpose ? ` ${r.purpose.split('\n')[0]!.slice(0, 46)}` : '';
    return `  ${r.id.padEnd(12)} [${r.status.padEnd(11)}] ${r.priority.padEnd(6)}${who}${p}`;
  });
  return { code: EXIT_OK, out: lines.join('\n') + `\n\n  ${rows.length} 件（honden cmd show <番号> で中身と覆いが見られる）` };
}

export function runCmdShow(dbPath: string | undefined, cmdId: string | undefined): RunResult {
  if (!cmdId) return { code: EXIT_INVALID, err: '司令の番号を渡されよ。例: honden cmd show cmd_1' };
  const db = openStore({ path: dbPath });
  const cmd = db.query('SELECT id, status, purpose FROM cmd WHERE id = ?').get(cmdId) as
    | { id: string; status: string; purpose: string | null }
    | null;
  if (!cmd) return { code: EXIT_INVALID, err: `そのような司令は無い: ${cmdId}` };
  const cov = coverageOf(db, cmdId);
  const lines = [`  ${cmd.id}  [${cmd.status}]  ${cmd.purpose ?? ''}`, '  受け入れ条件:'];
  if (cov.criteria.length === 0) lines.push('    （無し）');
  for (const c of cov.criteria) {
    const got = cov.covered.get(c.idx);
    lines.push(`    ${c.idx}. ${c.text}`);
    lines.push(got ? `       覆済 ← #${got.reportId} ${got.agent}: ${got.evidence}` : '       未達');
  }
  lines.push(`  検め: ${cov.passing.map((p) => `#${p.id} ${p.verdict}`).join(', ') || 'まだ無い'}`);
  if (cov.unreviewed.length > 0) {
    lines.push(`  検め待ち: ${cov.unreviewed.map((u) => `#${u.id} ${u.agent}/${u.taskId}`).join(', ')}`);
  }
  void criteriaOf;
  return { code: EXIT_OK, out: lines.join('\n') };
}

/**
 * `honden nudge` — 常駐する芯から呼ばれる手。
 *
 * 最後の行に `{"next_wake_ms": N}` を出す。芯はそれを読んで寝る。
 * 芯は agent も段も知らぬので、次にいつ起こすかもこちらが決める。
 */
export async function runNudge(
  dbPath: string | undefined,
  dryRun: boolean,
  wakeShogun: boolean,
  reason: string | undefined,
  selfId?: string,
): Promise<RunResult> {
  // 二つの手が同時に撃つのを止める。芯は前の子が終わる前に次を起こすゆえ、
  // 錠が無ければ両方が「まだ撃っておらぬ」と読んで揃って撃つ（実害を見た）。
  // --dry-run は書かぬゆえ錠を要さぬ。
  if (dryRun) return runNudgeInner(dbPath, dryRun, wakeShogun, reason, selfId);
  const lockPath = `${dbPath ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH}.nudge.lock`;
  const r = await withNudgeLock(lockPath, () =>
    runNudgeInner(dbPath, dryRun, wakeShogun, reason, selfId),
  );
  if (r === null) {
    // 撃たぬのが正しい。芯へは「次は普通の間で」と返す。
    return { code: EXIT_OK, out: `  他の手が撃っておる。退く。\n${JSON.stringify({ next_wake_ms: 60_000 })}` };
  }
  return r;
}

async function runNudgeInner(
  dbPath: string | undefined,
  dryRun: boolean,
  wakeShogun: boolean,
  reason: string | undefined,
  selfId?: string,
): Promise<RunResult> {
  const db = openStore({ path: dbPath });

  // 一回きりの明示は、上役の判断にする。
  //
  // 門が無く、誰でも将軍を起こせた。しかも台帳の actor は 'nudge' 固定で
  // **誰が起こしたか跡が残らなかった**。様態の切替は将軍に絞ったのに、
  // 同じ効果を持つ一回きりの方が素通しでは、絞った意味が無い。
  if (wakeShogun && (!selfId || roleOfId(selfId) !== 'commander')) {
    return {
      code: EXIT_INVALID,
      err:
        `将軍を起こすのは上役の判断である（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  殿の入力を割り込みで潰すゆえ。家老へ回されよ。',
    };
  }
  const now = new Date();

  // 未読が 0 から増えた者に、続き始めを刻む。
  // 刻む前に段を数えると、初回がいきなり段 1 の「経ち 0」でなく
  // 前回の残りから始まってしまう。
  startClocks(db, now, { wakeShogun });

  let plans = plan(db, now, { wakeShogun });
  // 段 3 の的が手すきかを見る。busy の相手に文脈消しを撃っても拒まれる
  // （codex 実測）ゆえ、塞がっておる者は素の合図へ降ろして延期する。
  const busy = new Set<string>();
  for (const p of plans) {
    if (p.send && p.level === 3 && p.pane && captureBusy(p.pane, p.cli)) busy.add(p.agent);
  }
  if (busy.size > 0) plans = plan(db, now, { wakeShogun, busy });
  const lines: string[] = [];

  if (plans.length === 0) {
    lines.push('  未読は無い。撃つ相手も無い。');
  }

  let soonest = 600_000; // 誰も居らぬなら 10 分後にもう一度だけ見る
  for (const p of plans) {
    soonest = Math.min(soonest, p.nextInMs);
    const head = `  ${p.agent} 未読${p.unread} 段L${p.level} ${p.pane?.label ?? 'ペイン不明'}`;
    if (!p.send) {
      lines.push(`${head} → 撃たぬ（${p.reason}）`);
      continue;
    }
    const why = p.byExplicitWake ? ' ※ 殿の在席中に、明示の指示で起こす' : '';
    if (dryRun) {
      lines.push(
        `${head} → ${JSON.stringify(p.text)}${p.hardRecovery ? ' (先に Escape×2 + Ctrl-C)' : ''}${why} [--dry-run ゆえ撃たぬ]`,
      );
      continue;
    }
    const r = await send(p);
    if (r.ok) {
      record(db, p, now, reason, selfId);
      lines.push(`${head} → 撃った: ${JSON.stringify(p.text)}${why}`);
    } else {
      lines.push(`${head} → 撃てぬ: ${r.err}`);
    }
  }

  // 芯への返事。人が読む行に混ざってよいが、必ず最後に置く。
  lines.push(JSON.stringify({ next_wake_ms: soonest }));
  return { code: EXIT_OK, out: lines.join('\n') };
}

/**
 * `honden guard check --cmd` — 禁じ手の門で検めるだけ。人と試験の入口。
 */
export function runGuardCheck(cmd: string | undefined): RunResult {
  if (!cmd) return { code: EXIT_INVALID, err: '--cmd を渡されよ' };
  // 手形が混じっていても、検めるのは本体である（hook と同じ目で見る）
  // 構造で解いた上で照らす。hook と同じ目で見るゆえ、ここも同じ層を通す。
  const split = guardSplitOtp(cmd);
  const v = guardJudgeStructured(split.cmd, parseRunner(REPO_ROOT), split.raw);
  if (v.permission === 'allow') return { code: EXIT_OK, out: '  通ってよし' };
  return {
    code: EXIT_INVALID,
    out:
      `  止めた: ${v.rule} — ${v.reason}\n` +
      (v.appealable
        ? '  正当な理由があるなら: honden guard appeal --cmd "…" --reason "…" で将軍へ直訴せよ'
        : '  絶対域である。手形でも通らぬ'),
  };
}

/**
 * `honden guard hook cursor` — cursor の beforeShellExecution をそのまま受ける。
 * stdin: {command, cwd} / stdout: {permission, user_message, agent_message}。
 * コマンド頭の HONDEN_OTP=<札> は剥がして検め、残り本体を裁く。
 */
export async function runGuardHookCursor(dbPath: string | undefined, selfId: string | undefined): Promise<RunResult> {
  let input: { command?: string };
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // 入力が壊れておる。failClosed が守るよう deny を返す
    return { code: EXIT_OK, out: JSON.stringify({ permission: 'deny', agent_message: 'guard: 入力を読めなかった' }) };
  }
  const { otp, cmd, raw } = guardSplitOtp(input.command ?? '');
  // 構造で解いた上で照らす（紋様と二枚重ね・src/guard.ts の judgeStructured）
  const v = guardJudgeStructured(cmd, parseRunner(REPO_ROOT), raw);
  if (v.permission === 'allow') return { code: EXIT_OK, out: JSON.stringify({ permission: 'allow' }) };

  if (otp && v.appealable) {
    const db = openStore({ path: dbPath });
    const agent = selfId ?? '名乗り無し';
    const r = guardVerify(db, otp, cmd, agent, new Date());
    if (r.ok) {
      return { code: EXIT_OK, out: JSON.stringify({ permission: 'allow', agent_message: `guard: ${r.message}` }) };
    }
    journalDenial(dbPath, selfId, v.rule, cmd, '手形が通らず:');
    return {
      code: EXIT_OK,
      out: JSON.stringify({
        permission: 'deny',
        user_message: `guard ${v.rule}: 手形不備 — ${r.message}`,
        agent_message: `guard: ${v.rule} を止めた上、手形も通らぬ（${r.message}）。改めて直訴せよ。`,
      }),
    };
  }

  journalDenial(dbPath, selfId, v.rule, cmd);
  const appeal = v.appealable
    ? ` 正当な理由があるなら honden guard appeal --cmd '<コマンド>' --reason '<理由>' で将軍へ直訴し、下りた手形を HONDEN_OTP=<札> をコマンドの頭に付けて使え。`
    : ' これは絶対域であり、手形でも通らぬ。';
  return {
    code: EXIT_OK,
    out: JSON.stringify({
      permission: 'deny',
      user_message: `guard ${v.rule}: ${v.reason}`,
      agent_message: `guard: ${v.rule} — ${v.reason}。${appeal}`,
    }),
  };
}

/**
 * `honden guard hook codex` — codex の PreToolUse をそのまま受ける。
 *
 * stdin: {tool_name, tool_input:{command}, permission_mode, …}
 * stdout: 通すなら何も出さず 0 で抜ける。止めるなら
 *   {hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
 *    permissionDecisionReason:"…"}}
 *
 * codex の PreToolUse は systemMessage しか受けず、continue / stopReason を
 * 返すと「フック失敗」と見なされ **ツール呼び出しが続行される**（公式仕様）。
 * ゆえに余計な欄を足してはならぬ。deny は hookSpecificOutput 一本で言う。
 *
 * `--dangerously-bypass-approvals-and-sandbox`（permission_mode=
 * bypassPermissions）でも呼ばれる——承認もサンドボックスも消えた素通しの
 * codex に、これが唯一残る門である。
 */
/**
 * 拒んだ事実を台帳へ落とす。**許しは刻まぬ**——常道に費えを課さぬため。
 *
 * 殿の申し出（2026-08-29）で秘密鍵を読む手を門へ載せた折、
 * 「読まれた跡すら残らぬ」ことが分かった。門は拒むが、**誰が何を試みたかが
 * どこにも残らなんだ**。直訴すれば刻まれるが、直訴せぬ者の跡は消える。
 *
 * 拒みは稀ゆえ台帳は太らぬ。太るとすれば、それは**同じ壁を何度も叩いておる
 * 者が居る**という報せであり、消してはならぬ signal である。
 *
 * 記帳に失敗しても拒みは返す。見張りの不調で門が開いては本末転倒。
 */
function journalDenial(
  dbPath: string | undefined,
  selfId: string | undefined,
  rule: string | undefined,
  cmd: string,
  note?: string,
): void {
  try {
    const db = openStore({ path: dbPath });
    journal(db, {
      actor: selfId ?? '名乗り無し',
      action: 'guard.deny',
      target: rule ?? '規則不明',
      detail: `${note ? `${note} ` : ''}${guardNormalize(cmd).slice(0, 160)}`,
    });
  } catch {
    /* 刻めずとも拒みは通す */
  }
}

export async function runGuardHookCodex(dbPath: string | undefined, selfId: string | undefined): Promise<RunResult> {
  const deny = (reason: string) => ({
    code: EXIT_OK,
    out: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  });

  let input: { tool_name?: string; tool_input?: { command?: string } };
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return deny('guard: 入力を読めなかった');
  }
  // Bash 以外は見ぬ。matcher で絞られておるはずだが、二重に確かめる。
  const name = input.tool_name ?? '';
  if (name && name !== 'Bash' && name !== 'Shell') return { code: EXIT_OK, out: '' };

  const { otp, cmd, raw } = guardSplitOtp(input.tool_input?.command ?? '');
  // 構造で解いた上で照らす（紋様と二枚重ね・src/guard.ts の judgeStructured）
  const v = guardJudgeStructured(cmd, parseRunner(REPO_ROOT), raw);
  if (v.permission === 'allow') return { code: EXIT_OK, out: '' }; // 何も言わぬのが allow

  if (otp && v.appealable) {
    const db = openStore({ path: dbPath });
    const r = guardVerify(db, otp, cmd, selfId ?? '名乗り無し', new Date());
    if (r.ok) return { code: EXIT_OK, out: '' };
    journalDenial(dbPath, selfId, v.rule, cmd, '手形が通らず:');
    return deny(`guard ${v.rule}: 手形が通らぬ（${r.message}）。改めて直訴せよ。`);
  }

  journalDenial(dbPath, selfId, v.rule, cmd);
  const appeal = v.appealable
    ? ` 正当な理由があるなら honden guard appeal --cmd '<コマンド>' --reason '<理由>' で将軍へ直訴し、下りた手形を HONDEN_OTP=<札> をコマンドの頭に付けて使え。`
    : ' これは絶対域であり、手形でも通らぬ。';
  return deny(`guard ${v.rule}: ${v.reason}。${appeal}`);
}

/**
 * `honden guard facts --agent <者> --cmd "<命>"` — 検分の材料を正本から集める。
 *
 * 将軍が自分で裁く時も、道具を剥いだ検分者へ渡す時も、見るのは同じ束。
 * 出力は JSON——人が読む形に崩さぬのは、検分者へ file 渡しするためである。
 */
export function runGuardFacts(
  dbPath: string | undefined,
  selfId: string | undefined,
  agent: string | undefined,
  cmd: string | undefined,
  reason: string | undefined,
): RunResult {
  if (!agent || !cmd) return { code: EXIT_INVALID, err: '--agent と --cmd を渡されよ' };
  const db = openStore({ path: dbPath });
  // 束には他人の任・司令・報告の抜粋が入る。他人の分を引いたなら刻む。
  if (selfId && agent !== selfId) {
    journal(db, { actor: selfId, action: 'guard.facts.peek', target: agent, detail: '検分の束を引いた' });
  }
  return { code: EXIT_OK, out: JSON.stringify(guardFacts(db, agent, cmd, reason), null, 2) };
}

/**
 * `honden guard hook claude` — claude の PreToolUse をそのまま受ける。
 *
 * 受け答えの形は codex と同じである（codex が claude の形を写した）。
 * ゆえに実装は一つで足りる——皮を分けるのは呼ばれ方の違いだけで、
 * 判定器も応答も共有する。
 */
export const runGuardHookClaude = runGuardHookCodex;

/**
 * `honden guard selftest` — 門が生きておるかを、実際に叩いて確かめる。
 *
 * 据えた後に静かに消えるのが門の常である（信頼切れ・設定の書き換え・
 * 名簿の読み込み時期）。定期的に叩くほかない。
 */
export function runGuardSelftest(root: string | undefined): RunResult {
  const base = resolvePath(root ?? process.cwd());
  const checks = guardSelftest({
    root: base,
    exists: (p) => existsSync(p),
    run: (script, input) => {
      const r = Bun.spawnSync(['bash', script], { stdin: Buffer.from(input) });
      return r.success ? r.stdout.toString() : null;
    },
    read: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    codexTrusted: (cfg) => {
      try {
        const toml = readFileSync(join(homedir(), '.codex/config.toml'), 'utf8');
        return toml.includes(cfg);
      } catch {
        return false;
      }
    },
  });
  const lines = checks.map((c) => {
    const mark = c.denies ? '生きておる' : c.configured ? '**効いておらぬ**' : '据わっておらぬ';
    return `  ${c.cli.padEnd(7)} ${mark}${c.note ? `  — ${c.note}` : ''}`;
  });
  const dead = checks.filter((c) => c.configured && !c.denies);
  // 据わっておるのに効かぬのが最も危うい。据わっておらぬのは見れば分かるが、
  // 「据えたつもりで効いておらぬ」は静かである。
  return {
    code: dead.length > 0 ? EXIT_INVALID : EXIT_OK,
    out:
      '  禁じ手の門\n' +
      lines.join('\n') +
      (dead.length > 0 ? `\n\n  ${dead.length} 件が据わっておるのに効いておらぬ。直すまで守りは無いと思え。` : ''),
  };
}

/**
 * `honden brief [--role X] [--cli Y]` — 指示書を組み立てて出す。
 *
 * 役を省けば自分の名乗りから引く。CLI を省けば名簿から引く——
 * **己が何者で何を使っておるかは正本が知っておる**ゆえ、
 * 読む者は `honden brief` の一語で足りる。
 */
export function runBrief(
  dbPath: string | undefined,
  selfId: string | undefined,
  role: string | undefined,
  cli: string | undefined,
  root: string | undefined,
): RunResult {
  const base = resolvePath(root ?? process.cwd());
  let r = role ?? selfId;
  if (!r) {
    return { code: EXIT_INVALID, err: '誰の指示書か分からぬ。--role を渡すか、布陣の中で叩かれよ。' };
  }
  // ashigaru3 のような名は、役としては ashigaru である。
  const kind = /^ashigaru\d*$/.test(r) ? 'ashigaru' : r;
  let c = cli ?? null;
  if (!c) {
    try {
      const db = openStore({ path: dbPath });
      const row = db.query('SELECT cli FROM roster WHERE id = ?').get(r) as { cli: string } | null;
      c = row?.cli ?? null;
    } catch {
      /* 正本が無くとも組み立てはできる */
    }
  }
  const b = assembleBrief(base, kind, c);
  if (b.missing.length > 0) {
    return { code: EXIT_INVALID, err: `  指示書の部品が欠けておる: ${b.missing.join(' / ')}` };
  }
  if (!b.text.trim()) {
    return { code: EXIT_INVALID, err: `  ${kind} の指示書が空である。instructions/ を検められよ。` };
  }
  return { code: EXIT_OK, out: b.text };
}

/** `honden status` — 布陣の様子を一枚に並べる。 */
export function runStatus(dbPath: string | undefined, json: boolean): RunResult {
  const db = openStore({ path: dbPath, create: false });
  const rows = collectStatus(db);
  if (rows.length === 0) return { code: EXIT_OK, out: '  名簿が空である。honden roster sync を先に。' };
  if (json) return { code: EXIT_OK, out: JSON.stringify(rows, null, 2) };
  const absent = rows.filter((r) => r.pane === null).length;
  const urgent = rows.filter((r) => r.urgent).length;
  const core = coreCheck(dbPath ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH);
  const tail: string[] = [];
  tail.push(core.alive ? '芯は生きておる' : '**芯が死んでおる。合図は誰にも届かぬ**——立て直されよ');
  for (const st of core.strays) {
    tail.push(`別の正本を見張る芯が居る（pid ${st.pid} → ${st.path}）。畳むのは人の手で`);
  }
  if (absent > 0) tail.push(`${absent} 名が布陣に居らぬ`);
  if (urgent > 0) tail.push(`${urgent} 名に急ぎの未読`);
  return {
    code: EXIT_OK,
    out: renderStatus(rows) + (tail.length > 0 ? `\n\n  ${tail.join(' / ')}` : ''),
  };
}

/**
 * `honden export --out <場所>` — 切り戻しの綱。正本を旧環境の YAML へ吐く。
 *
 * 吐く先は必ず新しい場所。生きた queue/ へ直接は書かぬ——配置は人の手で。
 */
export function runExport(dbPath: string | undefined, selfId: string | undefined, outDir: string | undefined): RunResult {
  if (!outDir) {
    return {
      code: EXIT_INVALID,
      err: '--out <場所> を渡されよ。生きた queue/ へ直接は書かぬ——吐いた後、人の手で配置されよ。',
    };
  }
  const base = resolvePath(outDir);
  const db = openStore({ path: dbPath });
  const files = exportAll(db);
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { dirname, join } = require('node:path') as typeof import('node:path');
  for (const f of files) {
    const p = join(base, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.body);
  }
  journal(db, { actor: selfId ?? '名乗り無し', action: 'export.yaml', target: base, detail: `${files.length} 枚` });
  return {
    code: EXIT_OK,
    out:
      files.map((f) => `  ${f.path}`).join('\n') +
      `\n\n  ${files.length} 枚を ${base} へ吐いた。\n` +
      '  配置は人の手で（旧環境の queue/ を先に退避してから写されよ）。',
  };
}

/** `honden dashboard --serve` — 戦況をブラウザへ配る。止めるまで返らぬ。 */
function serveDashboard(dbPath: string | undefined, port: number, host: string | undefined): Promise<number> | number {
  let r: { port: number; host: string; stop: () => void };
  try {
    r = serveHttp({
      port,
      host,
      db: () => openStore({ path: dbPath, create: false }),
      compose: () => composeDashboard(dbPath),
    });
  } catch (e) {
    // main の尻に受け手が無い。ここで受けねば生の stack が出る。
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_SYSTEM;
  }
  console.log(`  http://${r.host}:${r.port} で配っておる。止めるは Ctrl-C。`);
  if (r.host !== LOOPBACK) console.error('  ※ 己の内だけでなく外へも開いておる。戦況が見える範囲を確かめられよ。');
  // main の出口は process.exit —— ここで返せば配りながら即死する。
  // 止めの合図（SIGINT/SIGTERM）まで待ってから畳む。
  return new Promise<number>((resolve) => {
    const bye = () => { r.stop(); resolve(EXIT_OK); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  });
}

/**
 * 正本を読む口の受け止め手。**生の例外で倒れさせぬ。**
 *
 * 道を一字誤っただけで真新しい正本が生まれ「異常なし」と映る筋は塞いだが
 * （openStore の create:false）、塞いだ先で stack を吐いては読めぬ。
 * 何が無いのか・どこを疑うのかを言う。
 */
function readingStore<T>(work: () => T): { ok: true; value: T } | { ok: false; result: RunResult } {
  try {
    return { ok: true, value: work() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, result: { code: EXIT_SYSTEM, err: `  ${msg}` } };
  }
}

/** 戦況の md を正本から組む。CLI でも配信でも同じものを出す。 */
export function composeDashboard(dbPath: string | undefined): string {
  const db = openStore({ path: dbPath, create: false });
  const parts: string[] = [];
  // 旧 dashboard は現地時刻であった。UTC で出すと殿の時計と九時間ずれる。
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);
  parts.push('# 📊 戦況報告', `最終更新: ${stamp}`, '');

  // 🚨 要対応 = 殿の裁可待ち（倒れる時刻つき）
  const open = db
    .query("SELECT id, question, expires_at FROM decision WHERE status = 'open' ORDER BY id")
    .all() as { id: number; question: string; expires_at: string | null }[];
  parts.push('## 🚨 要対応 - 殿のご判断をお待ちしております');
  parts.push(
    open.length > 0
      ? open
          .map((d) => `- #${d.id} ${d.question.split('\n')[0]!}${d.expires_at ? `（${d.expires_at.slice(0, 16)} に既定へ倒れる）` : ''}`)
          .join('\n')
      : 'なし',
    '',
  );

  // 🔄 進行中
  const live = db
    .query("SELECT id, status, assigned_to, purpose FROM cmd WHERE status IN ('pending','in_progress') ORDER BY created_at DESC LIMIT 20")
    .all() as { id: string; status: string; assigned_to: string | null; purpose: string | null }[];
  parts.push('## 🔄 進行中 - 只今、戦闘中でござる');
  parts.push(
    live.length > 0
      ? live.map((c) => `- ${c.id} [${c.status}]${c.assigned_to ? ` → ${c.assigned_to}` : ''} ${(c.purpose ?? '').split('\n')[0]!}`).join('\n')
      : 'なし',
    '',
  );

  // ✅ 本日の戦果（表: 時刻 | 戦場 | 任務 | 結果）
  const today = new Date().toISOString().slice(0, 10);
  const done = db
    .query("SELECT id, project, purpose, completed_at FROM cmd WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at")
    .all(today) as { id: string; project: string | null; purpose: string | null; completed_at: string }[];
  parts.push('## ✅ 本日の戦果', '| 時刻 | 戦場 | 任務 | 結果 |', '|------|------|------|------|');
  for (const c of done) {
    parts.push(`| ${c.completed_at.slice(11, 16)} | ${c.project ?? '-'} | ${c.id} ${(c.purpose ?? '').split('\n')[0]!.slice(0, 40)} | done |`);
  }
  parts.push('');

  // 🎯 スキル化候補 = 報告の skill_candidate（同じ型を三度繰り返した報せ）
  const reports = db
    .query("SELECT agent, task_id, raw FROM report WHERE origin = 'native' ORDER BY created_at DESC LIMIT 50")
    .all() as { agent: string; task_id: string | null; raw: string }[];
  const skills: string[] = [];
  for (const r of reports) {
    try {
      const j = JSON.parse(r.raw) as { skill_candidate?: unknown };
      if (j.skill_candidate) {
        const sc = typeof j.skill_candidate === 'string' ? j.skill_candidate : JSON.stringify(j.skill_candidate);
        skills.push(`- ${sc}（${r.agent} / ${r.task_id ?? '-'}）`);
      }
    } catch {
      /* raw が JSON でない報せは飛ばす */
    }
  }
  parts.push('## 🎯 スキル化候補 - 承認待ち');
  parts.push(skills.length > 0 ? skills.join('\n') : 'なし', '');

  // 🛠️ 生成されたスキル — honden は skills を正本に持たぬ（repo の skills/ が実体）
  parts.push('## 🛠️ 生成されたスキル');
  parts.push('なし（skills/ 配下が実体。正本は数えぬ）', '');

  // ⏸️ 待機中 = 任を持たぬ働き手
  const idle = db
    .query("SELECT r.id FROM roster r LEFT JOIN task t ON t.agent = r.id WHERE r.role = 'worker' AND (t.task_id IS NULL OR t.status = 'idle' OR t.status = 'done') ORDER BY r.id")
    .all() as { id: string }[];
  parts.push('## ⏸️ 待機中');
  parts.push(idle.length > 0 ? idle.map((w) => `- ${w.id}`).join('\n') : 'なし', '');

  // 🧱 叩かれた壁 — 門が拒んだ跡。**数でなく散らばりを見る**（src/denials.ts）。
  // 誤検知と注入は数だけでは同じに見える。ここで分ける。
  parts.push(...denialRender(denialTally(denialCollect(db, new Date()))), '');

  // ❓ 伺い事項 — honden では裁可待ち（要対応）へ一本化してある
  parts.push('## ❓ 伺い事項');
  parts.push('なし（伺いは 🚨 要対応 へ一本化）');
  return parts.join('\n');
}

/** `honden guard charter` — 許状を切る。将軍のみ。cmd 縛りの多回券（honden-bot 専用）。 */
function runGuardCharter(
  dbPath: string | undefined,
  selfId: string | undefined,
  flags: Record<string, string>,
): RunResult {
  const agent = flags['agent'];
  const cmdId = flags['cmd-id'];
  const repo = flags['repo'];
  const verb = flags['verb'] ?? 'create';
  const reason = flags['reason'];
  if (!agent || !cmdId || !repo || !reason) {
    return { code: EXIT_INVALID, err: '--agent と --cmd-id と --repo と --reason を渡されよ（--verb create|comment・--uses N・--ttl-min M）' };
  }
  const uses = flags['uses'] ? Number(flags['uses']) : 10;
  const ttlMin = flags['ttl-min'] ? Number(flags['ttl-min']) : CHARTER_DEFAULT_TTL_MIN;
  if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > CHARTER_MAX_TTL_MIN) {
    return { code: EXIT_INVALID, err: `期限は 1〜${CHARTER_MAX_TTL_MIN} 分で渡されよ` };
  }
  const db = openStore({ path: dbPath });
  const now = new Date();
  const r = tx(db, () =>
    issueCharter(db, { agent, cmdId, repo, verb, uses, issuer: selfId ?? 'shogun', reason }, now, ttlMin * 60_000),
  );
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  const at = new Date().toISOString();
  tx(db, () => {
    inboxDeliver(db, {
      id: `msg_${Date.now().toString(36)}${Bun.hash(agent + at).toString(36).slice(0, 4)}_gc`,
      agent,
      at,
      type: 'guard_grant',
      sender: selfId ?? 'shogun',
      body:
        `許状 #${r.id} が下りた。${repo} への issue ${verb}・${uses} 回まで・期限 ${r.expiresAt}。\n` +
        `cmd ${cmdId} が閉じれば失効する。使い方: honden-bot issue ${verb} --repo ${repo} ... （札は要らぬ。名乗りで検められる）`,
    });
    inboxSignal(db);
  });
  return {
    code: EXIT_OK,
    out: `  許状 #${r.id} を切った（${agent} 宛・${repo} ${verb}・${uses} 回・期限 ${r.expiresAt}・${cmdId} 縛り）\n  inbox でも当人へ届けた。`,
  };
}

/** `honden guard charters` — 許状の一覧。監査の目ゆえ死んだものも由つきで出す。 */
function runGuardCharters(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const rows = listCharters(db, new Date());
  if (rows.length === 0) return { code: EXIT_OK, out: '  許状は一枚も無い。' };
  const lines = rows.map(
    (c) =>
      `  #${c.id} [${c.state}] ${c.agent} → ${c.repo} ${c.verb} 残${c.uses_left} ${c.cmd_id} 期限${c.expires_at.slice(0, 16)} （${c.issuer}: ${c.reason}）`,
  );
  return { code: EXIT_OK, out: lines.join('\n') };
}

/** `honden guard charter-revoke` — 許状の取り消し。将軍のみ。 */
function runGuardCharterRevoke(dbPath: string | undefined, selfId: string | undefined, id: string | undefined): RunResult {
  const n = Number(id ?? '');
  if (!Number.isInteger(n) || n <= 0) return { code: EXIT_INVALID, err: '--id <番号> を渡されよ' };
  const db = openStore({ path: dbPath });
  const r = tx(db, () => revokeCharter(db, n, selfId ?? 'shogun', new Date()));
  return r.ok ? { code: EXIT_OK, out: `  ${r.message}` } : { code: EXIT_INVALID, err: `  ${r.message}` };
}

/**
 * `honden guard grant` — 手形を切る。将軍のみ。札はこの出力にしか現れぬ。
 */
export function runGuardGrant(
  dbPath: string | undefined,
  selfId: string | undefined,
  cmd: string | undefined,
  agent: string | undefined,
  reason: string | undefined,
  ttlMin: string | undefined,
): RunResult {
  if (!cmd || !agent || !reason) return { code: EXIT_INVALID, err: '--cmd と --agent と --reason を渡されよ' };
  const ttl = ttlMin ? Number(ttlMin) * 60_000 : OTP_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60 * 60_000) {
    return { code: EXIT_INVALID, err: '期限は 1〜60 分で渡されよ' };
  }
  const db = openStore({ path: dbPath });
  const r = guardIssue(db, selfId, cmd, agent, reason, new Date(), ttl);
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  const at = new Date().toISOString();
  // 札は inbox で当人へ届ける。コマンドに紐づくゆえ、他所では使えぬ。
  inboxDeliver(db, {
    id: `msg_${Date.now().toString(36)}${Bun.hash(agent + at).toString(36).slice(0, 4)}_gg`,
    agent,
    at,
    type: 'guard_grant',
    sender: selfId ?? 'shogun',
    body:
      `手形が下りた。期限 ${r.expiresAt} まで・一度きり。\n` +
      `使い方: HONDEN_OTP=${r.code} をコマンドの頭に付けてそのまま実行せよ。\n` +
      `対象: ${guardNormalize(cmd)}`,
  });
  inboxSignal(db);
  return {
    code: EXIT_OK,
    out: `  手形を切った: ${r.code}（期限 ${r.expiresAt}・${agent} 宛・一度きり）\n  inbox でも当人へ届けた。`,
  };
}

/**
 * `honden guard appeal` — 止められた者の直訴。将軍へ urgent で届く。
 */
export function runGuardAppeal(
  dbPath: string | undefined,
  selfId: string | undefined,
  cmd: string | undefined,
  reason: string | undefined,
): RunResult {
  if (!cmd || !reason) return { code: EXIT_INVALID, err: '--cmd と --reason を渡されよ' };
  // 構造で解いた上で照らす（紋様と二枚重ね・src/guard.ts の judgeStructured）
  const v = guardJudgeStructured(cmd, parseRunner(REPO_ROOT));
  if (v.permission === 'allow') return { code: EXIT_OK, out: '  それは止められておらぬ。そのまま実行されよ' };
  if (!v.appealable) return { code: EXIT_INVALID, err: `  ${v.rule} は絶対域である。直訴しても通らぬ` };
  const db = openStore({ path: dbPath });
  const at = new Date().toISOString();
  const from = selfId ?? '名乗り無し';
  inboxDeliver(db, {
    id: `msg_${Date.now().toString(36)}${Bun.hash(from + at).toString(36).slice(0, 4)}_ga`,
    agent: 'shogun',
    at,
    type: 'guard_appeal',
    sender: from,
    body:
      `禁じ手の門への直訴（${v.rule}）\n` +
      `コマンド: ${guardNormalize(cmd)}\n` +
      `理由: ${reason}\n` +
      `検分の作法: 弁明を鵜呑みにせず、コマンド実体と task の系譜を正本から引いて突き合わせよ。\n` +
      `通すなら: honden guard grant --cmd '<同じコマンド>' --agent ${from} --reason '<裁定理由>'`,
  });
  inboxSignal(db);
  journal(db, { actor: from, action: 'guard.appeal', target: 'shogun', detail: `rule=${v.rule} cmd=${JSON.stringify(guardNormalize(cmd)).slice(0, 120)}` });
  return { code: EXIT_OK, out: '  直訴を将軍へ送った。裁定を待たれよ（手が空くまで他の仕事を進めてよい）' };
}

/** `honden mode` — 殿が在席かどうか。合図を将軍へ撃つかがこれで決まる。 */
export function runMode(
  dbPath: string | undefined,
  selfId: string | undefined,
  want: string | undefined,
  until: string | undefined,
): RunResult {
  const db = openStore({ path: dbPath });
  if (!want) {
    return { code: EXIT_OK, out: describeMode(getMode(db)) };
  }
  const r = setMode(db, selfId, want, { until });
  if (!r.ok) return { code: EXIT_INVALID, err: r.message };
  return { code: EXIT_OK, out: describeMode(r.state!) + (r.message ?? '') };
}

/** `honden claim` — いま誰がどこを握っておるか。 */
export function runClaimList(dbPath: string | undefined, selfId?: string): RunResult {
  const db = openStore({ path: dbPath });
  const held = liveClaims(db);
  markBroadView(db, selfId, 'claim.view', `${held.length} 件の取り置きを見た`);
  if (held.length === 0) return { code: EXIT_OK, out: '  握られておる場所は無い。' };
  const lines = held.map(
    (c) => `  #${c.id} [${c.kind}] ${c.value}\n      ${c.agent} が ${c.at} から（${c.taskId ?? '仕事不明'}）`,
  );
  return { code: EXIT_OK, out: lines.join('\n') };
}

/**
 * `honden claim check <場所>` — そこが空いておるか。
 *
 * 足軽が自分で問える。他人の持ち場を読まずに重なりの有無だけ分かるので、
 * 現行の「衝突の恐れに気づけ、だが他人のファイルは読むな」という
 * 守れぬ決めが守れる形になる。
 */
export function runClaimCheck(
  dbPath: string | undefined,
  kind: string | undefined,
  value: string | undefined,
  selfId?: string,
): RunResult {
  if (!value) {
    return {
      code: EXIT_INVALID,
      err: '検める場所を渡されよ。例: honden claim check path .worktrees/vrt-fix32',
    };
  }
  const k = (kind ?? 'path') as Kind;
  const db = openStore({ path: dbPath });
  const held = claimConflicts(db, k, value);
  if (held.length === 0) {
    return { code: EXIT_OK, out: `  空いておる: ${normClaim(k, value)}` };
  }
  // 足軽が塞がりに当たったなら家老へ報せる。
  //
  // 足軽には調整の手が無い。譲らせるのも振り直すのも家老の役目ゆえ、
  // 家老が知らねば、足軽は断られたまま止まる。
  // 家老自身が検めた時は報せない。それは家老が既に知っておること。
  let told = '';
  if (selfId && rosterOf(db).some((e) => e.id === selfId) && roleOfId(selfId) === 'worker') {
    const h = held[0]!;
    const sent = reportCollision(db, {
      from: selfId,
      with: h.agent,
      key: h.value,
      detail:
        `${selfId} が ${h.value} へ入ろうとして塞がれた。\n` +
        `  握っておるのは ${h.agent}（${h.taskId ?? '仕事不明'}・${h.at} から）`,
    });
    told = sent ? '\n\n  家老へ報せた。' : '\n\n  家老へは既に報せてある。';
  }
  return { code: EXIT_INVALID, err: explainConflict(k, normClaim(k, value), held) + told };
}

/** `honden claim release <番号>` — 手放す。他人のものは force と理由が要る。 */
export function runClaimRelease(
  dbPath: string | undefined,
  selfId: string | undefined,
  id: string | undefined,
  force: boolean,
  reason: string | undefined,
): RunResult {
  if (!selfId) return { code: EXIT_INVALID, err: '誰であるか確かめられぬ。HONDEN_AGENT_ID を置かれよ。' };
  const n = Number(id);
  if (!Number.isInteger(n)) return { code: EXIT_INVALID, err: `取り置きの番号が数でない: ${JSON.stringify(id)}` };
  const db = openStore({ path: dbPath });
  const r = releaseClaim(db, { id: n, by: selfId, force, reason });
  return r.ok ? { code: EXIT_OK, out: `  #${n} を手放した。` } : { code: EXIT_INVALID, err: r.message };
}

/** `honden peek <agent> --reason "…"` — 他の者の持ち場を覗く。理由が要る。 */
export function runPeek(
  dbPath: string | undefined,
  selfId: string | undefined,
  target: string | undefined,
  reason: string | undefined,
): RunResult {
  if (!target) {
    return {
      code: EXIT_INVALID,
      err: '誰の持ち場を覗くのか渡されよ。例: honden peek ashigaru1 --reason "同じ枝を触っておらぬか検める"',
    };
  }
  const db = openStore({ path: dbPath });
  const r = peek(db, selfId, target, reason);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/** `honden history <場所|枝>` — そこで何が起きたのかを辿る。 */
export function runHistory(
  dbPath: string | undefined,
  kind: string | undefined,
  value: string | undefined,
): RunResult {
  if (!value) {
    return {
      code: EXIT_INVALID,
      err: '辿る場所を渡されよ。例: honden history branch fix32-rebase',
    };
  }
  const db = openStore({ path: dbPath });
  const r = history(db, (kind ?? 'path') as Kind, value);
  return { code: EXIT_OK, out: r.out };
}

/** `honden projects sync --file <projects.yaml>` — 案件の所在を写す。 */
export function runProjectsSync(dbPath: string | undefined, file: string | undefined): RunResult {
  if (!file) {
    return { code: EXIT_INVALID, err: '--file に config/projects.yaml の在り処を渡されよ。' };
  }
  const db = openStore({ path: dbPath });
  try {
    const entries = readProjectsFromFile(file);
    tx(db, () => syncProjects(db, entries));
    const lines = entries.map((e) => {
      const root = workRootOf(db, e.id);
      return `  ${e.id}  →  ${root ? root.value : '（補わぬ: ' + (e.status === 'standby' ? '休眠中' : '所在が定まらぬ') + '）'}`;
    });
    return { code: EXIT_OK, out: `  ${entries.length} 件を写した。\n${lines.join('\n')}` };
  } catch (e) {
    if (e instanceof ProjectError) return { code: EXIT_INVALID, err: e.message };
    throw e;
  }
}

/** settings.yaml から隔離の構えを解く。settings 未登録なら none（今の状態）。 */
function isolationOf(db: Database): ReturnType<typeof parseIsolation> {
  const loaded = configLoad(db);
  if (!loaded.ok) return { ok: true, cfg: { level: 'none', outbound: false, tcpPorts: [] } };
  return parseIsolation(loaded.doc);
}

/** `honden isolate` — いまの構え。 */
export function runIsolateShow(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const r = isolationOf(db);
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  if (r.cfg.level === 'none') {
    return { code: EXIT_OK, out: '  隔離は none — 今の状態。settings.yaml の isolation: で入れられる（例は config/settings.yaml.example）。' };
  }
  const tools = requiredTools(r.cfg).map((t) => `${t}: ${Bun.which(t) ? '在る' : '**無い**'}`);
  return {
    code: EXIT_OK,
    out:
      `  段: ${r.cfg.level}  外: ${r.cfg.outbound ? '通す（母屋の口だけ塞ぐ）' : '切る'}\n` +
      `  道具: ${tools.join(' / ')}\n` +
      '  効き目は honden isolate check で測られよ（旗ではなく、中から何に届くかを見る）。',
  };
}

/**
 * `honden isolate wrap --cmd '<命>'` — 一体を起こす命を、構えどおりに包んで返す。
 *
 * 出陣（scripts/shutsujin.sh）がここを通る。**設定が壊れておる・道具が無い・
 * 包めぬ、のいずれも非 0 で止まる**——裸のまま起こして「隔離したつもり」を作らぬ。
 */
export function runIsolateWrap(dbPath: string | undefined, cmd: string | undefined, cli?: string): RunResult {
  if (!cmd) return { code: EXIT_INVALID, err: '--cmd に起こす命を渡されよ。' };
  const db = openStore({ path: dbPath });
  const r = isolationOf(db);
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  for (const t of requiredTools(r.cfg)) {
    if (!Bun.which(t)) {
      return { code: EXIT_INVALID, err: `  隔離に ${t} が要るが、道に無い。入れるか、isolation を外されよ。` };
    }
  }
  const cage = join(REPO_ROOT, 'bin', 'honden-cage');
  if (r.cfg.tcpPorts.length > 0 && !existsSync(cage)) {
    return { code: EXIT_INVALID, err: `  口の許し（tcp/<口>）には ${cage} が要る。bun run build:core で焼かれよ。` };
  }
  const w = wrapLaunch(r.cfg, cmd, cage, { ...(cli ? { cli } : {}) });
  return w.ok ? { code: EXIT_OK, out: w.cmd } : { code: EXIT_INVALID, err: `  ${w.message}` };
}

/**
 * `honden isolate check` — 効き目を測る。
 *
 * 測るのは「どの旗を渡したか」ではなく**「中から何に届くか」**である。
 * 母屋の口はこの検め自身が開き、閉じる。**陰性対照**（裸なら届く）を先に踏む
 * ——裸でも届かぬなら計器が死んでおり、「塞がっておる」は何の証にもならぬ。
 */
export async function runIsolateCheck(dbPath: string | undefined): Promise<RunResult> {
  const db = openStore({ path: dbPath });
  const r = isolationOf(db);
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  if (r.cfg.level === 'none') {
    return { code: EXIT_OK, out: '  隔離は none ゆえ、測る枷が無い。' };
  }
  for (const t of requiredTools(r.cfg)) {
    if (!Bun.which(t)) return { code: EXIT_INVALID, err: `  ${t} が道に無い。測る前に入れられよ。` };
  }

  // 母屋の口。開けっぱなしの常駐には頼らぬ——この検めが自分で開く
  const srv = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = srv.port;
  // 突き棒に単引用を使わぬ——包み（wrapLaunch）が単引用の命を拒むゆえ、
  // 検めの道具が己の枷に掛かる（実測で掛かった・2026-09-02）
  const probe = (host: string, p: number) =>
    `timeout 3 bash -c "exec 3<>/dev/tcp/${host}/${p}" 2>/dev/null && echo reach || echo blocked`;
  const runSh = (cmd: string): string => {
    const p = Bun.spawnSync(['bash', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });
    return new TextDecoder().decode(p.stdout).trim();
  };
  try {
    // 陰性対照: 裸なら母屋の口へ届く
    if (runSh(probe('127.0.0.1', port)) !== 'reach') {
      return { code: EXIT_SYSTEM, err: '  計器が死んでおる。裸でも母屋の口へ届かぬ——この検めの結果は何も語らぬ。' };
    }
    const cage = join(REPO_ROOT, 'bin', 'honden-cage');
    if (r.cfg.tcpPorts.length > 0 && !existsSync(cage)) {
      return { code: EXIT_INVALID, err: `  ${cage} が無い。bun run build:core で焼かれよ。` };
    }
    const wrapped = (inner: string) => {
      const w = wrapLaunch(r.cfg, inner, cage);
      if (!w.ok) throw new Error(w.message);
      return runSh(w.cmd);
    };
    const wantOut = r.cfg.outbound || r.cfg.tcpPorts.length > 0;
    const outPort = r.cfg.tcpPorts.length > 0 ? r.cfg.tcpPorts[0]! : 443;
    const host = wrapped(probe('127.0.0.1', port));
    const out = wantOut ? wrapped(probe('1.1.1.1', outPort)) : 'skip';
    const lines = [
      `  母屋の口 ${port}: 中から${host === 'blocked' ? '届かぬ' : '**届く**'}   ${host === 'blocked' ? 'OK' : 'NG'}`,
    ];
    let egressBad = false;
    if (wantOut) lines.push(`  外 1.1.1.1:${outPort}: 中から${out === 'reach' ? '届く' : '**届かぬ**'}   ${out === 'reach' ? 'OK' : 'NG'}`);
    else lines.push('  外: 構えが「切る」ゆえ測らぬ');
    if (r.cfg.tcpPorts.length > 0) {
      // egress の陰性対照。許した口が通るだけでは檻の証にならぬ——外しても通る
      let deny = 24;
      while (r.cfg.tcpPorts.includes(deny)) deny++;
      const shut = wrapped(probe('1.1.1.1', deny));
      lines.push(`  外 1.1.1.1:${deny}（許しておらぬ口）: 中から${shut === 'blocked' ? '届かぬ' : '**届く**'}   ${shut === 'blocked' ? 'OK' : 'NG'}`);
      egressBad = shut !== 'blocked';
    }
    if (wantOut) {
      // 名前引きの罠を先に言う。UDP/53 は檻の外だが、宛先が母屋の loopback だと
      // pasta の中では引けぬ（WSL は外向きゆえ効かぬが、別の機で踏む）
      try {
        const w = dnsWarning(readFileSync('/etc/resolv.conf', 'utf8'));
        if (w) lines.push(`  ▲ ${w}`);
      } catch { /* resolv.conf が無い土地では黙る */ }
    }
    const bad = host !== 'blocked' || (wantOut && out !== 'reach') || egressBad;
    lines.push(bad ? '  → 効いておらぬ。isolation の構えと道具を検められよ。' : '  → 構えどおりに効いておる。');
    return { code: bad ? EXIT_INVALID : EXIT_OK, out: lines.join('\n') };
  } finally {
    srv.stop(true);
  }
}

/** `honden projects` — いまの所在。`contextRoot` は試験で注ぎ替える。 */
export function runProjectsShow(dbPath: string | undefined, contextRoot: string = REPO_ROOT): RunResult {
  const db = openStore({ path: dbPath });
  const list = projectList(db);
  if (list.length === 0) {
    return { code: EXIT_OK, out: '  所在は空である。honden projects sync --file <projects.yaml> で写されよ。' };
  }
  const lines = list.map((e) => {
    const root = workRootOf(db, e.id);
    const head = `  ${e.id}${e.status ? ` [${e.status}]` : ''}\n      働く場所: ${root ? root.value : '（補わぬ）'}`;
    // 案件の覚書（context/<id>.md）。**引き継ぎの一枚**であり、設計書ではない。
    // 旧環境では同じ意図の書が 80KB に育ち、読むだけで足軽の文脈が尽きた。
    // 大きさを見せ、育ちすぎたら警める——定めだけでは止まらなかったゆえ。
    const note = join(contextRoot, 'context', `${e.id}.md`);
    if (existsSync(note)) {
      const kb = statSync(note).size / 1024;
      const warn = kb > 8 ? '  ▲ 育ちすぎておる。引き継ぎに要る行だけ残し、設計は案件の docs へ' : '';
      return `${head}\n      覚書: context/${e.id}.md（${kb.toFixed(1)} KB）${warn}`;
    }
    return head;
  });
  return { code: EXIT_OK, out: lines.join('\n') };
}

/**
 * `honden norms` — 規約の棚と、初稿の指示文へ入るもの。
 *
 * 空でも異常ではない。棚は空で出荷される。
 */
export function runNorms(dbPath: string | undefined, domain: string | undefined, root?: string): RunResult {
  const db = openStore({ path: dbPath });
  const dir = root ?? normsRoot(db);
  const all = readNorms(dir);
  const sel = select(all, domain);

  const lines = [`  棚: ${dir}/ssot/norms`];
  if (all.length === 0) {
    lines.push('  エントリは 1 行も無い。');
    lines.push('');
    lines.push('  棚は空で出荷される。借り物の規約は自分で焼いた規約と同じ枠を食うゆえ、');
    lines.push('  最初の 1 行は殿ご自身の却下から取り出したものであるべきである。');
    lines.push(`  cp ${dir}/ssot/norms/writing.md.example ${dir}/ssot/norms/writing.md`);
    return { code: EXIT_OK, out: lines.join('\n') };
  }

  lines.push(`  ${all.length} 行 —— うち初稿の指示文へ入るのは ${sel.chosen.length} 行`);
  lines.push('');
  lines.push(`  指示文へ入る（${PROMPT_TIERS.join(' / ')}）`);
  for (const n of sel.chosen) lines.push(`    [${n.domain}] ${n.text}  ← 出典: ${n.source}`);
  if (sel.chosen.length === 0) lines.push('    （無し）');

  if (sel.tooYoung.length > 0) {
    lines.push('');
    lines.push(`  棚に載るが指示文へは入らぬ（段が足りぬ）: ${sel.tooYoung.length} 行`);
    for (const n of sel.tooYoung) lines.push(`    [${n.tier}] ${n.text}`);
  }
  if (sel.unsourced.length > 0) {
    lines.push('');
    lines.push(`  段は足りておるが出典が無い: ${sel.unsourced.length} 行`);
    lines.push('    出典の無い行は後から誰も検算できぬ。指示文へは入れぬ。');
    for (const n of sel.unsourced) lines.push(`    [${n.tier}] ${n.text}`);
  }
  return { code: EXIT_OK, out: lines.join('\n') };
}

/** `honden norms root <path>` — 棚の在り処を決める。 */
export function runNormsRoot(dbPath: string | undefined, selfId: string | undefined, path: string | undefined): RunResult {
  if (!path) return { code: EXIT_INVALID, err: '棚の在り処を渡されよ。例: honden norms root /path/to/kagemusha' };
  const db = openStore({ path: dbPath });
  setSetting(db, 'norms_root', path, selfId);
  return { code: EXIT_OK, out: `  棚の在り処を ${path} にした。` };
}

/**
 * `honden lease renew` — 働いておる当人が期限を延ばす。
 *
 * 仕事が長引いた時、これを打たねば期限が切れる。切れても持ち場は解かれぬが、
 * 家老が引き継ぎを検討する材料になる。**当人しか延ばせぬ**——
 * 他人が延ばせると「まだ働いておる」の証にならぬ。
 */
export function runLeaseRenew(
  dbPath: string | undefined,
  selfId: string | undefined,
  minutes: string | undefined,
): RunResult {
  if (!selfId) return { code: EXIT_INVALID, err: '誰であるか確かめられぬ。HONDEN_AGENT_ID を置かれよ。' };
  const m = minutes === undefined ? DEFAULT_LEASE_MINUTES : Number(minutes);
  if (!Number.isFinite(m) || m <= 0) {
    return { code: EXIT_INVALID, err: `延ばす長さは正の数（分）で書かれよ: ${JSON.stringify(minutes)}` };
  }
  const db = openStore({ path: dbPath });
  const r = renew(db, { agent: selfId, holder: selfId, minutes: m });
  if (!r.ok) return { code: EXIT_INVALID, err: r.message };
  return { code: EXIT_OK, out: `  ${selfId} の貸与を ${r.lease?.leaseUntil} まで延ばした。` };
}

/** `honden cmd amend` — 途中で書き換える。知らせは同じ取引で飛ぶ。 */
export function runCmdAmend(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    const db = openStore({ path: dbPath });
    const id = typeof picked.value['cmd_id'] === 'string' ? picked.value['cmd_id'] : '';
    const w = id ? workersOn(db, id) : [];
    return {
      code: EXIT_OK,
      out:
        `  読み取り: ${Object.keys(picked.value).join(' / ')}\n` +
        `  知らせる先: karo${w.length > 0 ? ' / ' + w.map((x) => x.agent).join(' / ') : '（働いておる者は無し）'}\n` +
        '  → 書き込んでおらぬ (--dry-run)',
    };
  }
  const db = openStore({ path: dbPath });
  const r = amendCmd(db, selfId, picked.value);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/**
 * `honden patch` — ファイルへ差分を当てる。
 *
 * 文脈が在り、かつ一意である時だけ当てる。`str.replace` は当てはまる所を
 * 全部書き換えるが、こちらは曖昧なら断る。
 */
export function runPatch(
  dbPath: string | undefined,
  selfId: string | undefined,
  diff: string | undefined,
  root: string | undefined,
  dryRun: boolean,
): RunResult {
  if (!diff || diff.trim() === '') {
    return {
      code: EXIT_INVALID,
      err:
        '差分が無い。標準入力へ流されよ。\n' +
        "  honden patch < change.diff\n" +
        "  git diff | honden patch --dry-run",
    };
  }
  const r = patchFiles(diff, { root, dryRun });
  // 当てたなら跡を残す。honden 自身が提供する任意書き込みの道具ゆえ、
  // 誰がどこへ当てたかが残らねば、正本の外で何が起きたか辿れぬ
  // （権限表の突き合わせ 2026-08-28）。
  if (r.ok && !dryRun) {
    try {
      journal(openStore({ path: dbPath }), {
        actor: selfId ?? '名乗り無し',
        action: 'patch.apply',
        target: root ?? process.cwd(),
        detail: `差分 ${diff.length} 字`,
      });
    } catch {
      /* 跡を残せずとも当てた事実は変わらぬ */
    }
  }
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/**
 * `honden config get <鍵>` — 環境の設定を一つ引く。
 *
 * 値は飾らずに返す。shell が `$(honden config get …)` で受けるゆえ。
 */
export function runConfig(dbPath: string | undefined, key: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  if (key === undefined) {
    const doc = configLoad(db);
    if (!doc.ok) return { code: EXIT_INVALID, err: doc.message };
    const top = configDig(doc.doc, '');
    return {
      code: EXIT_OK,
      out:
        `  設定: ${doc.path}\n` +
        (top.kind === 'branch' ? `  上の段: ${top.keys.join(' / ')}` : '  中身が対応でない'),
    };
  }
  const r = configGet(db, key);
  return r.ok ? { code: EXIT_OK, out: r.value } : { code: EXIT_INVALID, err: r.message };
}

/** `honden decisions` — いま殿の裁定を待っておるもの。**開いておるものだけ。** */
export function runDecisions(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const list = openDecisions(db);
  if (list.length === 0) return { code: EXIT_OK, out: '  殿の裁定を待っておるものは無い。' };
  const lines: string[] = [];
  for (const d of list) {
    lines.push(`  #${d.id}  ${d.question}`);
    lines.push(`      上げた者: ${d.raisedBy}  ${d.at}${d.cmdId ? `  ${d.cmdId}` : ''}`);
    for (const c of d.choices) lines.push(`      - ${c}${c === d.fallback ? '  ← 既定' : ''}`);
    lines.push(d.fallback ? `      ${d.expiresAt} まで。過ぎれば既定へ倒れる。` : '      決まるまで止まる。');
  }
  lines.push('');
  lines.push('  honden decide <番号> "<選び>" [--note "…"]');
  return { code: EXIT_OK, out: lines.join('\n') };
}

/** `honden decision raise` — 裁定を仰ぐ。上役だけ。 */
export function runDecisionRaise(
  dbPath: string | undefined,
  selfId: string | undefined,
  src: InputSource,
  dryRun: boolean,
): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };
  if (dryRun) {
    return { code: EXIT_OK, out: `  読み取り: ${Object.keys(picked.value).join(' / ')}\n  → 書き込んでおらぬ (--dry-run)` };
  }
  const db = openStore({ path: dbPath });
  const r = raiseDecision(db, selfId, picked.value);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

/** `honden decide <番号> <選び>` — 一語で下ろす。 */
export function runDecide(
  dbPath: string | undefined,
  selfId: string | undefined,
  id: string | undefined,
  choice: string | undefined,
  note: string | undefined,
): RunResult {
  const n = Number(id);
  if (!Number.isInteger(n)) return { code: EXIT_INVALID, err: `裁定の番号が数でない: ${JSON.stringify(id)}` };
  if (!choice) return { code: EXIT_INVALID, err: '選びを渡されよ。honden decisions で選択肢が見られる。' };
  const db = openStore({ path: dbPath });
  const r = decideOne(db, selfId, n, choice, note);
  return r.ok ? { code: EXIT_OK, out: r.out } : { code: EXIT_INVALID, err: r.message };
}

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  const dryRun = flags['dry-run'] === 'true';
  delete flags['dry-run'];
  const dbPath = flags['db'];
  delete flags['db'];

  // 名乗りは環境から取る。引数では取らない。決め方は src/identity.ts。
  let _who: Identity | null = null;
  const who = (): Identity => {
    if (_who) return _who;
    // **他陣の pane は布陣の外と扱う。** 並走中は旧環境の pane も TMUX_PANE を
    // 持ち、@agent_id も引けてしまう——旧陣の将軍 pane が honden の shogun として
    // 通った（実測 2026-09-02）。印（@honden）の付いた陣に属さぬ pane からの
    // 呼び出しは、外の session と同じ（外部名で送れる・役職は名乗れぬ）。
    // 判ぜられぬ時（印の無い環境）は null が返り、従前どおり pane を信じる。
    const rawPane = process.env.TMUX_PANE?.trim();
    const foreign = rawPane ? paneInOwn(rawPane) === false : false;
    _who = resolveIdentity({
      tmuxPane: foreign ? undefined : process.env.TMUX_PANE,
      agentIdEnv: process.env.HONDEN_AGENT_ID,
      lookup: (pane) => {
        const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
        // 失敗を空文字にしてはならぬ。「引けなかった」と
        // 「pane に @agent_id が無い」は別物である（src/identity.ts）。
        return p.success ? new TextDecoder().decode(p.stdout) : null;
      },
      // 系譜を名乗りの根にする（殿の裁可 2026-08-29・Issue #7）。
      //
      // これが無いと `HONDEN_AGENT_ID=karo honden cmd done` が通った——
      // 環境変数一つで役職を騙れておった。系譜は kernel の持ち物ゆえ偽れぬ。
      //
      // 案じておった「核が pane の役職を継ぐ」は実測で杞憂であった
      // （watcher 三体とも @agent_id を持たぬ pane に住む）。
      // 費えは一回 3ms ほど（tmux list-panes 一度・/proc の系譜辿り）。
      //
      // **副作用**: pane の中から外部名（`--from probe_session`）を
      // 名乗る道が閉じる。外から名乗る用は tmux の外で行うこと。
      //
      // 同じ OS ユーザで走る限りこれは堀であって城壁ではない。真の隔離は
      // LXC か systemd container を要する（殿の見立て・その時に考える）。
      anchor: () => anchorFrom(realProbe()),
    });
    // 食い違いは黙って解かぬ。片方を静かに採ると、誤りが誤りのまま通る。
    if (_who.conflict) console.error(`  ※ 名乗りが食い違っておる。\n  ${_who.conflict}`);
    return _who;
  };
  const selfId = (): string | undefined => who().id;

  /**
   * 権を振るう副命令の前に、布陣の内から名乗っておるかを検める。
   *
   * 役職の名で権を振るうものだけがここを通る。読む副命令は通さぬ
   * ——外から検めるのを妨げても得るものが無い。
   */
  const actingAs = (role: string): RunResult | null => {
    const r = mayActAs(who(), role);
    return r.ok ? null : { code: EXIT_INVALID, err: `  ${r.message}` };
  };


  /**
   * 標準入力を読む。
   *
   * 旗が来ているときは読まない。端末でない環境（cron・別プロセスから呼ばれた
   * 場合など）では `process.stdin.isTTY` が false になるが、書き手が居なければ
   * EOF も来ないので、読みにいくと永久に待つ。2026-08-25 に実際に固まった。
   *
   * 代償として「旗と標準入力の両方が来た」場合を拾えなくなる。だが黙って
   * 固まるより、片方を無視するほうがましになる。旗が来ている時点で、
   * 撃った側の意図は旗にある。
   */
  const readStdin = async (): Promise<string | undefined> => {
    if (Object.keys(flags).length > 0) return undefined;
    if (process.stdin.isTTY) return undefined;
    return await Bun.stdin.text();
  };

  /**
   * どのコマンドの出力にも、呼び出し主の急ぎ未読を一行だけ横乗せする。
   * 急報（cmd_update = 範囲の増減など）の**全 CLI 共通の第一経路**。
   * reset で仕掛かりを捨てず、作業中の者へ届く（詳細は inbox.ts）。
   * inbox 系（見に行く行為そのもの）と nudge（末尾の JSON 行が芯への返事）には
   * 載せぬ。横乗せの失敗で本務を落とさぬ。
   */
  const ridealong = (): void => {
    if (rest[0] === 'inbox' || rest[0] === 'nudge' || rest.length === 0) return;
    try {
      const id = selfId();
      if (!id) return;
      const path = dbPath ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH;
      if (path !== ':memory:' && !existsSync(path)) return; // 正本を作ってまで見ぬ
      const line = urgentRideAlong(openStore({ path }), id);
      if (line) console.log(line);
    } catch {
      /* 横乗せは本務ではない */
    }
  };
  // 手引きは差配へ届く前に返す。
  //
  // **「どう使うか」を問うのに、使う資格を先に問うのは筋が違う。**
  // 以前は `--help` が検めや役の門に弾かれ、`brief --help` は指示書を丸ごと吐き、
  // `status --help` は SQLite ごと落ちた（2026-08-28 実測）。
  if (flags['help'] === 'true' || flags['h'] === 'true' || rest[0] === 'help') {
    const target = rest[0] === 'help' ? rest.slice(1) : rest;
    const h = helpFor(target);
    if (h) {
      const key = HELP_KEY(target);
      console.log(emphasize(renderHelp(key, h)));
      return EXIT_OK;
    }
    console.log(USAGE);
    if (target.length > 0) {
      console.log(`\n  「${target.join(' ')}」の手引きは無い。上の一覧から選ばれよ。`);
    }
    return EXIT_OK;
  }

  const emit = (r: RunResult): number => {
    // 出す直前に飾りを落とす。書く側は `**…**` で書いてよい——
    // 端末なら太字、パイプなら素の字になる（src/term.ts）。
    if (r.out) console.log(emphasize(r.out));
    if (r.err) console.error(emphasize(r.err));
    ridealong();
    return r.code;
  };

  if (rest[0] === 'import') {
    const root = flags['root'] ?? process.cwd();
    const subs = (flags['sub'] ?? DEFAULT_SUBDIRS.join(',')).split(',').filter(Boolean);
    delete flags['root'];
    delete flags['sub'];
    return emit(runImport(dbPath, root, subs, selfId()));
  }

  if (rest[0] === 'cmd' && rest[1] === 'new') {
    const stdin = await readStdin();
    return emit(actingAs(CMD_AUTHOR) ?? runCmdNew(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'norms') {
    if (rest[1] === 'root') return emit(runNormsRoot(dbPath, selfId(), rest[2]));
    const root = flags['root'];
    delete flags['root'];
    return emit(runNorms(dbPath, rest[1], root));
  }

  if (rest[0] === 'projects') {
    if (rest[1] === 'sync') {
      const f = flags['file'];
      delete flags['file'];
      return emit(runProjectsSync(dbPath, f));
    }
    return emit(runProjectsShow(dbPath));
  }

  if (rest[0] === 'say') {
    // 殿ご自身の task 一覧。**将軍が直に扱う唯一の器**（家老を通さぬ）。
    const sub = rest[1];

    if (sub === 'add') {
      // 旗でも EOF でも受ける（cmd new と同じ作法・src/cli.ts）。
      const said = await readStdin();
      const r = readingStore(() => {
        const db = openStore({ path: dbPath });
        const picked = pickInput({ flags, stdin: said });
        if (!picked.ok) return picked.message;
        const res = tx(db, () => sayAdd(db, picked.value, new Date()));
        if (!res.ok) return `  ${res.message}`;
        return `  ${res.item.id} を積んだ（${res.item.title}）。`;
      });
      return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
    }

    if (sub === 'done' || sub === 'status') {
      const id = rest[2];
      const to = (sub === 'done' ? 'done' : rest[3]) as SayStatus | undefined;
      if (!id || !to) {
        return emit({ code: EXIT_INVALID, err: 'honden say done <番号> / honden say status <番号> <状態>' });
      }
      if (!(SAY_STATUSES as readonly string[]).includes(to)) {
        return emit({ code: EXIT_INVALID, err: `状態は ${SAY_STATUSES.join('/')} のいずれか` });
      }
      const r = readingStore(() => {
        const db = openStore({ path: dbPath });
        const now = new Date();
        const res = tx(db, () => {
          const x = saySetStatus(db, id, to, now);
          // 済ませた日は連続に数える。**同じ日に二度は数えぬ**（src/saytask.ts）。
          if (x.ok && to === 'done') sayTouchStreak(db, now);
          return x;
        });
        return `  ${res.message}`;
      });
      return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
    }

    if (sub === 'show') {
      const id = rest[2];
      if (!id) return emit({ code: EXIT_INVALID, err: 'honden say show <番号>' });
      const r = readingStore(() => {
        const db = openStore({ path: dbPath, create: false });
        const i = sayGet(db, id);
        if (!i) return `  ${id} は無い。`;
        return JSON.stringify(i, null, 2);
      });
      return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
    }

    if (sub === 'import') {
      // 旧環境の saytask/tasks.yaml から移す。**何度打っても同じ**。
      const from = flags['from'] ?? '';
      if (!from) return emit({ code: EXIT_INVALID, err: '--from <tasks.yaml の道> を渡されよ' });
      const r = readingStore(() => {
        const db = openStore({ path: dbPath });
        const doc = Bun.YAML.parse(readFileSync(from, 'utf8')) as unknown;
        const items = Array.isArray(doc) ? doc : (doc as { tasks?: unknown })?.tasks;
        const res = tx(db, () => sayImport(db, items, new Date()));
        const lines = [`  ${res.added} 件を移し、${res.skipped} 件は既にあるゆえ飛ばした。`];
        for (const f of res.failed) lines.push(`  ▲ ${f.id}: ${f.why}`);
        return lines.join('\n');
      });
      return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
    }

    // 引数無しは一覧。
    const only = flags['status'] as SayStatus | undefined;
    if (only && !(SAY_STATUSES as readonly string[]).includes(only)) {
      return emit({ code: EXIT_INVALID, err: `状態は ${SAY_STATUSES.join('/')} のいずれか` });
    }
    const r = readingStore(() => {
      const db = openStore({ path: dbPath, create: false });
      return sayRender(sayList(db, only), sayStreak(db));
    });
    return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
  }

/**
 * 報せを組んで撃つ。`honden notify` と、芯が拾った時の両方から呼ぶ。
 *
 * **口を一つに保つ。** 出来事ごとに撃つ口を散らせば、新しい出来事を足すたびに
 * 撃ち忘れの筋が生まれる（殿の裁可 2026-08-30・「い」の道）。
 */
/**
 * `honden ntfy listen` — 携帯からの文を受け、将軍の inbox へ入れる。
 *
 * **止めるまで返らぬ。** 繋ぎが落ちれば待って張り直す。
 *
 * # 将軍を起こすか
 *
 * 起こさぬ。`mode.ts` が言うとおり、将軍へ合図を撃たぬのは将軍が偉い
 * からではなく、**殿がいま打ち込んでおる最中を潰すゆえ**である。
 * そして携帯から届いた文は、その判断を覆す証にはならぬ——殿が卓上に
 * 居られながら携帯から打たれることは有り得る。
 *
 * 代わりに正本を動かす。芯（honden-watch）が動きを拾い `honden nudge` を
 * 叩き、そこに報せが乗っておる。卓上に居られれば通知が出、
 * 席を外して自律へ移しておられれば合図が飛ぶ。**既にある二本の路で足り、
 * ここが三本目を生やす要は無い。**
 */
async function runNtfyListen(dbPath: string | undefined, once: boolean): Promise<RunResult> {
  const opened = readingStore(() => openStore({ path: dbPath, create: false }));
  if (!opened.ok) return opened.result;
  const db = opened.value;

  const cfg = configLoad(db);
  const c = cfg.ok ? ntfyConfig(cfg.doc, process.env) : null;
  if (!c) {
    return {
      code: EXIT_INVALID,
      out:
        '  ntfy の設定が無い。config/settings.yaml に notify.ntfy.topic を書かれよ。\n' +
        '  受け口も送り口も同じ設定を見る——別に書けば、いつか片方だけ動く。',
    };
  }
  const w = topicWarning(c.topic);
  if (w) console.error(`  ※ ${w}`);
  console.error(`  ${streamUrl(c.base, c.topic)} を聴いておる。止めるは Ctrl-C。`);

  let attempt = 0;
  for (;;) {
    const proc = Bun.spawn(listenArgs(c), { stdout: 'pipe', stderr: 'pipe' });
    let got = false;
    let buf = '';
    try {
      for await (const chunk of proc.stdout) {
        buf += new TextDecoder().decode(chunk);
        // **行の途中で切れる。** 最後の断片は次の塊まで持ち越す
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const m = parseLine(line);
          if (!m) continue;
          got = true;
          const r = tx(db, () => receive(db, m, new Date()));
          if (!r.stored) continue;
          inboxSignal(db); // 芯が拾い、報せと合図はそちらに乗る
          console.error(`  📱 受けた: ${m.text.slice(0, 60)}`);
          // 受けた旨を携帯へ返す。**返しは本務ではない**ゆえ躓いても続ける
          try {
            ntfySink(c).send({ title: '', body: r.ack ?? '', key: `ntfy:ack:${m.id}` });
          } catch {
            /* 返せずとも、受けた事実は正本に在る */
          }
          if (once) {
            proc.kill();
            return { code: EXIT_OK, out: '  一通受けて退いた。' };
          }
        }
      }
    } catch (e) {
      console.error(`  繋ぎが切れた: ${e instanceof Error ? e.message : String(e)}`);
    }
    // **一通でも受けておれば、待ちを一から数え直す。** 長く繋がっておった
    // 後の切断は、繋げぬ状態とは違う
    attempt = got ? 1 : attempt + 1;
    const wait = backoffMs(attempt);
    console.error(`  ${Math.round(wait / 1000)} 秒後に張り直す（${attempt} 度目）。`);
    await Bun.sleep(wait);
  }
}

/**
 * `honden review check` — レビュー指摘を、投入する前に検める。
 *
 * `/honden-review` の結果を task の review-findings へ入れる前に通す。
 * スキル自体は改めぬ（殿の下知 2026-08-31）ゆえ、後から走らせる別のスキルが
 * 己の指摘を構造へ書き写す——**その書き写しの誤りを、ここで機械が捕らえる**。
 *
 * 標準入力からも受ける（`-` か、道を渡さぬ時）。
 */
function runReviewCheck(file: string | undefined, expect: string | undefined): RunResult {
  let text: string;
  try {
    text = file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  } catch (e) {
    return { code: EXIT_INVALID, err: `  読めぬ: ${e instanceof Error ? e.message : String(e)}` };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { code: EXIT_INVALID, err: `  JSON として解けぬ: ${String(e).slice(0, 160)}` };
  }

  let want;
  if (expect !== undefined) {
    const t = parseTally(expect);
    if (!t.ok) return { code: EXIT_INVALID, err: `  ${t.message}` };
    want = t.tally;
  }

  const r = reviewCheck(doc, want);
  const out = renderReview(r, want);
  // **通らねば投入させぬ。** 終了コードで止める——人の目に頼らぬ
  return r.ok ? { code: EXIT_OK, out } : { code: EXIT_INVALID, err: out };
}

/** その道具は道に在るか。**名で判ぜず、実際に引けるかで見る。** */
function which(cmd: string): boolean {
  return Bun.spawnSync(['sh', '-c', `command -v ${cmd}`], { stdout: 'ignore', stderr: 'ignore' }).success;
}

/**
 * `honden update` — 出し物から本体を取り替える。
 *
 * **降ってきた物を、確かめてから置く。** 判断は `update.ts` に純粋な形で
 * 置いてある。ここは取りに行き、数を計り、置く役だけを負う。
 *
 * 置き方は `mv`。陣が立っておる間、芯は己の binary を掴んでおるゆえ
 * `cp` は `Text file busy` で倒れる。
 */
async function runUpdate(checkOnly: boolean, yes: boolean, skipSig: boolean): Promise<RunResult> {
  const plat = platformOf({ platform: process.platform, arch: process.arch });
  if (!plat) {
    return {
      code: EXIT_INVALID,
      err: `  ${process.platform}/${process.arch} 向けは配っておらぬ。手元で建てられよ（bun run build:all）。`,
    };
  }

  let tag: string | null = null;
  try {
    const r = await fetch(releaseApiUrl(), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `honden/${VERSION}` },
    });
    if (r.ok) tag = tagFrom(await r.json());
    else if (r.status !== 404) return { code: EXIT_SYSTEM, err: `  出し物を訊けなんだ（HTTP ${r.status}）。` };
  } catch (e) {
    return { code: EXIT_SYSTEM, err: `  出し物へ届かなんだ: ${e instanceof Error ? e.message : String(e)}` };
  }

  const d = decide(tag);
  if (d.kind === 'current') return { code: EXIT_OK, out: `  いまの版で最新である（${VERSION}）。` };
  if (d.kind === 'ahead')
    return { code: EXIT_OK, out: `  手元のほうが新しい（${VERSION} > ${d.latest}）。被せぬ。` };
  if (d.kind === 'unknown') return { code: EXIT_OK, out: `  ${d.message}` };

  const plan = planFor(d.tag, plat);
  if (checkOnly) {
    return {
      code: EXIT_OK,
      out: [`  ${plan.current} → ${plan.tag} が出ておる。`, ...plan.items.map((i) => `    ${i.asset}`),
        '  取り替えるには honden update --yes'].join('\n'),
    };
  }
  if (!yes) {
    return {
      code: EXIT_OK,
      out:
        `  ${plan.current} → ${plan.tag} が出ておる。取り替えるなら --yes を付けられよ。\n` +
        '  ※ 数（SHA256）は照らすが、**署名は無い**。守れるのは壊れと途中切れまでである。',
    };
  }

  // ── 取る。数の紙を先に取り、揃わぬなら一つも置かぬ ──
  const dir = join(REPO_ROOT, 'bin');
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    const r = await fetch(url, { headers: { 'User-Agent': `honden/${VERSION}` } });
    if (!r.ok) throw new Error(`${url} が ${r.status} を返した`);
    return new Uint8Array(await r.arrayBuffer());
  };

  // ── 署名を先に検める。**紙を縛れば、紙が縛る全部が縛られる** ──
  // 道具の名は環境で差し替えられる（試験のため。既定は素の cosign）
  const cosign = process.env['HONDEN_COSIGN'] ?? 'cosign';
  const hasCosign = which(cosign);
  // 版も見る。**束の形が版で変わる**ゆえ、在るだけでは足りぬ
  let cosignVer: string | null = null;
  if (hasCosign) {
    const vp = Bun.spawnSync([cosign, 'version', '--json'], { stdout: 'pipe', stderr: 'pipe' });
    cosignVer = parseCosignVersion(new TextDecoder().decode(vp.stdout));
    if (!cosignVer) {
      const v2 = Bun.spawnSync([cosign, 'version'], { stdout: 'pipe', stderr: 'pipe' });
      cosignVer = parseCosignVersion(new TextDecoder().decode(v2.stdout));
    }
  }
  const sig = signCheck({ hasCosign, skip: skipSig, version: cosignVer });
  if (sig.kind === 'refuse') return { code: EXIT_INVALID, err: `  ${sig.message}` };
  if (sig.kind === 'skip') console.error(`  ▲ ${sig.warning}`);

  let sums: Map<string, string>;
  const got: { asset: string; sha256: string; bytes: Uint8Array }[] = [];
  try {
    const sumsBytes = await fetchBytes(plan.sumsUrl);
    if (sig.kind === 'verify') {
      const tmpSums = join(tmpdir(), `honden-${SUMS}-${process.pid}`);
      const tmpBundle = join(tmpdir(), `honden-${BUNDLE}-${process.pid}`);
      try {
        writeFileSync(tmpSums, sumsBytes);
        writeFileSync(tmpBundle, await fetchBytes(assetUrl(plan.tag, BUNDLE)));
        const args = verifyArgs(tmpBundle, tmpSums);
        args[0] = cosign;
        const pr = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
        const v = readVerify({ ok: pr.success, stderr: new TextDecoder().decode(pr.stderr) });
        if (!v.ok) return { code: EXIT_SYSTEM, err: `  ${v.message}` };
        console.error('  ✓ 署名は我らの物である（Sigstore keyless）');
      } finally {
        for (const f of [tmpSums, tmpBundle]) {
          try {
            unlinkSync(f);
          } catch {
            /* 掃除で倒れても本題ではない */
          }
        }
      }
    }
    const parsed = parseSums(new TextDecoder().decode(sumsBytes));
    if (!parsed.ok) return { code: EXIT_SYSTEM, err: `  ${parsed.message}` };
    sums = parsed.sums;
    for (const it of plan.items) {
      const bytes = await fetchBytes(it.url);
      const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      got.push({ asset: it.asset, sha256, bytes });
    }
  } catch (e) {
    return { code: EXIT_SYSTEM, err: `  降ろせなんだ: ${e instanceof Error ? e.message : String(e)}` };
  }

  const v = verify(got.map(({ asset, sha256 }) => ({ asset, sha256 })), sums);
  if (!v.ok) return { code: EXIT_SYSTEM, err: `  ${v.message}` };

  // ── 置く。**全部書き出してから、まとめて名を差し替える** ──
  const staged: { tmp: string; dest: string }[] = [];
  try {
    for (let i = 0; i < plan.items.length; i++) {
      const tmp = join(dir, `.${plan.items[i]!.name}.new`);
      writeFileSync(tmp, got[i]!.bytes, { mode: 0o755 });
      staged.push({ tmp, dest: join(dir, plan.items[i]!.name) });
    }
    for (const s of staged) renameSync(s.tmp, s.dest);
  } catch (e) {
    for (const s of staged) {
      try {
        unlinkSync(s.tmp);
      } catch {
        /* 掃除で倒れても本題ではない */
      }
    }
    return { code: EXIT_SYSTEM, err: `  置けなんだ: ${e instanceof Error ? e.message : String(e)}` };
  }

  return {
    code: EXIT_OK,
    out:
      `  ${plan.tag} を置いた（${BINARIES.length} 本・${SUMS} と照合済み${sig.kind === 'verify' ? '・署名検証済み' : '・**署名は検めておらぬ**'}）。\n` +
      '  走っておる芯は古い実体を持ったままである。次に立つ時から新しくなる。',
  };
}

function sendNotices(
  dbPath: string | undefined,
  port: number,
  dryRun: boolean,
): { out: string; sent: number } {
  const db = openStore({ path: dbPath, create: false });
  const url = `http://${LOOPBACK}:${port}/`;
  const notices = [...notifyPending(db, url), ...streakNotice(db, url, new Date().toISOString().slice(0, 10))];
  if (notices.length === 0) return { out: '  報せる事は無い（裁可待ちは全て報せ済み）。', sent: 0 };

  const sinks: Sink[] = [desktopSink()];
  const warn: string[] = [];
  {
    // ntfy は**設定があれば**加わる。無ければ名乗り出ぬ——
    // 「配っておらぬ」と「配ったが届かなんだ」を混ぜぬため。
    const cfg = configLoad(db);
    const nc = cfg.ok ? ntfyConfig(cfg.doc, process.env) : null;
    if (nc) {
      const w = topicWarning(nc.topic);
      if (w) warn.push(`  ※ ${w}`);
      sinks.push(ntfySink(nc));
    }
  }

  if (dryRun) {
    return {
      sent: 0,
      out: [`  [dry-run] ${notices.length} 件を ${sinks.map((x) => x.name).join('+')} へ撃つ所まで来ておる:`]
        .concat(notices.map((n) => `    ${n.body}`))
        .concat(warn)
        .join('\n'),
    };
  }

  const res = notifyDispatch(db, notices, sinks);
  const lines = [`  ${res.sent} 件を撃った（送り口: ${sinks.map((x) => x.name).join('+')}）。`, ...warn];
  // **届かなんだ物は黙らせぬ。** 見張りの沈黙は健全に見えるゆえ。
  for (const f of res.failed) lines.push(`  ▲ ${f.sink} へ届かず（${f.key}）: ${f.detail ?? ''}`);
  return { out: lines.join('\n'), sent: res.sent };
}

/**
 * 合図の後に報せを撃つ。**合図が本務ゆえ、報せの躓きで合図を止めぬ。**
 *
 * 芯（core/watch）は正本が動くたびに `honden nudge` を叩く。ここに乗せれば
 * **口が一つで済み、撃ち漏らしも無い**（正本が動けば必ず通る）。
 *
 * 報せる事が無ければ SQL を数本引くだけで終わる——撃つ物がある時にしか
 * 外の道具（PowerShell / curl）は起きぬゆえ、常の費えは塵である。
 *
 * `notify.enabled: false` を設定に書けば黙る。煩わしければ切れる道を残す
 * ——切れねば、いずれ通知ごと無視されるようになる。
 */
function notifyAfterNudge(dbPath: string | undefined): void {
  try {
    const db = openStore({ path: dbPath, create: false });
    const cfg = configLoad(db);
    if (cfg.ok) {
      const on = (cfg.doc as { notify?: { enabled?: unknown } })?.notify?.enabled;
      if (on === false) return;
    }
    const r = sendNotices(dbPath, DASHBOARD_PORT, false);
    if (r.sent > 0) console.error(r.out);
  } catch {
    /* 報せは本務ではない。合図を止めぬ */
  }
}

  if (rest[0] === 'notify') {
    const port = Number(flags['port'] ?? DASHBOARD_PORT) || DASHBOARD_PORT;
    const r = readingStore(() => sendNotices(dbPath, port, dryRun).out);
    return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
  }

  if (rest[0] === 'ntfy' && rest[1] === 'listen') {
    return emit(await runNtfyListen(dbPath, flags['once'] !== undefined));
  }

  if (rest[0] === 'review' && rest[1] === 'check') {
    return emit(runReviewCheck(rest[2] ?? flags['file'], flags['expect']));
  }

  if (rest[0] === 'version') {
    // 仮の版なら、そう名乗る。**己が試し物であることを黙らせぬ**——
    // 出し物の口（/releases/latest）は仮の版を返さぬゆえ、ここで黙ると
    // 「更新は無い」と「そもそも降りてこぬ」の区別が付かなくなる。
    const mark = isPrerelease(VERSION) ? '（仮の版。honden update には降りてこぬ）' : '';
    return emit({ code: EXIT_OK, out: `honden ${VERSION}${mark}` });
  }

  if (rest[0] === 'update') {
    return emit(await runUpdate(flags['check'] !== undefined, flags['yes'] !== undefined, flags['insecure-skip-signature'] !== undefined));
  }

  if (rest[0] === 'paths') {
    // 芯まわりの道を shell へ渡す。二箇所で組めばいつか必ずずれる。
    const p = corePaths(dbPath ?? process.env.HONDEN_DB ?? DEFAULT_DB_PATH);
    if (rest[1] === 'signal') return emit({ code: EXIT_OK, out: p.signal });
    if (rest[1] === 'lock') return emit({ code: EXIT_OK, out: p.lock });
    if (rest[1] === 'db') return emit({ code: EXIT_OK, out: p.db });
    return emit({ code: EXIT_OK, out: `db=${p.db}\nsignal=${p.signal}\nlock=${p.lock}` });
  }

  if (rest[0] === 'guard') {
    if (rest[1] === 'check') return emit(runGuardCheck(flags['cmd']));
    if (rest[1] === 'hook' && rest[2] === 'cursor') return emit(await runGuardHookCursor(dbPath, selfId()));
    if (rest[1] === 'hook' && rest[2] === 'codex') return emit(await runGuardHookCodex(dbPath, selfId()));
    if (rest[1] === 'hook' && rest[2] === 'claude') return emit(await runGuardHookClaude(dbPath, selfId()));
    if (rest[1] === 'grant')
      return emit(
        actingAs('shogun') ??
          runGuardGrant(dbPath, selfId(), flags['cmd'], flags['agent'], flags['reason'], flags['ttl-min']),
      );
    if (rest[1] === 'charter')
      return emit(actingAs('shogun') ?? runGuardCharter(dbPath, selfId(), flags));
    if (rest[1] === 'charters') return emit(runGuardCharters(dbPath));
    if (rest[1] === 'charter-revoke')
      return emit(actingAs('shogun') ?? runGuardCharterRevoke(dbPath, selfId(), flags['id']));
    if (rest[1] === 'appeal') return emit(runGuardAppeal(dbPath, selfId(), flags['cmd'], flags['reason']));
    if (rest[1] === 'facts') return emit(runGuardFacts(dbPath, selfId(), flags['agent'], flags['cmd'], flags['reason']));
    if (rest[1] === 'denials') {
      const days = Number(flags['days'] ?? 7) || 7;
      const r = readingStore(() => {
        const db = openStore({ path: dbPath, create: false });
        const t = denialTally(denialCollect(db, new Date(), days));
        const lines = denialRender(t, days);
        // 詳しく見る口ゆえ、束ねた中身（誰が・どの形で）まで開く。
        for (const x of t) {
          lines.push('', `  ${x.rule} — ${x.note}`);
          lines.push(`    者: ${x.actors.join(', ') || 'なし'}`);
          lines.push(`    形: ${x.shapes.join(' / ') || 'なし'}`);
        }
        return lines.join('\n');
      });
      return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
    }
    if (rest[1] === 'selftest') return emit(runGuardSelftest(flags['root']));
    return emit({ code: EXIT_INVALID, err: 'guard check --cmd / guard hook cursor|codex|claude / guard grant / guard charter[s] / guard charter-revoke / guard appeal / guard facts / guard denials / guard selftest のいずれかである' });
  }

  if (rest[0] === 'backup') {
    const dir = flags['out'] ?? `${homedir()}/.honden/backups`;
    const keep = flags['keep'] ? Number(flags['keep']) : KEEP_DEFAULT;
    const db = openStore({ path: dbPath });
    const r = backupDb(db, dir, new Date(), keep);
    journal(db, { actor: selfId() ?? '名乗り無し', action: 'backup', target: r.path, detail: `${r.bytes} bytes` });
    return emit({
      code: EXIT_OK,
      out:
        `  写した: ${r.path}（${(r.bytes / 1024).toFixed(0)} KiB）` +
        (r.pruned.length > 0 ? `\n  古い写しを刈った: ${r.pruned.join(' / ')}` : ''),
    });
  }

  if (rest[0] === 'log') {
    // 台帳の閲覧口。**窓で切る**——台帳は追記のみで永遠に育つゆえ、
    // 全件を舐める口を作れば、旧環境で queue YAML の肥大が家老を殺した道を
    // 正本ごと辿ることになる。既定は直近 30 件・--before で窓を遡る。
    const lim = Math.min(Number(flags['limit'] ?? 30) || 30, 200);
    const before = flags['before'];
    const who = flags['actor'];
    const db = openStore({ path: dbPath });
    const conds: string[] = [];
    const args: (string | number)[] = [];
    if (before) { conds.push('at < ?'); args.push(before); }
    if (who) { conds.push('(actor = ? OR target = ?)'); args.push(who, who); }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db
      .query(`SELECT at, actor, action, target, detail FROM ledger ${where} ORDER BY at DESC LIMIT ?`)
      .all(...args, lim) as { at: string; actor: string; action: string; target: string | null; detail: string | null }[];
    if (rows.length === 0) return emit({ code: EXIT_OK, out: '  跡が無い。' });
    const lines = rows.reverse().map((r) => `  ${r.at.slice(0, 19)}  ${r.actor} → ${r.action}${r.target ? ` (${r.target})` : ''}`);
    const oldest = rows[0]!.at;
    return emit({
      code: EXIT_OK,
      out: lines.join('\n') + `\n\n  ${rows.length} 件（さらに遡るなら --before "${oldest}"）`,
    });
  }

  if (rest[0] === 'dashboard') {
    // 形式は旧 dashboard.md のまま（殿の指定・上流 L456-525 の節構成）。
    // --serve でブラウザ配信もする——旧 dashboard-viewer.py の後継。
    // 旧はファイル(dashboard.md)を読んで配っていたが、こちらは**正本から
    // 組んで直に配る**。中間生成物が消える（brief と同じ思想）。
    if (flags['serve'] === 'true') {
      const port = Number(flags['port'] ?? DASHBOARD_PORT) || DASHBOARD_PORT;
      // 配る前に一度読む。正本が無いまま窓を開けば、輪の中で倒れ続ける。
      const pre = readingStore(() => composeDashboard(dbPath));
      if (!pre.ok) return emit(pre.result);
      return serveDashboard(dbPath, port, flags['host']);
    }
    const r = readingStore(() => composeDashboard(dbPath));
    return emit(r.ok ? { code: EXIT_OK, out: r.value } : r.result);
  }

  if (rest[0] === 'export') {
    return emit(runExport(dbPath, selfId(), flags['out']));
  }

  if (rest[0] === 'status') {
    {
      const r = readingStore(() => runStatus(dbPath, flags['json'] === 'true'));
      return emit(r.ok ? r.value : r.result);
    }
  }

  if (rest[0] === 'brief') {
    return emit(runBrief(dbPath, selfId(), flags['role'], flags['cli'], flags['root']));
  }

  if (rest[0] === 'peek') {
    const reason = flags['reason'];
    delete flags['reason'];
    return emit(runPeek(dbPath, selfId(), rest[1], reason));
  }

  if (rest[0] === 'history') {
    const hasKind = rest[1] === 'path' || rest[1] === 'branch';
    return emit(runHistory(dbPath, hasKind ? rest[1] : 'path', hasKind ? rest[2] : rest[1]));
  }

  if (rest[0] === 'claim') {
    if (rest[1] === 'check') {
      // kind を省けば path。worktree の話が大半ゆえ。
      const hasKind = rest[2] === 'path' || rest[2] === 'branch';
      return emit(runClaimCheck(dbPath, hasKind ? rest[2] : 'path', hasKind ? rest[3] : rest[2], selfId()));
    }
    if (rest[1] === 'renew') {
      const m = flags['minutes'];
      delete flags['minutes'];
      return emit(runLeaseRenew(dbPath, selfId(), m));
    }
    if (rest[1] === 'release') {
      const force = flags['force'] === 'true';
      const reason = flags['reason'];
      delete flags['force'];
      delete flags['reason'];
      return emit(runClaimRelease(dbPath, selfId(), rest[2], force, reason));
    }
    return emit(runClaimList(dbPath, selfId()));
  }

  if (rest[0] === 'mode') {
    const until = flags['until'];
    delete flags['until'];
    return emit(runMode(dbPath, selfId(), rest[1], until));
  }

  if (rest[0] === 'nudge') {
    // 様態は正本から引く。--wake-shogun はこの一回だけの明示で、正本を動かさぬ。
    const wakeShogun = flags['wake-shogun'] === 'true';
    const reason = flags['reason'];
    delete flags['wake-shogun'];
    delete flags['reason'];
    const nudged = await runNudge(dbPath, dryRun, wakeShogun, reason, selfId());
    // 合図の後に報せを撃つ（殿の裁可 2026-08-30・「い」の道）。
    // 素振りでは撃たぬ——素振りが撃つのは重い（decisions.md 百五十五）。
    if (!dryRun) notifyAfterNudge(dbPath);
    return emit(nudged);
  }

  if (rest[0] === 'decisions') return emit(runDecisions(dbPath));

  if (rest[0] === 'decision' && rest[1] === 'raise') {
    const stdin = await readStdin();
    return emit(actingAs('karo') ?? actingAs('gunshi') ?? runDecisionRaise(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'decide') {
    const note = flags['note'];
    delete flags['note'];
    return emit(actingAs('shogun') ?? runDecide(dbPath, selfId(), rest[1], rest[2], note));
  }

  if (rest[0] === 'config') {
    if (rest[1] === 'get') return emit(runConfig(dbPath, rest[2] ?? ''));
    return emit(runConfig(dbPath, undefined));
  }

  if (rest[0] === 'patch') {
    const root = flags['root'];
    delete flags['root'];
    const stdin = await readStdin();
    return emit(runPatch(dbPath, selfId(), stdin, root, dryRun));
  }

  if (rest[0] === 'cmd' && rest[1] === 'amend') {
    const stdin = await readStdin();
    return emit(runCmdAmend(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'cmd' && rest[1] === 'done') {
    const input: Record<string, unknown> = { ...flags };
    if (rest[2] && !input['cmd_id']) input['cmd_id'] = rest[2];
    return emit(runCmdDone(dbPath, selfId(), input));
  }

  if (rest[0] === 'cmd' && rest[1] === 'list') return emit(runCmdList(dbPath, flags['all'] === 'true'));
  if (rest[0] === 'cmd' && rest[1] === 'show') {
    return emit(runCmdShow(dbPath, rest[2]));
  }

  if (rest[0] === 'report' && (rest[1] === 'submit' || rest[1] === undefined)) {
    const stdin = await readStdin();
    return emit(runReportSubmit(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'report' && rest[1] === 'qc') {
    const stdin = await readStdin();
    return emit(actingAs('gunshi') ?? runReportQc(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'task' && rest[1] === 'assign') {
    const stdin = await readStdin();
    return emit(actingAs(ASSIGNER) ?? actingAs('shogun') ?? runTaskAssign(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'lease') {
    if (rest[1] === 'release') {
      const force = flags['force'] === 'true'; const reason = flags['reason'];
      delete flags['force']; delete flags['reason'];
      return emit(runLeaseRelease(dbPath, selfId(), rest[2], force, reason));
    }
    return emit(runLeaseShow(dbPath, selfId()));
  }

  if (rest[0] === 'isolate') {
    if (rest[1] === 'wrap') { const c = flags['cmd']; const cl = flags['cli']; delete flags['cmd']; delete flags['cli']; return emit(runIsolateWrap(dbPath, c, cl)); }
    if (rest[1] === 'check') return emit(await runIsolateCheck(dbPath));
    return emit(runIsolateShow(dbPath));
  }

  if (rest[0] === 'roster') {
    if (rest[1] === 'set') return emit(runRosterSet(dbPath, dryRun ? { ...flags, 'dry-run': 'true' } : flags));
    if (rest[1] === 'sync') {
      const s = flags['settings'];
      delete flags['settings'];
      return emit(runRosterSync(dbPath, s));
    }
    return emit(runRosterShow(dbPath));
  }

  if (rest[0] === 'route') {
    const role = flags['role']; const providers = flags['providers']; const busy = flags['busy'];
    delete flags['role']; delete flags['providers']; delete flags['busy'];
    return emit(runRoute(dbPath, rest[1], role, providers, busy));
  }

  if (rest[0] === 'search') {
    const limit = Number(flags['limit'] ?? '20');
    delete flags['limit'];
    return emit(runSearch(dbPath, rest.slice(1).join(' '), Number.isFinite(limit) ? limit : 20));
  }

  if (rest[0] === 'inbox' && rest[1] === 'write') {
    const positional = fromPositional(rest.slice(2));
    if (positional && Object.keys(flags).length > 0) {
      console.error('並び順の引数と旗の両方が来ておる。どちらが効いたのか分からなくなるゆえ、片方にされよ。');
      return EXIT_INVALID;
    }
    if (rest.length > 2 && !positional) {
      console.error(
        `並び順で渡すなら 4 つ要る (受け取ったのは ${rest.length - 2} つ)。\n` +
          '  honden inbox write <宛先> <本文> <種別> <差出人>\n' +
          '  旗や EOF でも渡せる。書き込みは行っておらぬ。',
      );
      return EXIT_INVALID;
    }
    const stdin = await readStdin();
    // 名乗りの決め方は一箇所（src/identity.ts）。ここで別に書くと、
    // 片方だけ直る筋ができる。
    const me = who();
    return emit(
      inboxWrite(dbPath, { flags: positional ?? flags, stdin }, dryRun, {
        insideFormation: me.insideFormation,
        selfId: me.id,
      }),
    );
  }

  if (rest[0] === 'inbox' && rest[1] === 'unread') {
    return emit(inboxUnread(dbPath, rest[2] ?? selfId() ?? ''));
  }

  if (rest[0] === 'inbox' && rest[1] === 'read') {
    const target = flags['agent']; const all = flags['all'] === 'true';
    delete flags['agent']; delete flags['all'];
    return emit(runInboxRead(dbPath, selfId(), target, all));
  }

  if (rest[0] === 'inbox' && rest[1] === 'ack') {
    const all = flags['all'] === 'true';
    delete flags['all'];
    return emit(runInboxAck(dbPath, selfId(), rest.slice(2), all));
  }

  console.error(USAGE);
  return EXIT_INVALID;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
