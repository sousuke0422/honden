/**
 * 報告の路と、受け入れ条件の門。
 *
 * ## 路は現行のまま
 *
 *   足軽 ──report_received──> 軍師 ──verdict──> 家老 ──dashboard──> 将軍
 *
 * 現行 (instructions/ashigaru.md F001) は「将軍へ直に報せるな、軍師へ回せ」を
 * 禁止事項の散文で持っている。ここでは宛先を引数から外した。撃つ先を選べない
 * ので、飛び越えようがない。
 *
 * 家老から将軍への inbox は現行どおり開けない (instructions/karo.md の
 * `to_shogun: false`)。殿の入力を割り込みで潰さぬための決まりで、
 * 将軍へは dashboard を通す。ゆえに `cmdDone` は台帳へ落とすだけで、
 * 将軍の inbox を鳴らさない。
 *
 * ## 変えたのは受け渡しだけ
 *
 * 現行は「報告 YAML を書く」と「inbox_write で軍師を起こす」が別の手順で、
 * 前者だけ済ませて後者を忘れると、報告は在るのに誰も知らない状態になる。
 * ここでは 1 つの取引にまとめた。報告が入れば必ず軍師の未読が増える。
 *
 * ## 門
 *
 * 現行の受け入れ条件の検めは、家老の指示書の
 * 「Don't: Mark cmd as done if any acceptance_criteria is unmet」という
 * 一行だけで、守っているかを確かめる者が居ない。
 *
 * 足軽の報告 YAML には既に acceptance_check: が並んでいるので、
 * 材料は揃っている。足りないのは、その並びと cmd の条件を突き合わせる所。
 * それを型にした。
 *
 *   - 条件は番号で引く。文言で照合すると、写し違いや言い換えで別物になる
 *   - `status: done` の報告だけが覆う義務を負う。blocked / failed は負わない
 *     (塞がれた仕事の証拠は出せない。出させると嘘が書かれる)
 *   - 門を通すには、全条件が覆われ、かつ軍師が是と言っていること
 */

import type { Database } from 'bun:sqlite';
import { tx, journal } from './store';
import { validate, explain, checkReason, type Schema } from './validate';
import { roster, roleOf } from './roster';
import { deliver, signal } from './inbox';
import { releaseAllOf } from './claim';

/** 足軽の報せ先。現行 F001 と同じ。 */
export const WORKER_REPORTS_TO = 'gunshi';
/** 品質を検めるのは軍師だけ。 */
export const QC_AUTHOR = 'gunshi';
/** 司令を閉じられるのは家老だけ。 */
export const CMD_CLOSER = 'karo';
/** 迂回できるのは将軍だけ。dispatch と同じ流儀。 */
export const BYPASSER = 'shogun';

export const REPORT_STATUS = ['done', 'failed', 'blocked'] as const;
export const VERDICTS = ['APPROVED', 'APPROVED_WITH_CONCERNS', 'CHANGES_REQUESTED', 'REJECTED'] as const;
/** 門を通せる判定。懸念つきは通す (現行の軍師 QC も通している)。 */
export const PASSING_VERDICTS = ['APPROVED', 'APPROVED_WITH_CONCERNS'] as const;

export interface ReportResult {
  ok: boolean;
  id?: number;
  message?: string;
  out?: string;
}

const REPORT_SCHEMA: Schema = {
  task_id: { required: true, about: 'いま握っておる仕事の番号' },
  status: { required: true, oneOf: REPORT_STATUS, about: 'done / failed / blocked' },
  summary: { required: true, about: '何をしたか。1〜数文' },
  notes: { about: '補足。無くともよい' },
  skill_candidate: { structured: true, about: '同じ型を三度繰り返したなら、その名' },
  acceptance: { structured: true, about: '条件番号ごとの証拠。done なら全条件が要る' },
};

/**
 * 証拠が証拠になっているか。
 *
 * 「済」「OK」だけを並べられると、覆ったかどうかが分からないまま門が開く。
 * checkReason と同じ考えで、形だけの通過を弾く。
 */
