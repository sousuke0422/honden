/**
 * 他の者の持ち場を覗く路と、何が起きたのかを検める路。
 *
 * ## 「読むな」は守れぬ決めだった
 *
 * 現行 instructions/ashigaru.md:168 は「他の足軽のファイルを絶対に読むな」。
 * 出所は cmd_020 の事故——足軽5号が足軽2号の仕事を**実行した**。
 *
 * だが禁じられたのは「読む」で、事故は「実行した」である。
 * 二つを一緒くたにしたので、**衝突に気づくために読む**という正しい筋まで
 * 塞がった。同じ指示書が「衝突の恐れがあれば伺え」と命じているのに、
 * 気づく手立てが無い。
 *
 * ここでは分ける。
 *
 *   読む   —— 旗と理由を添えれば通る。台帳に残る
 *   実行する —— 通らない。報告は自分が握る仕事のものしか書けず (src/report.ts)、
 *              振れるのは家老だけ (src/dispatch.ts)
 *
 * 実行の側が型で塞がっている以上、読むのを塞ぐ必要はない。
 *
 * ## 何が起きたのかを検める
 *
 * worktree を分けても、枝が同じになれば衝突する。detached HEAD で切れば
 * 枝の取り置きすら立たない。起きてしまった後に**何が起きたのか**を
 * 辿れねば、調整のしようがない。
 *
 * 台帳は追記専用なので、解かれた取り置きも残っている。そこから引く。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { normalize, overlaps, type Kind, type Claim } from './claim';
import { checkReason } from './validate';
import { leaseState } from './lease';

export interface PeerResult {
  ok: boolean;
  message?: string;
  out?: string;
}

/**
 * 他の者の持ち場を覗く。
 *
 * 理由が要る。**書かせるのは、後から「読んだだけか、手を出したか」を
 * 検めるため**であって、読ませぬためではない。
 */
export function peek(
  db: Database,
  selfId: string | undefined,
  target: string,
  reason: string | undefined,
  now: Date = new Date(),
): PeerResult {
  if (!selfId) {
    return { ok: false, message: '誰であるか確かめられぬ。HONDEN_AGENT_ID を置かれよ。' };
  }
  if (target === selfId) {
    return { ok: false, message: '自分の持ち場は honden task で見られる。旗は要らぬ。' };
  }
  const bad = checkReason(
    reason,
    'fix32-rebase へ押す前に、同じ枝を触っておる者が居らぬか検める',
    '他の者の持ち場を覗くの',
  );
  if (bad) {
    return {
      ok: false,
      message:
        `${bad}\n` +
        '  書かせるのは読むのを止めるためではなく、後から「読んだだけか、\n' +
        '  手を出したか」を検められるようにするため。\n' +
        '  覗いてよいが、手を出してはならぬ。',
    };
  }

  const t = db
    .query('SELECT agent, task_id, status, cmd_id, updated_at, raw, holder, lease_until FROM task WHERE agent = ?')
    .get(target) as
    | {
        agent: string;
        task_id: string | null;
        status: string;
        cmd_id: string | null;
        updated_at: string;
        raw: string;
        holder: string | null;
        lease_until: string | null;
      }
    | null;

  journal(db, {
    actor: selfId,
    action: 'task.peek',
    target,
    detail: `reason=${JSON.stringify(reason)}`,
  });

  if (!t || !t.task_id) {
    return { ok: true, out: `  ${target} は仕事を握っておらぬ。` };
  }

  const st = leaseState({ holder: t.holder, leaseUntil: t.lease_until }, now);
  const claims = (
    db
      .query(
        'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at FROM claim WHERE agent = ? AND released_at IS NULL',
      )
      .all(target) as Claim[]
  ).map((c) => `      [${c.kind}] ${c.value}`);

  let title = '';
  try {
    const raw = JSON.parse(t.raw) as { title?: unknown };
    if (typeof raw.title === 'string') title = raw.title;
  } catch {
    // raw が読めずとも、他の欄で用は足りる
  }

  return {
    ok: true,
    out: [
      `  ${target} の持ち場 —— 覗いておるだけである。手を出してはならぬ。`,
      `    仕事: ${t.task_id}${title ? ` （${title}）` : ''}`,
      `    司令: ${t.cmd_id ?? '不明'}`,
      `    様子: ${t.status} / 貸与 ${st}${t.lease_until ? ` (${t.lease_until} まで)` : ''}`,
      `    最後の動き: ${t.updated_at}`,
      claims.length > 0 ? `    握っておる場所:\n${claims.join('\n')}` : '    握っておる場所: なし',
      '',
      '  調整が要るなら家老へ回されよ。相手へ直に手を出すことはできぬ。',
    ].join('\n'),
  };
}

/**
 * その場所・枝で何が起きたのかを辿る。
 *
 * 生きた取り置きだけでなく、**解かれたものも出す**。
 * 衝突は往々にして「先に居た者が納めた後」に分かるので、
 * いま握っている者だけ見ても経緯が分からない。
 */
export function history(db: Database, kind: Kind, value: string): PeerResult {
  const want = { kind, value: normalize(kind, value) };

  const all = db
    .query(
      'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, released_at releasedAt FROM claim WHERE kind = ? ORDER BY id',
    )
    .all(kind) as (Claim & { releasedAt: string | null })[];
  const touched = all.filter((c) => overlaps(want, c));

  const lines = [`  ${want.value} を触った者`];
  if (touched.length === 0) {
    lines.push('    誰も取り置いておらぬ。');
    lines.push('');
    lines.push('  取り置きが無いのは「誰も触っておらぬ」ことではない。');
    lines.push('  --workspace / --branch を書かずに振れば、取り置きは立たぬ。');
    lines.push('  detached HEAD で切った worktree も、枝の取り置きを持たぬ。');
  } else {
    for (const c of touched) {
      const state = c.releasedAt ? `解いた ${c.releasedAt}` : '**いま握っておる**';
      lines.push(`    #${c.id} ${c.agent}  ${c.at} 〜  ${state}`);
      lines.push(`         ${c.value}  （${c.taskId ?? '仕事不明'} / ${c.cmdId ?? '司令不明'}）`);
    }
  }

  // 台帳は追記専用ゆえ、解かれた後も跡が残る。
  // 譲らせた跡 (claim.release.force) はここに出る。
  const led = db
    .query(
      "SELECT at, actor, action, detail FROM ledger WHERE action LIKE 'claim.%' AND target LIKE ? ORDER BY id",
    )
    .all(`%${want.value.split('/').pop() ?? want.value}%`) as {
    at: string;
    actor: string;
    action: string;
    detail: string;
  }[];
  if (led.length > 0) {
    lines.push('');
    lines.push('  台帳の跡');
    for (const l of led) lines.push(`    ${l.at} ${l.actor} ${l.action}  ${l.detail}`);
  }

  return { ok: true, out: lines.join('\n') };
}
