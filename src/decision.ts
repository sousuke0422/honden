/**
 * 殿の裁定を仰ぐもの。
 *
 * ## なぜ構造にするか
 *
 * 現行は dashboard.md の 🚨要対応 節へ散文で積む。実測 (2026-08-26):
 *
 *   352 項目のうち  未決 57 / 済んだまま残存 95 / 覚え書き 83 / 印なし 117
 *   節そのものが 2 つに増えていた
 *
 * **本物の決裁が 16% しかない。** 散文には状態が無いので、消すには判断が要り、
 * 誰も消さない。本物が、片付いた物と覚え書きに溺れる。
 *
 * 状態を持たせれば、絞り込みで消える。dashboard を手で書き換えるのをやめ、
 * 正本から出す——その一歩になる。
 *
 * ## 選択肢を並べさせる
 *
 * 自由文は決裁の問いではない。「どうしましょう」では、殿が読んで、考えて、
 * 文で答え、それを受けた側がまた読んで解する。**一語で再開できる形**にする。
 *
 * ## 決まらぬ時にどうなるかを、問う側が書く
 *
 * 現行の 🚨 は「無視したら何が起きるか」を言わない。だから積む側に痛みが無く、
 * 積むだけ積まれる。**止まるのか、既定へ倒れるのか**を書かせる。
 *
 * 既定があれば、殿が席を外しておられても回る（memory: 夜間自律運用契約）。
 * 無ければ止まる——それでよい場合もあるが、書いた上で選ばせる。
 */

import type { Database } from 'bun:sqlite';
import { tx, journal } from './store';
import { roleOf, roleOrNull } from './roster';
import { deliver, signal } from './inbox';
import { parseUntil } from './mode';

/** 裁定を仰げるのは上役。足軽は家老へ回す。 */
export const CAN_RAISE = 'commander';
/** 裁定を下ろせるのは将軍。殿の言葉を運ぶ役ゆえ。 */
export const DECIDER = 'shogun';