export function checkEvidence(idx: number, criterion: string, ev: unknown): string | null {
  if (typeof ev !== 'string') {
    return `条件 ${idx} の証拠が文字列でない: ${JSON.stringify(ev)}`;
  }
  const s = ev.trim();
  if (s === '') return `条件 ${idx}「${criterion}」の証拠が空である。`;
  if (/^(済|完了|ok|yes|done|pass|true|はい|〇|○|✓)$/i.test(s)) {
    return (
      `条件 ${idx}「${criterion}」の証拠が ${JSON.stringify(s)} だけである。\n` +
      '  何をどう確かめたのかを書かれよ（実行した命令、件数、commit、出力の一行など）。\n' +
      '  「済」は覆った証にならぬ。後から検める者が辿れぬゆえ。'
    );
  }
  if ([...s].length < 6) {
    return `条件 ${idx}「${criterion}」の証拠が短すぎる: ${JSON.stringify(s)}`;
  }
  return null;
}

export interface Criterion {
  idx: number;
  text: string;
}

export function criteriaOf(db: Database, cmdId: string): Criterion[] {
  return db
    .query('SELECT idx, text FROM cmd_acceptance WHERE cmd_id = ? ORDER BY idx')
    .all(cmdId) as Criterion[];
}

/**
 * 証拠の並びを番号つきへ均す。
 *
 * 2 つの書き方を受ける。どちらも同じ形へ落ちる。
 *
 *   acceptance:            # 番号を鍵にする。一部だけ覆う subtask 向き
 *     1: "cargo test → job 18 / service 195 / exit 0"
 *     3: "git log で push していないことを確認"
 *
 *   acceptance:            # 並び順。cmd の条件と同じ順に全件
 *     - "cargo test → …"
 *     - "…"
 */
export function normalizeAcceptance(
  input: unknown,
  criteria: Criterion[],
): { ok: true; map: Map<number, string> } | { ok: false; message: string } {
  const map = new Map<number, string>();
  if (input === undefined || input === null) return { ok: true, map };

  const n = criteria.length;
  const byIdx = new Map(criteria.map((c) => [c.idx, c.text]));

  if (Array.isArray(input)) {
    if (input.length > n) {
      return {
        ok: false,
        message:
          `証拠が ${input.length} 件あるが、この司令の条件は ${n} 件である。\n` +
          '  並びで渡すときは条件と同じ順・同じ数にされよ。一部だけなら番号を鍵にされたい。',
      };
    }
    for (let i = 0; i < input.length; i++) {
      const idx = i + 1;
      const bad = checkEvidence(idx, byIdx.get(idx) ?? '?', input[i]);
      if (bad) return { ok: false, message: bad };
      map.set(idx, String(input[i]).trim());
    }
    return { ok: true, map };
  }

  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const idx = Number(k);
      if (!Number.isInteger(idx)) {
        return {
          ok: false,
          message:
            `条件の鍵が番号でない: ${JSON.stringify(k)}\n` +
            '  cmd の受け入れ条件は 1 から順に番号がついておる。honden cmd show で見られよ。',
        };
      }
      if (!byIdx.has(idx)) {
        return {
          ok: false,
          message:
            `条件 ${idx} は無い。この司令の条件は 1 から ${n} まで。\n` +
            '  honden cmd show で番号と文言を確かめられよ。',
        };
      }
      const bad = checkEvidence(idx, byIdx.get(idx)!, v);
      if (bad) return { ok: false, message: bad };
      map.set(idx, String(v).trim());
    }
    return { ok: true, map };
  }

  return { ok: false, message: 'acceptance は番号を鍵にした対応か、条件と同じ順の並びで書かれよ。' };
}

function currentTask(db: Database, agent: string): { task_id: string | null; cmd_id: string | null } | null {
  return db.query('SELECT task_id, cmd_id FROM task WHERE agent = ?').get(agent) as
    | { task_id: string | null; cmd_id: string | null }
    | null;
}

/**
 * 足軽が報せる。
 *
 * 宛先は選べない。軍師へ行く。
 */
