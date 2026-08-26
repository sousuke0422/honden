/**
 * 司令を途中で書き換える。
 *
 * ## なぜ命令として置くか
 *
 * 現行はこれを散文で守っている——`instructions/shogun_at.md` の
 * 「cmd 修正後は必ず inbox_write で家老に通知せよ」。
 *
 * 守られねば、足軽が旧版の指示で動き続ける。実際に一巡無駄になっている
 * (memory: 完了 cmd は編集で届かない・2026-07-14)。
 * 将軍自身も cmd_713 を二度書き換え、家老へ別便で二度追送し、
 * 未読を三つ重ねた（2026-08-26）。**書き換えと知らせが別の操作だから起きる。**
 *
 * 一つの取引にまとめる。書き換えれば必ず知らせが飛ぶ。
 *
 * ## 誰に知らせるか
 *
 * 家老だけでは足りない。**その司令の下で働いておる者全員**に要る。
 * 家老が振った後なら、足軽は自分の task YAML を持っており、
 * 家老が知っただけでは足軽の手元は変わらない。
 *
 * ## 受け入れ条件を変えたら、古い証拠は数えない
 *
 * ここが最も静かに壊れる所。条件の文言が変わる前に集めた証拠は、
 * **変わった後の条件を覆っていない。** だが証拠は消さない——
 * 消すと、なぜ覆いが減ったのかが後から分からなくなる。
 *
 * 条件に「最後に変わった時刻」を持たせ、覆いを数える側で見る (src/report.ts)。
 *
 * ## 閉じた司令は書き換えない
 *
 * 閉じた後に条件を書き換えても、誰にも届かない。開け直すのが筋である。
 */

import type { Database } from 'bun:sqlite';
import { tx, journal } from './store';
import { checkReason } from './validate';
import { deliver, signal } from './inbox';
import { CMD_AUTHOR, ASSIGNER } from './dispatch';

export interface AmendResult {
  ok: boolean;
  message?: string;
  out?: string;
}

/** 書き換えられる欄。`status` はここでは触らせない（cmd done / reopen が持つ）。 */
export const AMENDABLE = ['north_star', 'purpose', 'command', 'project', 'priority', 'acceptance_criteria'] as const;

const COLUMN: Record<string, string> = {
  north_star: 'north_star',
  purpose: 'purpose',
  command: 'body',
  project: 'project',
  priority: 'priority',
};

/** その司令の下で働いておる者。 */
export function workersOn(db: Database, cmdId: string): { agent: string; taskId: string | null }[] {
  return db
    .query("SELECT agent, task_id taskId FROM task WHERE cmd_id = ? AND status != 'idle'")
    .all(cmdId) as { agent: string; taskId: string | null }[];
}