export interface Decision {
  id: number;
  cmdId: string | null;
  raisedBy: string;
  at: string;
  question: string;
  choices: string[];
  fallback: string | null;
  expiresAt: string | null;
  status: string;
  chose: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface Result {
  ok: boolean;
  id?: number;
  message?: string;
  out?: string;
}

function row2dec(r: Record<string, unknown>): Decision {
  return {
    id: Number(r['id']),
    cmdId: (r['cmd_id'] as string) ?? null,
    raisedBy: String(r['raised_by']),
    at: String(r['at']),
    question: String(r['question']),
    choices: JSON.parse(String(r['choices'])) as string[],
    fallback: (r['fallback'] as string) ?? null,
    expiresAt: (r['expires_at'] as string) ?? null,
    status: String(r['status']),
    chose: (r['chose'] as string) ?? null,
    decidedBy: (r['decided_by'] as string) ?? null,
    decidedAt: (r['decided_at'] as string) ?? null,
    note: (r['note'] as string) ?? null,
  };
}

/** 裁定を仰ぐ。 */
export function raise(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
  now: Date = new Date(),
): Result {
  if (!selfId) return { ok: false, message: '誰であるか確かめられぬ。' };
  if (roleOrNull(selfId) !== CAN_RAISE) {
    return {
      ok: false,
      message:
        `裁定を仰げるのは上役である（そなたは ${selfId}）。\n` +
        '  足軽は家老へ回されよ。家老が判ずるか、殿へ上げるかを決める。',
    };
  }

  const question = typeof input['question'] === 'string' ? input['question'].trim() : '';
  if (question === '') return { ok: false, message: '何を裁定いただくのかを書かれよ。' };

  const raw = input['choices'];
  if (!Array.isArray(raw) || raw.length < 2) {
    return {
      ok: false,
      message:
        '選択肢を 2 つ以上並べられよ。\n' +
        '  自由文は決裁の問いではない。「どうしましょう」では、殿が読んで考えて文で答え、\n' +
        '  受けた側がまた読んで解することになる。**一語で再開できる形**にされよ。',
    };
  }
  const choices = raw.map((c) => String(c).trim()).filter((c) => c !== '');
  if (new Set(choices).size !== choices.length) {
    return { ok: false, message: '同じ選択肢が二度ある。どちらを選んだか決まらぬ。' };
  }

  // 決まらぬ時にどうなるかを、問う側が書く。
  //
  // 現行の 🚨 は「無視したら何が起きるか」を言わない。だから積む側に痛みが無く、
  // 積むだけ積まれる（実測 352 項目のうち本物は 57）。
  const fallbackRaw = input['fallback'];
  let fallback: string | null = null;
  let expiresAt: string | null = null;
  if (fallbackRaw !== undefined && String(fallbackRaw).trim() !== '') {
    fallback = String(fallbackRaw).trim();
    if (!choices.includes(fallback)) {
      return { ok: false, message: `既定 ${JSON.stringify(fallback)} が選択肢の中に無い。` };
    }
    const until = typeof input['until'] === 'string' ? input['until'] : '';
    if (until.trim() === '') {
      return {
        ok: false,
        message:
          '既定を置くなら、いつ倒れるかも書かれよ（--until 08:00 / 6h / ISO）。\n' +
          '  期限の無い既定は、いつまでも殿を待つか、いつの間にか倒れるかのどちらかになる。',
      };
    }
    const d = parseUntil(until, now);
    if (!d) return { ok: false, message: `期限が読めぬ: ${JSON.stringify(until)}` };
    if (d.getTime() <= now.getTime()) return { ok: false, message: 'その期限は既に過ぎておる。' };
    expiresAt = d.toISOString();
  }

  const at = now.toISOString();
  let id = 0;
  tx(db, () => {
    db.prepare(
      `INSERT INTO decision(cmd_id, raised_by, at, question, choices, fallback, expires_at, status)
       VALUES (?,?,?,?,?,?,?,'open')`,
    ).run(
      typeof input['cmd_id'] === 'string' ? input['cmd_id'] : null,
      selfId,
      at,
      question,
      JSON.stringify(choices),
      fallback,
      expiresAt,
    );
    id = Number((db.query('SELECT last_insert_rowid() n').get() as { n: number }).n);

    deliver(db, {
      id: `msg_${Date.now().toString(36)}${Bun.hash(question + at).toString(36).slice(0, 4)}_d`,
      agent: DECIDER,
      at,
      type: 'report_received',
      sender: selfId,
      body:
        `裁定を仰ぐ（#${id}）。\n\n${question}\n\n` +
        choices.map((c) => `  - ${c}`).join('\n') +
        (fallback ? `\n\n  何も決まらねば ${expiresAt} に ${JSON.stringify(fallback)} へ倒れる。` : '\n\n  決まるまで止まる。'),
    });
    journal(db, {
      actor: selfId,
      action: 'decision.raise',
      target: `#${id}`,
      detail: `choices=${choices.length} fallback=${fallback ?? 'なし'} cmd=${input['cmd_id'] ?? 'なし'}`,
    });
  });
  signal(db);

  return {
    ok: true,
    id,
    out: [
      `  #${id} として上げた。`,
      ...choices.map((c) => `    - ${c}`),
      fallback ? `  何も決まらねば ${expiresAt} に「${fallback}」へ倒れる。` : '  決まるまで止まる。',
      `  ${DECIDER} の未読が 1 件増えた。`,
    ].join('\n'),
  };
}

/**
 * 期限の切れたものを、既定へ倒す。
 *
 * **倒れたことと、殿が決めたことを分ける。** 同じ `decided` にすると、
 * 後から「これは殿の判断か、時間切れか」が分からなくなる。
 */
export function sweep(db: Database, now: Date = new Date()): Decision[] {
  const due = (
    db.query("SELECT * FROM decision WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?").all(
      now.toISOString(),
    ) as Record<string, unknown>[]
  ).map(row2dec);
  const at = now.toISOString();
  for (const d of due) {
    // status を条件に入れる。二つのプロセスが同時に見た時、
    // 二度倒れて台帳が二重になるのを防ぐ。
    //
    // **一つのプロセスの試験では、この門へ届かない。** 上の SELECT が
    // open だけを拾うので、二度目の sweep はそもそも回らない。
    // 届くのは、SELECT と UPDATE の間に別のプロセスが割り込んだ時だけ。
    // 消さずに残すのは、その時に黙って二重に書かぬため。
    const changed = db
      .prepare("UPDATE decision SET status='expired', chose=?, decided_at=? WHERE id=? AND status='open'")
      .run(d.fallback, at, d.id);
    if (changed.changes === 0) continue; // 誰かが先に倒した／決めた

    // **倒れたことを、上げた者へ返す。**
    //
    // 返さねば、倒れは誰にも観測されぬ。上げた家老は「既定が発効した」ことを
    // 知る経路が無く、しかも倒れた瞬間 open の一覧から消える
    // （外部レビューで指摘・2026-08-27）。
    // 「書き換えれば必ず知らせが飛ぶ」という amend の原理と揃える。
    deliver(db, {
      id: `msg_${Date.now().toString(36)}${Bun.hash(String(d.id) + at).toString(36).slice(0, 4)}_de`,
      agent: d.raisedBy,
      at,
      type: 'cmd_update',
      sender: 'decision',
      body:
        `#${d.id} は期限が来て既定へ倒れた。\n\n問い: ${d.question}\n` +
        `採られた既定: ${d.fallback}\n期限: ${d.expiresAt}\n\n` +
        '  殿が決めたのではない。時間切れである。',
    });
    journal(db, {
      actor: 'decision',
      action: 'decision.expired',
      target: `#${d.id}`,
      detail: `既定へ倒れた: ${JSON.stringify(d.fallback)}`,
    });
  }
  if (due.length > 0) signal(db);
  return due;
}

/** いま殿の裁定を待っておるもの。**開いておるものだけ。** */
export function open(db: Database, now: Date = new Date()): Decision[] {
  sweep(db, now);
  return (db.query("SELECT * FROM decision WHERE status = 'open' ORDER BY id").all() as Record<string, unknown>[]).map(
    row2dec,
  );
}

/** 裁定を下ろす。一語で足りる。 */
export function decide(
  db: Database,
  selfId: string | undefined,
  id: number,
  choice: string,
  note: string | undefined,
  now: Date = new Date(),
): Result {
  if (selfId !== DECIDER) {
    return {
      ok: false,
      message: `裁定を下ろせるのは ${DECIDER} である（そなたは ${selfId ?? '名乗り無し'}）。`,
    };
  }
  const r = db.query('SELECT * FROM decision WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (!r) return { ok: false, message: `そのような裁定は無い: #${id}` };
  const d = row2dec(r);
  if (d.status !== 'open') {
    return {
      ok: false,
      message:
        `#${id} は既に ${d.status} である（${d.chose ?? '不明'}）。\n` +
        '  覆すなら新しく上げられよ。跡を書き換えると、いつ何が決まったのか辿れなくなる。',
    };
  }
  if (!d.choices.includes(choice)) {
    return {
      ok: false,
      message:
        `選択肢の外である: ${JSON.stringify(choice)}\n` +
        d.choices.map((c) => `    - ${c}`).join('\n') +
        '\n  どれでもないなら、新しく上げ直されよ。',
    };
  }

  const at = now.toISOString();
  tx(db, () => {
    // status を条件に入れる。sweep と競り合った時、倒れた上から決したと
    // 書けてしまうのを防ぐ。
    db.prepare(
      "UPDATE decision SET status='decided', chose=?, decided_by=?, decided_at=?, note=? WHERE id=? AND status='open'",
    ).run(
      choice,
      selfId,
      at,
      note ?? null,
      id,
    );
    // 上げた者へ返す。返さねば、決まったことが誰にも届かぬ。
    deliver(db, {
      id: `msg_${Date.now().toString(36)}${Bun.hash(String(id) + at).toString(36).slice(0, 4)}_dd`,
      agent: d.raisedBy,
      at,
      type: 'cmd_update',
      sender: selfId,
      body: `#${id} の裁定が下りた。\n\n問い: ${d.question}\n選び: ${choice}` + (note ? `\n言: ${note}` : ''),
    });
    journal(db, {
      actor: selfId,
      action: 'decision.decide',
      target: `#${id}`,
      detail: `chose=${JSON.stringify(choice)}${note ? ` note=${JSON.stringify(note)}` : ''}`,
    });
  });
  signal(db);
  return { ok: true, id, out: `  #${id} は「${choice}」と決した。${d.raisedBy} へ返した。` };
}