export function submitReport(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
): ReportResult {
  if (!selfId) {
    return {
      ok: false,
      message:
        '誰であるか確かめられぬ。HONDEN_AGENT_ID を置くか pane の @agent_id を設定されよ。\n' +
        '  名乗りを引数に任せると、他人の報告が書ける。書き込みは行っておらぬ。',
    };
  }
  const known = roster(db);
  if (!known.some((k) => k.id === selfId)) {
    return { ok: false, message: `${selfId} は名簿に無い。honden roster sync で入れられよ。` };
  }
  if (roleOf(selfId) !== 'worker' && selfId !== QC_AUTHOR) {
    return {
      ok: false,
      message:
        `${selfId} は上役である。報告を上げるのは足軽と軍師。\n` +
        '  家老は dashboard、将軍は司令。書き込みは行っておらぬ。',
    };
  }

  const problems = validate(REPORT_SCHEMA, input);
  if (problems.length > 0) return { ok: false, message: explain(problems) };

  const v = input as { task_id: string; status: string; summary: string; notes?: string; skill_candidate?: string };

  // 自分がいま握っている仕事以外の報告は書かせない。
  // 現行の「他の足軽のファイルを読み書きするな」を、番号の照合に置き換えたもの。
  const cur = currentTask(db, selfId);
  if (!cur || !cur.task_id) {
    return { ok: false, message: `${selfId} は仕事を握っておらぬ。振られておらぬ仕事の報告は書けぬ。` };
  }
  if (cur.task_id !== v.task_id) {
    return {
      ok: false,
      message:
        `${selfId} が握っておるのは ${cur.task_id} であって ${v.task_id} ではない。\n` +
        '  他の者の仕事の報告は書けぬ。書き込みは行っておらぬ。',
    };
  }
  const cmdId = cur.cmd_id;
  const criteria = cmdId ? criteriaOf(db, cmdId) : [];

  const norm = normalizeAcceptance(input['acceptance'], criteria);
  if (!norm.ok) return { ok: false, message: `${norm.message}\n  書き込みは行っておらぬ。` };

  // done を名乗るなら、条件を覆っていること。
  //
  // ここが門の一枚目になる。二枚目は cmdDone で、そちらは司令ぜんたいを見る。
  // 足軽 1 人が全条件を覆うとは限らない (subtask に割れている) ので、
  // ここでは「覆ったと言った分に証拠があるか」までを見て、
  // 全件そろったかどうかは家老の側で見る。
  if (v.status === 'done' && criteria.length > 0 && norm.map.size === 0) {
    return {
      ok: false,
      message:
        `done と報せるなら、覆った受け入れ条件を証拠つきで挙げられよ。\n` +
        `  ${cmdId} の条件:\n` +
        criteria.map((c) => `    ${c.idx}. ${c.text}`).join('\n') +
        '\n  一つも覆っておらぬなら status: blocked か failed が正しい。\n' +
        '  書き込みは行っておらぬ。',
    };
  }

  const at = new Date().toISOString();
  let id = 0;
  tx(db, () => {
    db.prepare(
      'INSERT INTO report(agent, task_id, created_at, verdict, cmd_id, raw) VALUES (?,?,?,NULL,?,?)',
    ).run(selfId, v.task_id, at, cmdId, JSON.stringify(input));
    id = Number((db.query('SELECT last_insert_rowid() n').get() as { n: number }).n);

    const ins = db.prepare('INSERT INTO report_acceptance(report_id, idx, evidence) VALUES (?,?,?)');
    for (const [idx, ev] of [...norm.map].sort((a, b) => a[0] - b[0])) ins.run(id, idx, ev);

    // 報告が入れば必ず軍師の未読が増える。書いたのに誰も知らぬ状態を作らない。
    deliver(db, {
      id: `msg_${Date.now().toString(36)}_r${id}`,
      agent: WORKER_REPORTS_TO,
      at,
      type: 'report_received',
      sender: selfId,
      body: `${selfId}、${v.task_id} を ${v.status} として報せる。品質の検めを仰ぐ。\n\n${v.summary}`,
    });
    // 納めたら場所を手放す。解かぬと、その worktree が永久に握られたままになり、
    // 次の仕事が振れなくなる。blocked は握ったまま——まだ仕掛かっておるゆえ。
    const freed = v.status === 'blocked' ? 0 : releaseAllOf(db, selfId, new Date(at));
    journal(db, {
      actor: selfId,
      action: `report.submit.${v.status}`,
      target: v.task_id,
      detail:
        `cmd=${cmdId ?? 'なし'} 覆った条件=[${[...norm.map.keys()].sort((a, b) => a - b).join(',')}]` +
        (freed > 0 ? ` 手放した場所=${freed}件` : ''),
    });
  });

  signal(db);

  const covered = [...norm.map.keys()].sort((a, b) => a - b);
  // 残りは司令ぜんたいで数える。自分の分だけを引くと、他の足軽が既に
  // 覆った条件まで「残り」に出て、二度手間を招く。
  const cov = cmdId ? coverageOf(db, cmdId) : null;
  const rest = cov ? cov.uncovered : criteria.filter((c) => !norm.map.has(c.idx));
  return {
    ok: true,
    id,
    out: [
      `  ${v.task_id} を ${v.status} として納めた（報告 #${id}）`,
      `  そなたが覆った条件: ${covered.length > 0 ? covered.join(', ') : 'なし'}`,
      `  ${cmdId ?? '司令'} ぜんたい: ${cov ? cov.covered.size : covered.length} / ${criteria.length} 件`,
      rest.length > 0
        ? `  まだ誰も覆っておらぬ: ${rest.map((c) => `${c.idx}. ${c.text}`).join(' / ')}`
        : '  全条件が覆われた。',
      `  ${WORKER_REPORTS_TO} の未読が 1 件増えた。`,
    ].join('\n'),
  };
}

