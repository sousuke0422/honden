/**
 * 殿へ報せる。**何を報せるかと、どう届けるかを分ける。**
 *
 * # なぜ層を分けるか
 *
 * 旧環境は ntfy（スマホ）一本であった。殿は卓上の通知を望まれ、ntfy も
 * いずれ戻す（殿の申し出 2026-08-30）。送り口が増えるたびに「何を報せるか」を
 * 書き直すのでは、二本目で必ずずれる。
 *
 * ゆえに芯は**出来事から報せを組むだけ**にし、届ける手は差し替え可能にする。
 * `identity.ts` の `lookup`、`parse.ts` の `Runner` と同じ流儀である。
 *
 * # 何を報せるか
 *
 * **殿の裁可待ち**を第一とする。honden で最も詰まるのは常にそこであり、
 * 殿が気づかぬ限り誰も進めぬ。芯の生死や門の拒みは後日足せばよい。
 *
 * # 二度報せぬ
 *
 * 同じ裁可を毎度撃てば、通知そのものが無視されるようになる——**見張りが
 * 狼少年になれば、見張りが無いのと同じ**。撃った跡を台帳に残し、
 * 撃っておらぬ物だけを撃つ。
 */
import type { Database } from 'bun:sqlite';
import { journal } from './store';

/** 届ける先。試験では贋物を注ぐ。 */
export interface Sink {
  name: string;
  send: (n: Notice) => { ok: boolean; detail?: string };
}

/** 一つの報せ。送り口ごとの形には、各々の皮が畳む。 */
export interface Notice {
  /** 見出し。通知の一行目に出る */
  title: string;
  /** 本文。二行目 */
  body: string;
  /** 押した先。無ければボタンを出さぬ */
  url?: string;
  /** 台帳へ「撃った」と刻むための鍵。同じ鍵は二度撃たぬ */
  key: string;
}

export const NOTIFY_ACTION = 'notify.sent';

/** 撃った跡。同じ鍵は二度撃たぬ。 */
function alreadySent(db: Database): Set<string> {
  return new Set(
    (db.query('SELECT target FROM ledger WHERE action = ?').all(NOTIFY_ACTION) as { target: string | null }[])
      .map((r) => r.target ?? ''),
  );
}

/** 一行に畳む。通知は一目で読めねば意味が無い。 */
const oneLine = (s: string, n = 80): string => (s ?? '').split('\n')[0]!.slice(0, n);

/**
 * 撃つべき報せを正本から組む。**判定はここだけ。送り口は与らぬ。**
 *
 * # 何を報せるか
 *
 * 旧環境（README の「Phone Notifications」）が報せておった四種に揃える。
 * 一つでも欠ければ、**殿は端末を見る習慣を失う**——見ても半分しか載って
 * おらぬなら、結局は戦況を開くことになる。
 *
 * | | 旧 | ここ |
 * |---|---|---|
 * | 🚨 | Action needed | 裁可待ち |
 * | ✅ | cmd complete — 5/5 subtasks | 司令の完了（覆いの数つき） |
 * | ❌ | subtask failed — reason | 任の失敗・品質の落第 |
 * | 🔥 | 3-day streak! 12/12 today | 連続と今日の進み |
 *
 * # 二度撃たぬ
 *
 * 鍵は出来事に紐づく（`cmd:done:cmd_042`）。同じ出来事は一度しか起きぬゆえ、
 * 鍵が同じなら撃たぬ——それだけで足りる。
 */
