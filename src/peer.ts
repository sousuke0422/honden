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
 *
 * ## 覗いたら家老へ報せる
 *
 * 覗いた跡は台帳に残るが、**台帳は誰も読まない**。積むだけで判定に使わねば、
 * 集めたことを対処したと取り違える。調整できるのは家老だけなので、
 * 家老が知らねば調整は始まらない。
 *
 * はじめ「取り置きが重なった時だけ報せる」としたが、これは的を外していた。
 * **取り置きが重なる状態は、振る門がそもそも作らせない**（src/dispatch.ts）。
 * 危ういのは宣言されなかった側——`--branch` を書かずに振った、
 * detached HEAD で切った——で、そこには比べる取り置きが無い。
 *
 * ゆえに覗いたこと自体を報せる。足軽は遊びで覗かない。理由を必須にしてあるので、
 * **覗きには必ず「なぜ」が付いている**。それがそのまま家老への報せになる。
 *
 * 同じ相手の同じ仕事について二度は報せない。相手が次の仕事へ移れば改めて報せる。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { normalize, overlaps, type Kind, type Claim } from './claim';
import { deliver, signal } from './inbox';
import { ASSIGNER } from './dispatch';
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
        'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, source FROM claim WHERE agent = ? AND released_at IS NULL',
      )
      .all(target) as Claim[]
  ).map((c) => `      [${c.kind}] ${c.value}${c.source === 'inferred' ? ' （所在から補った見立て）' : ''}`);

  let title = '';
  try {
    const raw = JSON.parse(t.raw) as { title?: unknown };
    if (typeof raw.title === 'string') title = raw.title;
  } catch {
    // raw が読めずとも、他の欄で用は足りる
  }

  // 覗いたことを家老へ報せる。
  //
  // 覗いた者に「家老へ回せ」と促すだけでは現行と同じ——気づいた者が
  // 動くかどうかに委ねることになる。理由は必須ゆえ、報せには必ず
  // 「なぜ覗いたか」が載る。
  const hits = overlapBetween(db, selfId, target);
  const sent = reportCollision(db, {
    from: selfId,
    with: target,
    // 相手が次の仕事へ移れば改めて報せる
    key: t.task_id,
    detail:
      `${selfId} が ${target} の持ち場を検めた。\n` +
      `  理由: ${reason}\n` +
      `  ${target}: ${t.task_id}（${t.cmd_id ?? '司令不明'}・${t.status}）\n` +
      (hits.length > 0
        ? `  取り置きが ${hits.length} 件重なっておる: ${hits.map((h) => h.theirs.value).join(' / ')}\n`
        : '  取り置きの重なりは無い。宣言されておらぬ場所で重なっておる恐れがある。\n'),
    now,
  });
  const told = sent ? '\n  ※ 家老へ報せた。' : '\n  ※ 家老へは既に報せてある。';

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
      `  調整が要るなら家老へ回されよ。相手へ直に手を出すことはできぬ。${told}`,
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
      'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, source, released_at releasedAt FROM claim WHERE kind = ? ORDER BY id',
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
      lines.push(`    #${c.id} ${c.agent}  ${c.at} 〜  ${state}${c.source === 'inferred' ? '  （見立て）' : ''}`);
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


/**
 * 二人の間に、生きた取り置きの重なりがあるか。
 *
 * ## 常は空である
 *
 * 振る門 (src/dispatch.ts) が重なる取り置きを作らせないので、
 * 正しく回っている限りここは何も返さない。**返したなら、
 * その門を通らずに取り置きが入ったということ**で、上流が壊れている。
 *
 * 消さずに残すのは、壊れた時に黙って通り過ぎぬため。
 * 報せの中で「重なっておる場所」として名指しされる。
 */
export function overlapBetween(db: Database, a: string, b: string): { mine: Claim; theirs: Claim }[] {
  const q = (agent: string) =>
    db
      .query(
        'SELECT id, kind, value, agent, task_id taskId, cmd_id cmdId, at, source FROM claim WHERE agent = ? AND released_at IS NULL',
      )
      .all(agent) as Claim[];
  const mine = q(a);
  const theirs = q(b);
  const out: { mine: Claim; theirs: Claim }[] = [];
  for (const m of mine) for (const t of theirs) if (overlaps(m, t)) out.push({ mine: m, theirs: t });
  return out;
}

/**
 * 家老へ報せる。
 *
 * 同じ重なりを何度も報せない。**同じ取り置きが握られておる間は一度だけ。**
 * 相手が握り直せば `at` が変わるので、新しい重なりとして改めて報せる。
 */
export function reportCollision(
  db: Database,
  opts: { from: string; with: string; key: string | null; detail: string; now?: Date },
): boolean {
  const now = opts.now ?? new Date();
  const key = `${opts.from}|${opts.with}|${opts.key ?? '-'}`;
  const dup = db
    .query("SELECT id FROM ledger WHERE action = 'collision.report' AND detail LIKE ?")
    .get(`key=${key}%`) as { id: number } | null;
  if (dup) return false;

  const at = now.toISOString();
  deliver(db, {
    id: `msg_${Date.now().toString(36)}_col`,
    agent: ASSIGNER,
    at,
    type: 'report_received',
    sender: opts.from,
    body:
      `場所の重なりを疑う者がおる。調整を仰ぐ。\n\n` +
      `${opts.detail}\n` +
      `honden history で経緯を辿れる。譲らせるなら honden claim release <番号> --force --reason "…"。`,
  });
  journal(db, { actor: opts.from, action: 'collision.report', target: opts.with, detail: `key=${key}` });
  signal(db);
  return true;
}
