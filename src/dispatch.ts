/**
 * 司令を書き、持ち場へ振る。
 *
 * `instructions/shogun.md` と CLAUDE.md の指揮系統をそのまま写す。
 *
 *   殿 → 将軍 → 家老 → 足軽 / 軍師
 *
 * ## 指揮系統を型で守る
 *
 * CLAUDE.md は「Chain of command: Shogun → Karo → Ashigaru/Gunshi.
 * Never bypass Karo」と定めている。だがいまは文で書いてあるだけで、
 * 将軍が足軽へ直に振ることを止めるものが無い。
 *
 * 誰が何を書けるかを、ここで機械的に決める。
 *
 * ## 番号は自分で振らせない
 *
 * 2026-08-24、将軍が cmd_668 を二重に採番しかけた。行頭一致の grep で
 * 最新を数えたが、cmd_668 から 703 は 2 字下げで入れ子になっていて
 * 拾えなかった。既存の 36 件を上書きするところだった。
 *
 * 番号は正本が振る。人にも機械にも数えさせない。
 *
 * ## 迂回は名のある一本にする
 *
 * 家老が倒れれば誰も振れなくなる。指揮系統の縛りが、まさにその時に効いてしまう。
 * だから迂回の道は要る。だが名の無い抜け道は、いずれ常道になる。
 *
 * 四つを課す。
 *
 *   1. 明示（--bypass）。誤って通れない
 *   2. 理由が必須。空も、それらしいだけの短文も弾く
 *   3. 別の action として台帳に残す（task.assign.bypass）。数えられるように
 *   4. 迂回した時の相手の様子を併せて記録する
 *
 * 4 つ目が肝になる。後から「本当に家老は倒れていたか」を検められるし、
 * 迂回が増えれば「常道が壊れている」という報せになる。
 *
 * ## 受け入れ条件を空で通さない
 *
 * 2026-08-24、cmd_705 が「軍師レビューを通っている」という受け入れ条件を
 * 満たさぬまま done になった。条件が空の cmd は、何をもって完了とするかが
 * 誰にも分からない。空を弾く。
 */

import type { Database } from 'bun:sqlite';
import { journal, tx } from './store';
import { roster } from './roster';
import { acquire, leaseState, DEFAULT_LEASE_MINUTES } from './lease';
import { maxBloomOf } from './routing';
import { validate, explain, checkReason, type Schema } from './validate';

const PRIORITIES = ['high', 'medium', 'low'] as const;

/** 司令を書けるのは将軍だけ。 */
export const CMD_AUTHOR = 'shogun';
/** 持ち場へ振れるのは家老だけ。将軍が足軽へ直に振ってはならない。 */
export const ASSIGNER = 'karo';

const CMD_SCHEMA: Schema = {
  north_star: { required: true, about: 'この司令が事業目標をどう進めるか。1〜2 文' },
  purpose: { required: true, about: '何をもって完了とするか。1 文' },
  acceptance_criteria: { required: true, list: true, about: '検証できる条件を並べる。空は不可' },
  command: { required: true, about: '家老への指示本文' },
  project: { required: true, about: 'どの案件か' },
  priority: { oneOf: PRIORITIES, about: '既定は medium' },
};

export interface DispatchResult {
  ok: boolean;
  id?: string;
  message?: string;
}

/** 次の司令番号。正本が振る。 */
export function nextCmdId(db: Database): string {
  const r = db
    .query("SELECT id FROM cmd WHERE id GLOB 'cmd_[0-9]*' ORDER BY CAST(substr(id, 5) AS INTEGER) DESC LIMIT 1")
    .get() as { id: string } | null;
  const n = r ? Number(r.id.slice(4)) + 1 : 1;
  return `cmd_${n}`;
}

/**
 * 司令を書く。
 *
 * 番号は正本が振る。受け入れ条件が空なら弾く。
 */