export function amendCmd(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
  now: Date = new Date(),
): AmendResult {
  if (selfId !== CMD_AUTHOR) {
    return {
      ok: false,
      message:
        `司令を書き換えられるのは ${CMD_AUTHOR} だけである（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  書いた者と書き換える者が違うと、いつ何が変わったのか辿れぬ。',
    };
  }
  const cmdId = typeof input['cmd_id'] === 'string' ? input['cmd_id'] : '';
  if (cmdId === '') return { ok: false, message: '--cmd_id を渡されよ。' };

  const cmd = db.query('SELECT * FROM cmd WHERE id = ?').get(cmdId) as Record<string, unknown> | null;
  if (!cmd) return { ok: false, message: `そのような司令は無い: ${cmdId}` };

  if (cmd['status'] === 'done' || cmd['status'] === 'cancelled') {
    return {
      ok: false,
      message:
        `${cmdId} は既に ${cmd['status']} である。閉じた司令を書き換えても誰にも届かぬ。\n` +
        '  やり直させるなら新しい司令を書かれよ。\n' +
        '  （2026-07-14、閉じた cmd の受け入れ条件を後から書き換えて足軽に届かず、\n' +
        '    一巡無駄になっておる）',
    };
  }

  // 理由は必須。何が変わったかは差分で分かるが、**なぜ変えたかは残さねば消える**。
  const bad = checkReason(
    typeof input['reason'] === 'string' ? input['reason'] : undefined,
    'skills 配下が whitelist gitignore であることを見落としておった',
    '書き換え',
  );
  if (bad) return { ok: false, message: `${bad}\n  書き込みは行っておらぬ。` };
  const reason = String(input['reason']).trim();

  const changes: { field: string; before: string; after: string }[] = [];
  const unknown = Object.keys(input).filter(
    (k) => k !== 'cmd_id' && k !== 'reason' && !(AMENDABLE as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `書き換えられぬ欄が混じっておる: ${unknown.join(' / ')}\n` +
        `  書き換えられるのは ${AMENDABLE.join(' / ')} である。\n` +
        '  status は cmd done が持つ。',
    };
  }

  // 素の欄
  for (const f of Object.keys(COLUMN)) {
    const v = input[f];
    if (v === undefined) continue;
    const before = String(cmd[COLUMN[f]!] ?? '');
    const after = String(v);
    if (before === after) continue;
    changes.push({ field: f, before, after });
  }

  // 受け入れ条件
  let critChanges: { idx: number; before: string | null; after: string | null }[] = [];
  if (input['acceptance_criteria'] !== undefined) {
    const list = input['acceptance_criteria'];
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: false, message: '受け入れ条件は空にできぬ。一覧で並べられよ。' };
    }
    const old = db
      .query('SELECT idx, text FROM cmd_acceptance WHERE cmd_id = ? ORDER BY idx')
      .all(cmdId) as { idx: number; text: string }[];
    const oldByIdx = new Map(old.map((o) => [o.idx, o.text]));
    for (let i = 0; i < list.length; i++) {
      const idx = i + 1;
      const after = String(list[i]);
      const before = oldByIdx.get(idx) ?? null;
      if (before !== after) critChanges.push({ idx, before, after });
      oldByIdx.delete(idx);
    }
    // 減った分
    for (const [idx, text] of oldByIdx) critChanges.push({ idx, before: text, after: null });
  }

  if (changes.length === 0 && critChanges.length === 0) {
    return { ok: false, message: '変わるものが無い。渡した値は今と同じである。' };
  }

  const at = now.toISOString();
  const workers = workersOn(db, cmdId);

  tx(db, () => {
    for (const c of changes) {
      db.prepare(`UPDATE cmd SET ${COLUMN[c.field]} = ? WHERE id = ?`).run(c.after, cmdId);
      db.prepare(
        'INSERT INTO cmd_revision(cmd_id, at, by, field, before, after, reason) VALUES (?,?,?,?,?,?,?)',
      ).run(cmdId, at, selfId, c.field, c.before, c.after, reason);
    }
    if (critChanges.length > 0) {
      for (const c of critChanges) {
        if (c.after === null) {
          db.run('DELETE FROM cmd_acceptance WHERE cmd_id = ? AND idx = ?', [cmdId, c.idx]);
        } else {
          db.prepare(
            `INSERT INTO cmd_acceptance(cmd_id, idx, text, changed_at) VALUES (?,?,?,?)
             ON CONFLICT(cmd_id, idx) DO UPDATE SET text = excluded.text, changed_at = excluded.changed_at`,
          ).run(cmdId, c.idx, c.after, at);
        }
        db.prepare(
          'INSERT INTO cmd_revision(cmd_id, at, by, field, before, after, reason) VALUES (?,?,?,?,?,?,?)',
        ).run(cmdId, at, selfId, `acceptance[${c.idx}]`, c.before, c.after, reason);
      }
    }

    // 知らせは書き換えと同じ取引の中で出す。別の操作にすると忘れられる。
    const body =
      `${cmdId} を書き換えた。\n理由: ${reason}\n\n` +
      changes.map((c) => `  ${c.field} が変わった`).join('\n') +
      (changes.length > 0 && critChanges.length > 0 ? '\n' : '') +
      critChanges
        .map((c) =>
          c.after === null
            ? `  受け入れ条件 ${c.idx} が消えた: ${c.before}`
            : c.before === null
              ? `  受け入れ条件 ${c.idx} が増えた: ${c.after}`
              : `  受け入れ条件 ${c.idx} が変わった\n    前: ${c.before}\n    後: ${c.after}`,
        )
        .join('\n') +
      (critChanges.length > 0
        ? '\n\n  条件が変わる前に集めた証拠は覆いに数えぬ。honden cmd show で確かめられよ。'
        : '') +
      '\n\n  honden cmd show ' + cmdId + ' でいまの姿が見られる。';

    for (const to of [ASSIGNER, ...workers.map((w) => w.agent)]) {
      deliver(db, {
        id: `msg_${Date.now().toString(36)}${Bun.hash(to + at).toString(36).slice(0, 4)}_am`,
        agent: to,
        at,
        type: 'cmd_update',
        sender: selfId,
        body,
      });
    }

    journal(db, {
      actor: selfId,
      action: 'cmd.amend',
      target: cmdId,
      detail:
        `欄=[${changes.map((c) => c.field).join(',')}] 条件=[${critChanges.map((c) => c.idx).join(',')}] ` +
        `知らせた先=[${[ASSIGNER, ...workers.map((w) => w.agent)].join(',')}] reason=${JSON.stringify(reason)}`,
    });
  });
  signal(db);

  const told = [ASSIGNER, ...workers.map((w) => w.agent)];
  return {
    ok: true,
    out: [
      `  ${cmdId} を書き換えた。`,
      ...changes.map((c) => `    ${c.field} を変えた`),
      ...critChanges.map((c) =>
        c.after === null ? `    条件 ${c.idx} を消した` : `    条件 ${c.idx} を ${c.before === null ? '足した' : '変えた'}`,
      ),
      `  知らせた先: ${told.join(' / ')}`,
      workers.length > 0
        ? `  ※ ${workers.length} 人が既にこの司令の下で働いておる。手元の仕事は変わらぬゆえ、読ませよ。`
        : '  まだ誰も振られておらぬ。',
      critChanges.length > 0 ? '  ※ 条件が変わる前に集めた証拠は、覆いに数えぬ。' : '',
    ]
      .filter((s) => s !== '')
      .join('\n'),
  };
}
