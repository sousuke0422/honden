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

/**
 * 撃つべき報せを正本から組む。**判定はここだけ。送り口は与らぬ。**
 *
 * 裁可待ちのうち、まだ撃っておらぬものを返す。
 */
export function pending(db: Database, viewerUrl: string): Notice[] {
  const open = db
    .query("SELECT id, question FROM decision WHERE status = 'open' ORDER BY id")
    .all() as { id: number; question: string }[];
  if (open.length === 0) return [];

  const sent = new Set(
    (db.query('SELECT target FROM ledger WHERE action = ?').all(NOTIFY_ACTION) as { target: string | null }[])
      .map((r) => r.target ?? ''),
  );

  const out: Notice[] = [];
  for (const d of open) {
    const key = `decision:${d.id}`;
    if (sent.has(key)) continue;
    out.push({
      title: 'honden — 殿のご裁可をお待ちしております',
      // 問いは長くなりうる。通知は一目で読めねば意味が無いゆえ畳む。
      body: `#${d.id} ${d.question.split('\n')[0]!.slice(0, 80)}`,
      url: viewerUrl,
      key,
    });
  }
  return out;
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