export function createCmd(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
): DispatchResult {
  if (selfId !== CMD_AUTHOR) {
    return {
      ok: false,
      message:
        `司令を書けるのは ${CMD_AUTHOR} だけである（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  指揮系統は 将軍 → 家老 → 足軽 / 軍師。書き込みは行っておらぬ。',
    };
  }
  const problems = validate(CMD_SCHEMA, input);
  if (problems.length > 0) {
    return {
      ok: false,
      message: explain(problems, '受け入れ条件は「何をもって完了とするか」を検証できる形で並べられよ。'),
    };
  }

  const v = input as {
    north_star: string;
    purpose: string;
    acceptance_criteria: string[];
    command: string;
    project: string;
    priority?: string;
  };
  const at = new Date().toISOString();
  let id = '';
  tx(db, () => {
    id = nextCmdId(db);
    db.prepare(
      `INSERT INTO cmd(id, created_at, north_star, purpose, body, project, priority, status, raw)
       VALUES (?,?,?,?,?,?,?,'pending',?)`,
    ).run(
      id,
      at,
      v.north_star,
      v.purpose,
      v.command,
      v.project,
      v.priority ?? 'medium',
      JSON.stringify(input),
    );
    const ins = db.prepare('INSERT INTO cmd_acceptance(cmd_id, idx, text) VALUES (?,?,?)');
    // 番号は 1 から。人が読んで指す番号ゆえ、0 から数えると
    // 「条件 0」という言い方が要る。honden cmd show の並びと揃える。
    v.acceptance_criteria.forEach((text, i) => ins.run(id, i + 1, String(text)));
    journal(db, {
      actor: selfId,
      action: 'cmd.create',
      target: id,
      detail: `project=${v.project} 受入条件=${v.acceptance_criteria.length}件`,
    });
  });
  return { ok: true, id };
}

const ASSIGN_SCHEMA: Schema = {
  agent: { required: true, about: '振り先の持ち場' },
  cmd_id: { required: true, about: 'どの司令の下の仕事か' },
  title: { required: true, about: '何をする仕事か。1 行' },
  bloom: { about: 'L1 から L6。能力の足りぬ者へは振れぬ' },
  minutes: { about: '貸与の長さ（分）。既定 30' },
  bypass: { about: '家老を通さず将軍が直に振る。理由が要る' },
  reason: { about: '迂回の理由。何が起きて迂回するのかを書く' },
};

/**
 * 持ち場へ振る。
 *
 * 振れるのは家老だけ。生きた持ち主が居れば断る。
 * 難度が宣言されていれば、能力の足りぬ者へは振らない。
 */
export function assignTask(
  db: Database,
  selfId: string | undefined,
  input: Record<string, unknown>,
): DispatchResult {
  const wantsBypass = input['bypass'] === 'true' || input['bypass'] === true;
  if (selfId !== ASSIGNER && !wantsBypass) {
    return {
      ok: false,
      message:
        `持ち場へ振れるのは ${ASSIGNER} だけである（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  将軍が足軽へ直に振ってはならぬ（CLAUDE.md の指揮系統）。\n' +
        `  家老が倒れておるなど、常道が使えぬときは --bypass --reason "…" で通れる。\n` +
        '  書き込みは行っておらぬ。',
    };
  }
  if (wantsBypass) {
    if (selfId !== CMD_AUTHOR) {
      return {
        ok: false,
        message: `迂回できるのは ${CMD_AUTHOR} だけである（そなたは ${selfId ?? '名乗り無し'}）。`,
      };
    }
    const bad = checkReason(typeof input['reason'] === 'string' ? input['reason'] : undefined);
    if (bad) return { ok: false, message: `${bad}\n  書き込みは行っておらぬ。` };
  }
  // ここまで来た時点で selfId は ASSIGNER か CMD_AUTHOR のいずれか。
  const actor: string = selfId!;

  const known = roster(db);
  if (known.length === 0) return { ok: false, message: '名簿が空である。honden roster sync で入れられよ。' };

  const schema: Schema = { ...ASSIGN_SCHEMA, agent: { ...ASSIGN_SCHEMA['agent'], oneOf: known.map((k) => k.id) } };
  const problems = validate(schema, input);
  if (problems.length > 0) return { ok: false, message: explain(problems) };

  const v = input as { agent: string; cmd_id: string; title: string; bloom?: string; minutes?: string };

  const cmd = db.query('SELECT id, status FROM cmd WHERE id = ?').get(v.cmd_id) as
    | { id: string; status: string }
    | null;
  if (!cmd) {
    return {
      ok: false,
      message: `そのような司令は無い: ${v.cmd_id}\n  honden cmd new で先に書かれよ。書き込みは行っておらぬ。`,
    };
  }

  const entry = known.find((k) => k.id === v.agent)!;
  if (entry.role !== 'worker' && entry.id !== 'gunshi') {
    return {
      ok: false,
      message: `${v.agent} は上役である。仕事を振る先は足軽か軍師。書き込みは行っておらぬ。`,
    };
  }

  // 難度が宣言されていれば、能力の足りぬ者へは振らない。
  if (v.bloom !== undefined) {
    const bloom = Number(String(v.bloom).replace(/^[Ll]/, ''));
    if (!Number.isInteger(bloom) || bloom < 1 || bloom > 6) {
      return { ok: false, message: `難度は L1 から L6。受け取った値: ${JSON.stringify(v.bloom)}` };
    }
    const cap = entry.model ? maxBloomOf(db, entry.model) : 6;
    if (cap < bloom) {
      return {
        ok: false,
        message:
          `${v.agent} は ${entry.model} を載せており L${cap} までである（L${bloom} に足りぬ）。\n` +
          '  honden route <難度> --role worker で振り先を挙げられよ。\n' +
          '  切り替えれば足りる者も併せて出る。書き込みは行っておらぬ。',
      };
    }
  }

  // 貸与の持ち主は、振った家老ではなく働く足軽自身にする。
  // 「その持ち場が生きた仕事で埋まっているか」を表すものだからで、
  // 期限を延ばすのも働いている当人になる。
  //
  // 家老を持ち主にすると、家老が何度でも上書きできてしまう
  // （acquire は同じ持ち主の取り直しを許すため）。
  const cur = db.query('SELECT holder, lease_until, task_id FROM task WHERE agent = ?').get(v.agent) as
    | { holder: string | null; lease_until: string | null; task_id: string | null }
    | null;
  if (cur && leaseState({ holder: cur.holder, leaseUntil: cur.lease_until }, new Date()) === 'held') {
    return {
      ok: false,
      message:
        `${v.agent} は既に仕事を握っておる（${cur.task_id ?? '不明'}、${cur.lease_until} まで）。\n` +
        '  終わるのを待つか、手放させるか、別の者へ振られよ。\n' +
        '  honden route <難度> --role worker で空いておる者が分かる。書き込みは行っておらぬ。',
    };
  }

  // 時刻だけでは足りない。同じミリ秒に 2 件振ると同じ番号になり、
  // inbox の主キーが衝突して 2 件目の割り当てが丸ごと落ちる（試験で実際に出た）。
  const stamp = `${Date.now().toString(36)}${Bun.hash(`${v.agent}${v.title}${Math.random()}`).toString(36).slice(0, 4)}`;
  const taskId = `subtask_${v.cmd_id.replace(/^cmd_/, '')}_${stamp}`;
  const minutes = v.minutes ? Number(v.minutes) : DEFAULT_LEASE_MINUTES;
  let result: DispatchResult = { ok: false };
  tx(db, () => {
    const got = acquire(db, { agent: v.agent, taskId, holder: v.agent, minutes, force: true });
    if (!got.ok) {
      result = { ok: false, message: got.message };
      return;
    }
    db.prepare('UPDATE task SET cmd_id = ?, raw = ? WHERE agent = ?').run(
      v.cmd_id,
      JSON.stringify({ ...input, task_id: taskId }),
      v.agent,
    );
    db.prepare(
      'INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)',
    ).run(
      `msg_${Date.now().toString(36)}_${taskId}`,
      v.agent,
      new Date().toISOString(),
      'task_assigned',
      actor,
      `${v.title}\n\n司令: ${v.cmd_id}\n仕事: ${taskId}`,
    );
    journal(db, {
      actor,
      action: wantsBypass ? 'task.assign.bypass' : 'task.assign',
      target: v.agent,
      detail:
        `${taskId} cmd=${v.cmd_id}${v.bloom ? ` bloom=${v.bloom}` : ''}` +
        (wantsBypass
          ? ` reason=${JSON.stringify(input['reason'])} 迂回時の家老=[${observeBypassed(db, ASSIGNER)}]`
          : ''),
    });
    result = { ok: true, id: taskId };
  });
  // 取引の中で断った場合はここへ落ちる（acquire が false を返した筋）。
  return result;
}

/** 迂回された側が、その時どう見えていたか。後から検めるために残す。 */
export function observeBypassed(db: Database, agent: string): string {
  const t = db.query('SELECT task_id, status, holder, lease_until FROM task WHERE agent = ?').get(agent) as
    | { task_id: string | null; status: string; holder: string | null; lease_until: string | null }
    | null;
  const unread = (
    db.query('SELECT count(*) c FROM inbox WHERE agent = ? AND read = 0').get(agent) as { c: number }
  ).c;
  const last = db
    .query('SELECT at FROM ledger WHERE actor = ? ORDER BY id DESC LIMIT 1')
    .get(agent) as { at: string } | null;
  return [
    `${agent}:`,
    `status=${t?.status ?? '不明'}`,
    `holder=${t?.holder ?? 'なし'}`,
    `lease_until=${t?.lease_until ?? 'なし'}`,
    `unread=${unread}`,
    `last_activity=${last?.at ?? 'なし'}`,
  ].join(' ');
}