const QC_SCHEMA: Schema = {
  // YAML で `report_id: 12` と書くと数として入る。旗で渡せば文字列で入る。
  // どちらも通す。形はこの下で自分で検める。
  report_id: { required: true, structured: true, about: '検める報告の番号' },
  verdict: { required: true, oneOf: VERDICTS, about: '是か非か' },
  summary: { required: true, about: '何をどう検めたか' },
  checks: { structured: true, about: '個々の検査。name と result(PASS/FAIL/WARNING)' },
};

/** 軍師が検める。結果は家老へ行く。 */
export function submitQc(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
): ReportResult {
  if (selfId !== QC_AUTHOR) {
    return {
      ok: false,
      message:
        `品質を検めるのは ${QC_AUTHOR} である（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  足軽が自分の仕事を自分で是とすることはできぬ。書き込みは行っておらぬ。',
    };
  }
  const problems = validate(QC_SCHEMA, input);
  if (problems.length > 0) return { ok: false, message: explain(problems) };

  const v = input as { report_id: unknown; verdict: string; summary: string; checks?: unknown };
  const rid = Number(typeof v.report_id === 'string' ? v.report_id.trim() : v.report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    return {
      ok: false,
      message:
        `報告の番号が数でない: ${JSON.stringify(v.report_id)}\n` +
        '  report submit の出力に「報告 #12」として出ておる。honden inbox read でも引ける。',
    };
  }
  const target = db.query('SELECT id, agent, task_id, cmd_id, verdict FROM report WHERE id = ?').get(rid) as
    | { id: number; agent: string; task_id: string | null; cmd_id: string | null; verdict: string | null }
    | null;
  if (!target) return { ok: false, message: `そのような報告は無い: #${rid}` };
  if (target.verdict !== null) {
    return { ok: false, message: `#${rid} は報告ではなく検めの記録である。検めを検めることはできぬ。` };
  }

  // 既に検めてあるものを二度検めない。二つの判定が残ると、門がどちらを見るか決まらない。
  const dup = db
    .query("SELECT id FROM report WHERE agent = ? AND task_id = ? AND verdict IS NOT NULL")
    .get(QC_AUTHOR, target.task_id) as { id: number } | null;
  if (dup) {
    return {
      ok: false,
      message:
        `${target.task_id} は既に検めてある（#${dup.id}）。\n` +
        '  やり直させるなら新しい仕事として振り直されよ（現行の Redo Protocol と同じ）。',
    };
  }

  const checks: { name: string; result: string; note?: string }[] = [];
  if (Array.isArray(input['checks'])) {
    for (const c of input['checks'] as unknown[]) {
      if (c === null || typeof c !== 'object') {
        return { ok: false, message: 'checks の各項は name と result を持つ対応で書かれよ。' };
      }
      const o = c as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'] : '';
      const result = typeof o['result'] === 'string' ? o['result'].toUpperCase() : '';
      if (name === '') return { ok: false, message: 'checks の name が空である。' };
      if (!['PASS', 'FAIL', 'WARNING'].includes(result)) {
        return {
          ok: false,
          message: `checks の result は PASS / FAIL / WARNING。受け取った値: ${JSON.stringify(o['result'])}`,
        };
      }
      checks.push({ name, result, note: typeof o['note'] === 'string' ? o['note'] : undefined });
    }
  }

  // FAIL を抱えたまま APPROVED は通さない。
  // 集めただけで判定に使わぬのは、検めていないのと変わらない。
  const failed = checks.filter((c) => c.result === 'FAIL');
  if (failed.length > 0 && (PASSING_VERDICTS as readonly string[]).includes(v.verdict)) {
    return {
      ok: false,
      message:
        `FAIL が ${failed.length} 件あるのに ${v.verdict} とはできぬ。\n` +
        failed.map((c) => `    FAIL: ${c.name}`).join('\n') +
        '\n  検査を判定へ結ばぬなら、検査を並べる意味が無い。\n' +
        '  CHANGES_REQUESTED か REJECTED にされよ。書き込みは行っておらぬ。',
    };
  }

  const at = new Date().toISOString();
  let id = 0;
  tx(db, () => {
    db.prepare(
      'INSERT INTO report(agent, task_id, created_at, verdict, cmd_id, raw) VALUES (?,?,?,?,?,?)',
    ).run(QC_AUTHOR, target.task_id, at, v.verdict, target.cmd_id, JSON.stringify(input));
    id = Number((db.query('SELECT last_insert_rowid() n').get() as { n: number }).n);
    const ins = db.prepare('INSERT INTO report_check(report_id, idx, name, result, note) VALUES (?,?,?,?,?)');
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i]!;
      ins.run(id, i + 1, c.name, c.result, c.note ?? null);
    }
    deliver(db, {
      id: `msg_${Date.now().toString(36)}_q${id}`,
      agent: CMD_CLOSER,
      at,
      type: 'report_received',
      sender: QC_AUTHOR,
      body: `${target.agent} の ${target.task_id} を検めた。判定 ${v.verdict}。\n\n${v.summary}`,
    });
    journal(db, {
      actor: QC_AUTHOR,
      action: 'report.qc',
      target: target.task_id ?? `#${rid}`,
      detail: `verdict=${v.verdict} cmd=${target.cmd_id ?? 'なし'} checks=${checks.length} fail=${failed.length}`,
    });
  });

  signal(db);

  return {
    ok: true,
    id,
    out: [
      `  ${target.task_id} を ${v.verdict} と検めた（検め #${id}）`,
      `  検査 ${checks.length} 件（FAIL ${failed.length} 件）`,
      `  ${CMD_CLOSER} の未読が 1 件増えた。`,
    ].join('\n'),
  };
}

