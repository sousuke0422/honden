/**
 * 受け渡しを読む・既読にする。
 *
 * CLAUDE.md の Inbox Processing Protocol をそのまま写す。
 *
 *   1. 自分の inbox を読む
 *   2. read: false のものを探す
 *   3. type ごとに処理する
 *   4. 一件ずつ read: true にする
 *
 * ## 既読は自分のものだけ
 *
 * `.opencode/tools/mark-as-read.ts` の assertCurrentAgent と同じ。
 * 他人の inbox を既読にすると、その相手は報せが来たことを永久に知らない。
 *
 * 読むだけは他人のものも許す。将軍や家老が様子を見る筋があるため。
 * 見ることと、見たことにすることは違う。
 *
 * ## 開く前に分類が分かる
 *
 * いまの nudge は `inbox3` の一語で、これは「未読 3 件」とも「足軽 3 号」とも
 * 読める。足軽の番号も 1〜7 で、未読数と同じ範囲になるため衝突する。
 * 実際に読み違えが出ている。
 *
 * type ごとの内訳まで出せば、開く前に「いま手を止めるべきか」が判ずる。
 * cmd_new は止めるべきで、report_received は区切りまで待てる。
 * いまは全ての合図が等しく緊急なので、足軽は必ず手を止めて読むしかない。
 */

import type { Database } from 'bun:sqlite';
import { journal, tx } from './store';

export interface Message {
  id: string;
  agent: string;
  createdAt: string;
  type: string;
  sender: string;
  body: string;
  read: boolean;
}

const toMessage = (r: Record<string, unknown>): Message => ({
  id: String(r['id']),
  agent: String(r['agent']),
  createdAt: String(r['created_at'] ?? ''),
  type: String(r['msg_type'] ?? ''),
  sender: String(r['sender'] ?? ''),
  body: String(r['body'] ?? ''),
  read: r['read'] === 1,
});

/** 未読、または全件を古い順に返す。 */
export function list(db: Database, agent: string, opts: { all?: boolean; limit?: number } = {}): Message[] {
  const sql = opts.all
    ? 'SELECT * FROM inbox WHERE agent = ? ORDER BY created_at, id LIMIT ?'
    : 'SELECT * FROM inbox WHERE agent = ? AND read = 0 ORDER BY created_at, id LIMIT ?';
  return (db.query(sql).all(agent, opts.limit ?? 100) as Record<string, unknown>[]).map(toMessage);
}

export interface Summary {
  total: number;
  /** type ごとの内訳。多い順。 */
  byType: { type: string; count: number }[];
  /** 手を止めるべきものが混じっているか。 */
  urgent: boolean;
}

/**
 * 未読の内訳。
 *
 * `clear_command` と `cmd_new` は手を止めるべきもの。
 * `report_received` は区切りまで待てる。
 */
const URGENT_TYPES = new Set(['clear_command', 'cmd_new', 'cmd_update']);

export function summarize(db: Database, agent: string): Summary {
  const rows = db
    .query('SELECT msg_type, count(*) c FROM inbox WHERE agent = ? AND read = 0 GROUP BY msg_type ORDER BY c DESC, msg_type')
    .all(agent) as { msg_type: string; c: number }[];
  return {
    total: rows.reduce((a, r) => a + r.c, 0),
    byType: rows.map((r) => ({ type: r.msg_type, count: r.c })),
    urgent: rows.some((r) => URGENT_TYPES.has(r.msg_type)),
  };
}

/**
 * 合図の文字列。
 *
 * ## なぜ日本語ではないか
 *
 * これを受け取るのは人ではなく、各 CLI の裏に居るモデルになる。
 * claude / codex / cursor / opencode / copilot / kimi と種類があり、
 * 日本語の記号（★ など）や語の切れ目の扱いはモデルごとに揺れる。
 *
 * key=value の羅列なら、どのモデルでも同じに読める。type の名は
 * もともとこの系の識別子で ASCII なので、そのまま使える。
 *
 * ## なぜ `inbox3` ではないか
 *
 * `inbox3` の 3 は未読数だが、足軽の番号も 1〜7 で同じ範囲になる。
 * 「足軽 3 号」と読み違える事例が実際に出ている。
 * 先頭を `inbox_notice` にして数を key=value へ移せば、衝突しようがない。
 */
export function nudgeText(s: Summary): string {
  const parts = [`inbox_notice`, `unread=${s.total}`];
  for (const b of s.byType) parts.push(`${b.type}=${b.count}`);
  if (s.total > 0) parts.push(`urgent=${s.urgent ? 1 : 0}`);
  return parts.join(' ');
}

export interface AckResult {
  ok: boolean;
  /** 実際に既読へ変わったもの。 */
  changed: string[];
  /** すでに既読だったもの。errorではない。 */
  already: string[];
  message?: string;
}

/**
 * 既読にする。自分のものだけ。
 *
 * すでに既読のものはエラーにしない。何度呼んでも同じ結果になる。
 * 自分のものでない id が混じっていたら、**一件も既読にせず**断る。
 * 一部だけ通すと、どこまで済んだのか呼んだ側に分からない。
 */
export function ack(db: Database, selfId: string, ids: string[]): AckResult {
  if (ids.length === 0) {
    return { ok: false, changed: [], already: [], message: '既読にする報せの id が要る。' };
  }
  const rows = db
    .query(`SELECT id, agent, read FROM inbox WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: string; agent: string; read: number }[];

  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  const others = rows.filter((r) => r.agent !== selfId);

  if (missing.length > 0 || others.length > 0) {
    const lines = ['既読にできぬ。一件も触っておらぬ。'];
    for (const m of missing) lines.push(`    ${m}: そのような報せは無い`);
    for (const o of others) lines.push(`    ${o.id}: ${o.agent} 宛である（そなたは ${selfId}）`);
    lines.push('  他人の報せを既読にすると、その相手は報せが来たことを永久に知らぬ。');
    return { ok: false, changed: [], already: [], message: lines.join('\n') };
  }

  const already = rows.filter((r) => r.read === 1).map((r) => r.id);
  const toMark = rows.filter((r) => r.read === 0).map((r) => r.id);

  if (toMark.length > 0) {
    tx(db, () => {
      db.prepare(`UPDATE inbox SET read = 1 WHERE id IN (${toMark.map(() => '?').join(',')})`).run(
        ...toMark,
      );
      journal(db, {
        actor: selfId,
        action: 'inbox.ack',
        target: selfId,
        detail: `${toMark.length}件: ${toMark.join(',')}`,
      });
    });
  }
  return { ok: true, changed: toMark, already };
}

/** 自分の未読を全部既読にする。 */
export function ackAll(db: Database, selfId: string): AckResult {
  const ids = list(db, selfId, { limit: 1000 }).map((m) => m.id);
  if (ids.length === 0) return { ok: true, changed: [], already: [] };
  return ack(db, selfId, ids);
}
