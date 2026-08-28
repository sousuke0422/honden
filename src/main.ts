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
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
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
import { collect as collectStatus, render as renderStatus } from './status';
import { judge as guardJudge, issue as guardIssue, verify as guardVerify, normalize as guardNormalize, splitOtp as guardSplitOtp, facts as guardFacts, selftest as guardSelftest, OTP_DEFAULT_TTL_MS } from './guard';
import { deliver as inboxDeliver, signal as inboxSignal } from './inbox';
import { amendCmd, workersOn } from './amend';
import { patchFiles } from './patchfile';
import { raise as raiseDecision, decide as decideOne, open as openDecisions } from './decision';
import { get as configGet, load as configLoad, dig as configDig, SETTINGS_PATH_KEY } from './config';
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
  const v = guardJudge(guardSplitOtp(cmd).cmd);
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
  const { otp, cmd } = guardSplitOtp(input.command ?? '');
  const v = guardJudge(cmd);
  if (v.permission === 'allow') return { code: EXIT_OK, out: JSON.stringify({ permission: 'allow' }) };

  if (otp && v.appealable) {
    const db = openStore({ path: dbPath });
    const agent = selfId ?? '名乗り無し';
    const r = guardVerify(db, otp, cmd, agent, new Date());
    if (r.ok) {
      return { code: EXIT_OK, out: JSON.stringify({ permission: 'allow', agent_message: `guard: ${r.message}` }) };
    }
    return {
      code: EXIT_OK,
      out: JSON.stringify({
        permission: 'deny',
        user_message: `guard ${v.rule}: 手形不備 — ${r.message}`,
        agent_message: `guard: ${v.rule} を止めた上、手形も通らぬ（${r.message}）。改めて直訴せよ。`,
      }),
    };
  }

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

  const { otp, cmd } = guardSplitOtp(input.tool_input?.command ?? '');
  const v = guardJudge(cmd);
  if (v.permission === 'allow') return { code: EXIT_OK, out: '' }; // 何も言わぬのが allow

  if (otp && v.appealable) {
    const db = openStore({ path: dbPath });
    const r = guardVerify(db, otp, cmd, selfId ?? '名乗り無し', new Date());
    if (r.ok) return { code: EXIT_OK, out: '' };
    return deny(`guard ${v.rule}: 手形が通らぬ（${r.message}）。改めて直訴せよ。`);
  }

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
  const db = openStore({ path: dbPath });
  const rows = collectStatus(db);
  if (rows.length === 0) return { code: EXIT_OK, out: '  名簿が空である。honden roster sync を先に。' };
  if (json) return { code: EXIT_OK, out: JSON.stringify(rows, null, 2) };
  const absent = rows.filter((r) => r.pane === null).length;
  const urgent = rows.filter((r) => r.urgent).length;
  const tail: string[] = [];
  if (absent > 0) tail.push(`${absent} 名が布陣に居らぬ`);
  if (urgent > 0) tail.push(`${urgent} 名に急ぎの未読`);
  return {
    code: EXIT_OK,
    out: renderStatus(rows) + (tail.length > 0 ? `\n\n  ${tail.join(' / ')}` : ''),
  };
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
  const v = guardJudge(cmd);
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

/** `honden projects` — いまの所在。 */
export function runProjectsShow(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const list = projectList(db);
  if (list.length === 0) {
    return { code: EXIT_OK, out: '  所在は空である。honden projects sync --file <projects.yaml> で写されよ。' };
  }
  const lines = list.map((e) => {
    const root = workRootOf(db, e.id);
    return `  ${e.id}${e.status ? ` [${e.status}]` : ''}\n      働く場所: ${root ? root.value : '（補わぬ）'}`;
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
    _who = resolveIdentity({
      tmuxPane: process.env.TMUX_PANE,
      agentIdEnv: process.env.HONDEN_AGENT_ID,
      lookup: (pane) => {
        const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
        // 失敗を空文字にしてはならぬ。「引けなかった」と
        // 「pane に @agent_id が無い」は別物である（src/identity.ts）。
        return p.success ? new TextDecoder().decode(p.stdout) : null;
      },
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
    if (rest[1] === 'appeal') return emit(runGuardAppeal(dbPath, selfId(), flags['cmd'], flags['reason']));
    if (rest[1] === 'facts') return emit(runGuardFacts(dbPath, selfId(), flags['agent'], flags['cmd'], flags['reason']));
    if (rest[1] === 'selftest') return emit(runGuardSelftest(flags['root']));
    return emit({ code: EXIT_INVALID, err: 'guard check --cmd / guard hook cursor|codex|claude / guard grant / guard appeal / guard facts / guard selftest のいずれかである' });
  }

  if (rest[0] === 'status') {
    return emit(runStatus(dbPath, flags['json'] === 'true'));
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
    return emit(await runNudge(dbPath, dryRun, wakeShogun, reason, selfId()));
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

  if (rest[0] === 'roster') {
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