export interface Coverage {
  criteria: Criterion[];
  /** 条件番号 → 証拠を出した報告 */
  covered: Map<number, { reportId: number; agent: string; evidence: string }>;
  uncovered: Criterion[];
  /** 是と出た検め。 */
  passing: { id: number; taskId: string | null; verdict: string }[];
  /** 検めを待っている報告。 */
  unreviewed: { id: number; agent: string; taskId: string | null }[];
}

/** 司令が受け入れ条件をどこまで覆っているか。 */
export function coverageOf(db: Database, cmdId: string): Coverage {
  const criteria = criteriaOf(db, cmdId);
  const rows = db
    .query(
      `SELECT ra.idx idx, ra.evidence evidence, r.id rid, r.agent agent
         FROM report_acceptance ra JOIN report r ON r.id = ra.report_id
        WHERE r.cmd_id = ? AND r.verdict IS NULL
          AND json_extract(r.raw, '$.status') = 'done'
        ORDER BY r.id`,
    )
    .all(cmdId) as { idx: number; evidence: string; rid: number; agent: string }[];

  const covered = new Map<number, { reportId: number; agent: string; evidence: string }>();
  for (const r of rows) covered.set(r.idx, { reportId: r.rid, agent: r.agent, evidence: r.evidence });

  const passing = db
    .query(
      `SELECT id, task_id taskId, verdict FROM report
        WHERE cmd_id = ? AND verdict IN (${PASSING_VERDICTS.map(() => '?').join(',')})
        ORDER BY id`,
    )
    .all(cmdId, ...PASSING_VERDICTS) as { id: number; taskId: string | null; verdict: string }[];

  const unreviewed = db
    .query(
      `SELECT r.id id, r.agent agent, r.task_id taskId FROM report r
        WHERE r.cmd_id = ? AND r.verdict IS NULL
          AND json_extract(r.raw, '$.status') = 'done'
          AND NOT EXISTS (SELECT 1 FROM report q WHERE q.cmd_id = r.cmd_id
                            AND q.task_id = r.task_id AND q.verdict IS NOT NULL)
        ORDER BY r.id`,
    )
    .all(cmdId) as { id: number; agent: string; taskId: string | null }[];

  return {
    criteria,
    covered,
    uncovered: criteria.filter((c) => !covered.has(c.idx)),
    passing,
    unreviewed,
  };
}

/**
 * 司令を閉じる。
 *
 * 全条件が証拠つきで覆われ、かつ軍師が是と言っていなければ通さない。
 * 現行の「未達の条件があるなら done にするな」を、散文から門にしたもの。
 *
 * 将軍の inbox は鳴らさない (現行 karo の `to_shogun: false`)。
 * 将軍へは dashboard を通す。
 */
