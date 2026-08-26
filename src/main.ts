/**
 * honden の入口。
 *
 * 影の段では、shogun 側へは一切書かない。取り込みと検索だけを提供する。
 *
 * 書き戻し (正本 → queue/**.yaml) を入れると書き手が 2 人になる。honden が
 * 吐いたそばからエージェントが同じファイルへ書き、後から書いたほうが相手を潰す。
 * 切り替えの日を決めるまでは、影に徹するのが安全になる。
 */

import { openStore, search, tx, type Hit } from './store';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importTree, collectYaml, type ImportResult } from './import';
import { ingestAll } from './ingest';
import { list, summarize, nudgeText, ack, ackAll } from './inbox';
import { createCmd, assignTask } from './dispatch';
import { submitReport, submitQc, cmdDone, coverageOf, criteriaOf } from './report';
import { plan, send, record, forget, markSince } from './nudge';
import { getMode, setMode, describe as describeMode } from './mode';
import { live as liveClaims, conflicts as claimConflicts, explainConflict, release as releaseClaim, normalize as normClaim, type Kind } from './claim';
import { summarize as summarizeInbox } from './inbox';
import { roster as rosterOf } from './roster';
import { leaseState, expired, release } from './lease';
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
): RunResult {
  const db = openStore({ path: dbPath });
  const t0 = Bun.nanoseconds();
  let r: ImportResult;
  try {
    r = importTree(db, root, subdirs);
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
  });
  const w = entries.filter((e) => e.role === 'worker');
  return {
    code: EXIT_OK,
    out:
      `  ${entries.length} 人（上役 ${entries.length - w.length} / 足軽 ${w.length}）\n` +
      entries.map((e) => `    ${e.id.padEnd(10)} ${e.role.padEnd(9)} ${e.cli ?? ''} ${e.model ?? ''}`).join('\n') +
      `\n  能力制限 ${limits.filter((l) => l.maxBloom < 6).length} 件（表に無いモデルは制限なし）`,
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

/** `honden lease` — いまの持ち場と貸与。 */
export function runLeaseShow(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const rows = db
    .query('SELECT agent, task_id, status, holder, lease_until FROM task ORDER BY agent')
    .all() as { agent: string; task_id: string | null; status: string; holder: string | null; lease_until: string | null }[];
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
  return { code: EXIT_OK, out: `  ${r.id} を振った。task_assigned を届けた。` };
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
  if (msgs.length === 0) {
    return { code: EXIT_OK, out: `  ${agent}: ${all ? '一件も無い' : nudgeText(s)}` };
  }
  const peeking = target !== undefined && target !== selfId;
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
  honden claim                                         誰がどこを握っておるか
  honden claim check [path|branch] <場所>              そこが空いておるか
  honden claim release <番号> [--force --reason "…"]   手放す／譲らせる
  honden task assign … --bypass --reason "…"                 家老を通さぬ迂回（将軍だけ）
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
  honden lease release <agent> [--force --reason "…"]  手放す
  honden route <1-6> [--role worker] [--providers ...] 誰に振れるかを挙げる
  honden search <語> [--limit N]                       取り込んだものを引く
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
): Promise<RunResult> {
  const db = openStore({ path: dbPath });
  const now = new Date();

  // 未読が 0 から増えた者に、続き始めを刻む。
  // 刻む前に段を数えると、初回がいきなり段 1 の「経ち 0」でなく
  // 前回の残りから始まってしまう。
  const live: string[] = [];
  const quiet: string[] = [];
  for (const e of rosterOf(db)) {
    if (summarizeInbox(db, e.id).total > 0) {
      markSince(db, e.id, now);
      live.push(e.id);
    } else {
      quiet.push(e.id);
    }
  }
  // 片付いた者の覚えは消す。残すと、次の未読がいきなり段 3 から始まる。
  forget(db, quiet);

  const plans = plan(db, now, { wakeShogun });
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
      record(db, p, now, reason);
      lines.push(`${head} → 撃った: ${JSON.stringify(p.text)}${why}`);
    } else {
      lines.push(`${head} → 撃てぬ: ${r.err}`);
    }
  }

  // 芯への返事。人が読む行に混ざってよいが、必ず最後に置く。
  lines.push(JSON.stringify({ next_wake_ms: soonest }));
  return { code: EXIT_OK, out: lines.join('\n') };
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
export function runClaimList(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const held = liveClaims(db);
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
export function runClaimCheck(dbPath: string | undefined, kind: string | undefined, value: string | undefined): RunResult {
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
  return { code: EXIT_INVALID, err: explainConflict(k, normClaim(k, value), held) };
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

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  const dryRun = flags['dry-run'] === 'true';
  delete flags['dry-run'];
  const dbPath = flags['db'];
  delete flags['db'];

  // 名乗りは環境から取る。引数では取らない。
  let _self: string | undefined | null = null;
  const selfId = (): string | undefined => {
    if (_self !== null) return _self;
    const pane = process.env.TMUX_PANE ?? '';
    let id = process.env.HONDEN_AGENT_ID?.trim();
    if (!id && pane !== '') {
      const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
      const got = p.success ? new TextDecoder().decode(p.stdout).trim() : '';
      id = got === '' ? undefined : got;
    }
    _self = id;
    return id;
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

  const emit = (r: RunResult): number => {
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.code;
  };

  if (rest[0] === 'import') {
    const root = flags['root'] ?? process.cwd();
    const subs = (flags['sub'] ?? DEFAULT_SUBDIRS.join(',')).split(',').filter(Boolean);
    delete flags['root'];
    delete flags['sub'];
    return emit(runImport(dbPath, root, subs));
  }

  if (rest[0] === 'cmd' && rest[1] === 'new') {
    const stdin = await readStdin();
    return emit(runCmdNew(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'claim') {
    if (rest[1] === 'check') {
      // kind を省けば path。worktree の話が大半ゆえ。
      const hasKind = rest[2] === 'path' || rest[2] === 'branch';
      return emit(runClaimCheck(dbPath, hasKind ? rest[2] : 'path', hasKind ? rest[3] : rest[2]));
    }
    if (rest[1] === 'release') {
      const force = flags['force'] === 'true';
      const reason = flags['reason'];
      delete flags['force'];
      delete flags['reason'];
      return emit(runClaimRelease(dbPath, selfId(), rest[2], force, reason));
    }
    return emit(runClaimList(dbPath));
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
    return emit(await runNudge(dbPath, dryRun, wakeShogun, reason));
  }

  if (rest[0] === 'cmd' && rest[1] === 'done') {
    const input: Record<string, unknown> = { ...flags };
    if (rest[2] && !input['cmd_id']) input['cmd_id'] = rest[2];
    return emit(runCmdDone(dbPath, selfId(), input));
  }

  if (rest[0] === 'cmd' && rest[1] === 'show') {
    return emit(runCmdShow(dbPath, rest[2]));
  }

  if (rest[0] === 'report' && (rest[1] === 'submit' || rest[1] === undefined)) {
    const stdin = await readStdin();
    return emit(runReportSubmit(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'report' && rest[1] === 'qc') {
    const stdin = await readStdin();
    return emit(runReportQc(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'task' && rest[1] === 'assign') {
    const stdin = await readStdin();
    return emit(runTaskAssign(dbPath, selfId(), { flags, stdin }, dryRun));
  }

  if (rest[0] === 'lease') {
    if (rest[1] === 'release') {
      const force = flags['force'] === 'true'; const reason = flags['reason'];
      delete flags['force']; delete flags['reason'];
      return emit(runLeaseRelease(dbPath, selfId(), rest[2], force, reason));
    }
    return emit(runLeaseShow(dbPath));
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
    const pane = process.env.TMUX_PANE ?? '';
    const insideFormation = pane !== '';
    // 名乗りは環境から取る。引数の from とは突き合わせるだけで、信じない。
    // skills/external-to-shogun の Step 0 と同じ。TMUX_PANE が空のまま
    // tmux display-message を打つと、アクティブな他人の @agent_id を返す。
    let selfId = process.env.HONDEN_AGENT_ID?.trim();
    if (!selfId && insideFormation) {
      const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
      const got = p.success ? new TextDecoder().decode(p.stdout).trim() : '';
      selfId = got === '' ? undefined : got;
    }
    return emit(
      inboxWrite(dbPath, { flags: positional ?? flags, stdin }, dryRun, { insideFormation, selfId }),
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