export function pending(db: Database, viewerUrl: string): Notice[] {
  const sent = alreadySent(db);
  const out: Notice[] = [];
  const add = (key: string, title: string, body: string) => {
    if (sent.has(key)) return;
    out.push({ key, title, body, url: viewerUrl });
  };

  // 🚨 殿の裁可待ち。最も詰まる所ゆえ先に並べる。
  const open = db
    .query("SELECT id, question FROM decision WHERE status = 'open' ORDER BY id")
    .all() as { id: number; question: string }[];
  for (const d of open) {
    add(`decision:${d.id}`, 'honden — 殿のご裁可をお待ちしております', `🚨 #${d.id} ${oneLine(d.question)}`);
  }

  // ✅ 司令の完了。覆いの数を添える（旧の `5/5 subtasks done` に当たる）。
  const done = db
    .query(
      `SELECT c.id, c.purpose,
              (SELECT COUNT(*) FROM cmd_acceptance a WHERE a.cmd_id = c.id) total
       FROM cmd c WHERE c.status = 'done' ORDER BY c.completed_at DESC LIMIT 20`,
    )
    .all() as { id: string; purpose: string | null; total: number }[];
  for (const c of done) {
    const n = c.total > 0 ? `（受け入れ条件 ${c.total} 件）` : '';
    add(`cmd:done:${c.id}`, 'honden — 司令が成った', `✅ ${c.id} ${oneLine(c.purpose ?? '', 60)}${n}`);
  }

  // ❌ 倒れた任。**黙って倒れるのが最も悪い**ゆえ、必ず報せる。
  const failed = db
    .query("SELECT agent, task_id FROM task WHERE status = 'failed' AND task_id IS NOT NULL")
    .all() as { agent: string; task_id: string }[];
  for (const t of failed) {
    add(`task:failed:${t.task_id}`, 'honden — 任が倒れた', `❌ ${t.task_id}（${t.agent}）`);
  }

  // ❌ 品質の落第。やり直しが要るゆえ、殿の目にも入れておく。
  const rejected = db
    .query("SELECT task_id, agent FROM report WHERE verdict = 'REJECTED' AND task_id IS NOT NULL LIMIT 20")
    .all() as { task_id: string; agent: string }[];
  for (const r of rejected) {
    add(`report:rejected:${r.task_id}`, 'honden — 品質の検めで落第', `❌ ${r.task_id}（${r.agent}）やり直しが要る`);
  }

  return out;
}

/**
 * 連続の報せ。**日ごとに一度だけ。**
 *
 * 旧の `🔥 3-day streak! 12/12 tasks today` に当たる。数が動いた時ではなく
 * **日が変わった時**に撃つ——数で撃てば、一日に何度も鳴って煩わしくなる。
 *
 * 殿の task 一覧（saytask）を持つ正本でのみ意味を持つゆえ、表が無ければ黙る。
 */
export function streakNotice(db: Database, viewerUrl: string, today: string): Notice[] {
  const sent = alreadySent(db);
  const key = `streak:${today}`;
  if (sent.has(key)) return [];
  type S = { current: number; longest: number; last_date: string | null };
  let s: S | null = null;
  let today_done = 0;
  let today_total = 0;
  try {
    s = db.query('SELECT current, longest, last_date FROM saytask_streak WHERE one = 1').get() as S | null;
    const t = db
      .query(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done
         FROM saytask WHERE status IN ('todo','pending','in_progress','done')`,
      )
      .get() as { total: number; done: number | null };
    today_total = t.total;
    today_done = t.done ?? 0;
  } catch {
    return []; // 器が無ければ黙る
  }
  if (!s || s.last_date !== today) return []; // 今日まだ果たしておらぬ
  return [
    {
      key,
      title: 'honden — 連続',
      body: `🔥 ${s.current} 日連続（最長 ${s.longest}）　${today_done}/${today_total}`,
      url: viewerUrl,
    },
  ];
}

export interface SendResult {
  sent: number;
  failed: { key: string; sink: string; detail?: string }[];
}

/**
 * 撃つ。**一つでも届けば「撃った」と刻む。**
 *
 * 送り口が複数ある時、片方が落ちても報せは届いておる。全滅した時だけ
 * 刻まぬ——刻んでしまえば、次の機会に撃ち直せぬゆえ。
 */
export function dispatch(db: Database, notices: Notice[], sinks: Sink[]): SendResult {
  const res: SendResult = { sent: 0, failed: [] };
  for (const n of notices) {
    let any = false;
    for (const s of sinks) {
      const r = s.send(n);
      if (r.ok) any = true;
      else res.failed.push({ key: n.key, sink: s.name, detail: r.detail });
    }
    if (any) {
      journal(db, {
        actor: 'honden',
        action: NOTIFY_ACTION,
        target: n.key,
        detail: `${sinks.map((s) => s.name).join('+')} へ: ${n.body.slice(0, 80)}`,
      });
      res.sent++;
    }
  }
  return res;
}