export function cmdDone(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
): ReportResult {
  const wantsBypass = input['bypass'] === 'true' || input['bypass'] === true;
  if (selfId !== CMD_CLOSER && !wantsBypass) {
    return {
      ok: false,
      message:
        `司令を閉じられるのは ${CMD_CLOSER} である（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        `  常道が使えぬときは --bypass --reason "…" で通れる（${BYPASSER} のみ）。\n` +
        '  書き込みは行っておらぬ。',
    };
  }
  if (wantsBypass && selfId !== BYPASSER) {
    return { ok: false, message: `迂回できるのは ${BYPASSER} だけである（そなたは ${selfId ?? '名乗り無し'}）。` };
  }
  const cmdId = typeof input['cmd_id'] === 'string' ? input['cmd_id'] : '';
  if (cmdId === '') return { ok: false, message: '--cmd_id を渡されよ。' };

  const cmd = db.query('SELECT id, status FROM cmd WHERE id = ?').get(cmdId) as
    | { id: string; status: string }
    | null;
  if (!cmd) return { ok: false, message: `そのような司令は無い: ${cmdId}` };
  if (cmd.status === 'done') return { ok: false, message: `${cmdId} は既に閉じてある。` };

  const cov = coverageOf(db, cmdId);
  const blockers: string[] = [];
  if (cov.uncovered.length > 0) {
    blockers.push(
      `覆われておらぬ条件が ${cov.uncovered.length} 件ある:\n` +
        cov.uncovered.map((c) => `    ${c.idx}. ${c.text}`).join('\n'),
    );
  }
  if (cov.passing.length === 0) {
    blockers.push(
      `${QC_AUTHOR} の是が無い（${PASSING_VERDICTS.join(' か ')}）。\n` +
        (cov.unreviewed.length > 0
          ? `    検めを待っておる報告: ${cov.unreviewed.map((u) => `#${u.id} ${u.agent}/${u.taskId}`).join(', ')}`
          : '    検める対象の報告そのものが無い。'),
    );
  }

  if (blockers.length > 0 && !wantsBypass) {
    return {
      ok: false,
      message:
        `${cmdId} はまだ閉じられぬ。\n\n` +
        blockers.map((b) => `  ${b}`).join('\n\n') +
        `\n\n  受け入れ条件を満たさぬまま done にしてはならぬ（現行 instructions/karo.md）。\n` +
        `  どうしても閉じる要があるなら ${BYPASSER} が --bypass --reason "…" で通せる。跡は台帳に残る。\n` +
        '  書き込みは行っておらぬ。',
    };
  }
  if (wantsBypass) {
    const bad = checkReason(
      typeof input['reason'] === 'string' ? input['reason'] : undefined,
      '案件そのものが取り止めになり、残りの条件が意味を失った',
    );
    if (bad) return { ok: false, message: `${bad}\n  書き込みは行っておらぬ。` };
  }

  const at = new Date().toISOString();
  tx(db, () => {
    db.prepare("UPDATE cmd SET status = 'done', completed_at = ? WHERE id = ?").run(at, cmdId);
    journal(db, {
      actor: selfId!,
      action: wantsBypass && blockers.length > 0 ? 'cmd.done.bypass' : 'cmd.done',
      target: cmdId,
      detail:
        `条件 ${cov.covered.size}/${cov.criteria.length} 覆済 検め=[${cov.passing
          .map((p) => `#${p.id}:${p.verdict}`)
          .join(',')}]` +
        (wantsBypass && blockers.length > 0
          ? ` reason=${JSON.stringify(input['reason'])} 未達=[${cov.uncovered.map((c) => c.idx).join(',')}]`
          : ''),
    });
  });

  return {
    ok: true,
    out: [
      `  ${cmdId} を閉じた。`,
      `  条件 ${cov.covered.size}/${cov.criteria.length} 件が証拠つきで覆われておる。`,
      `  検め: ${cov.passing.map((p) => `#${p.id} ${p.verdict}`).join(', ') || 'なし'}`,
      wantsBypass && blockers.length > 0 ? '  ※ 迂回して閉じた。台帳に跡が残る。' : '',
      `  ${BYPASSER} へは dashboard を通されよ（inbox は開けておらぬ）。`,
    ]
      .filter((s) => s !== '')
      .join('\n'),
  };
}
