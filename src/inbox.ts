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
import { journal, tx, raiseSignal } from './store';
import { roleOrNull } from './roster';
import { checkReason } from './validate';

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

/** inbox read の既定表示件数。 */
export const INBOX_LIST_DEFAULT_LIMIT = 100;

/** ackFor（他人の未読を代わりに片付ける）が走査する上限。ack --all は上限なしの EXISTS で判じる。 */
export const INBOX_ACK_SCAN_LIMIT = 1000;

/** 未読、または全件を古い順に返す。 */
export function list(db: Database, agent: string, opts: { all?: boolean; limit?: number } = {}): Message[] {
  const sql = opts.all
    ? 'SELECT * FROM inbox WHERE agent = ? ORDER BY created_at, id LIMIT ?'
    : 'SELECT * FROM inbox WHERE agent = ? AND read = 0 ORDER BY created_at, id LIMIT ?';
  // sender は素のまま返す。@no-reply の印は表示の口（runInboxRead）だけ——ここへ混ぜると from の突き合わせが壊れる。
  return (db.query(sql).all(agent, opts.limit ?? INBOX_LIST_DEFAULT_LIMIT) as Record<string, unknown>[]).map(
    toMessage,
  );
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
const URGENT_TYPES = new Set([
  'clear_command',
  'cmd_new',
  'cmd_update',
  'guard_appeal',
  'guard_grant',
  // 見捨てられた司令は既に閾値分の時を失っておる。家老が次に honden を
  // 叩いた節目で横乗せの一行に出るよう、急ぎに数える (src/abandoned.ts)。
  'cmd_abandoned',
  // 依存の取り消しで塞がった司令も、振れぬまま時を失う。家老の節目に出す (src/deps.ts)。
  'cmd_blocked',
  'lease_stalled',
  // 検められておらぬ報告も閾値分の時を既に失っておる。軍師（と長引けば
  // 家老）が次に honden を叩いた節目で目に入るよう、急ぎに数える (src/unreviewed.ts)。
  'report_unreviewed',
  // 検め済み task への直しの報告は振り直しが要る——家老の差配待ちゆえ急ぎ (src/unreviewed.ts)。
  'report_requeue',
]);

/**
 * 出力の尻に横乗せする急報の一行。**全 CLI 共通の第一経路である**（殿裁定
 * 2026-08-27）。どの CLI も作業中にツールとして honden を叩くゆえ、
 * 出力に一行添えれば作業を壊さず届く。send-keys の届き方は CLI ごとに
 * まちまち（claude は切りで読む・cursor は完了まで読まぬ）だが、
 * この経路に CLI 差は無い。push（nudge・添え押し）は補助に回る。
 * 急ぎでなければ載せぬ。毎回うるさくすると読み飛ばしが癖になり、
 * いざの一行まで死ぬ。
 */
export function urgentRideAlong(db: Database, agent: string): string | null {
  const s = summarize(db, agent);
  if (!s.urgent) return null;
  const types = s.byType
    .filter((t) => URGENT_TYPES.has(t.type))
    .map((t) => `${t.type}=${t.count}`)
    .join(' ');
  return `  ⚠ ${agent} に急ぎの未読（${types}）— honden inbox read で確かめよ`;
}

/**
 * 横乗せを**載せてはならぬ**口。
 *
 * - `inbox`: 見に行く行為そのものに重ねるのは二重
 * - `nudge`: 末尾の JSON 行が芯への返事
 * - `guard hook`: 出力は CLI（cursor / codex / claude）が **JSON として読む**。
 *   一行でも混ざれば「invalid JSON」となり、fail-closed の CLI は
 *   **以後の全 Shell を拒む**。拒まれた者は `inbox read` も `inbox ack` も
 *   叩けぬゆえ急ぎが消えず、横乗せが止まらず、永久に閉じる
 *   （実害 2026-09-04・家老 cursor: cmd_8 の急報が届いた瞬間に全命が止まり、
 *   nudge が三度 /new-chat を撃つに至った）
 *
 * 引数は副命令の語の列（`rest`）。旗は含まぬ。
 */
export function rideAlongSuppressed(rest: readonly string[]): boolean {
  if (rest.length === 0) return true;
  if (rest[0] === 'inbox' || rest[0] === 'nudge') return true;
  if (rest[0] === 'guard' && rest[1] === 'hook') return true;
  return false;
}

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

/**
 * 直近の read が見せた範囲。
 *
 * boundary は inbox の rowid（挿入の順）で、**一覧を引く取引の中で**採った境である。
 * 刻（created_at）の比べに頼らぬ理由: 刻は一覧を引いた**後**に採られ、その間に届いた報せを
 * 「届いておらぬ」と数えてしまう。同じ刻の報せも在りうる。rowid は挿入の順で単調ゆえ、
 * 境より大きければ、読まれておらぬ新着と言い切れる。null は境を持たぬ古い写し。
 *
 * **rowid が単調なのは、inbox から行を消さぬ間だけである。** inbox は暗黙の rowid（AUTOINCREMENT
 * ではない）ゆえ、最大の rowid の行を消すと、次の挿入がその番号を使い回す（使い捨ての正本で実測）。
 * 境がその番号なら、新着が「境より大きい」を満たさず、読まれておらぬ新着を見逃す。
 * 今は src に inbox から行を消す者が居らぬ（inbox への DELETE は 0 件）ゆえ成り立つ。
 * **間引き（掃除）を足すなら**、次のどちらかを守れ。
 *   - 最大の rowid の行を残す（番号の使い回しを起こさぬ）。
 *   - 消した後に `inbox_read_snapshot` の境を落とし（写しの行を消す／boundary を NULL にする）、
 *     読み直させる。境が無ければ ack --all は断る側へ倒れて止まる（ackAll の「写し無し」「境無し」の道）。
 */
type ReadSnapshot = { ids: string[]; boundary: number | null };

/** inbox の今の最大の rowid（挿入の順の先頭）。空なら 0。 */
function maxInboxRowid(db: Database): number {
  const row = db.query('SELECT COALESCE(MAX(rowid), 0) AS m FROM inbox').get() as { m: number };
  return row.m;
}

/** 直近の inbox read（己の未読）が見せた id と、その境（rowid）を正本に残す。 */
export function recordReadSnapshot(db: Database, agent: string, shown: Message[], boundary: number): void {
  db.prepare(
    `INSERT INTO inbox_read_snapshot(agent, ids, boundary) VALUES (?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET ids = excluded.ids, boundary = excluded.boundary`,
  ).run(agent, JSON.stringify({ ids: shown.map((m) => m.id) }), boundary);
}

/**
 * 己の未読を読み、見せた範囲を境つきで正本に残す。`inbox read` の己の未読の道。
 *
 * 境の採取・一覧・写しの書き込みを**一つの取引**（IMMEDIATE）でする。境を一覧より先に採るのは、
 * 一覧の後に届いた物を、必ず境より後に置くため（境が一覧の後なら、その間の報せが境の内に入って
 * 「読んだ」と数えられる）。onListed は試験から割り込む口で、一覧を引いた直後に呼ぶ。
 */
export function readOwnUnread(db: Database, agent: string, opts: { onListed?: () => void } = {}): Message[] {
  return db
    .transaction(() => {
      const boundary = maxInboxRowid(db);
      const msgs = list(db, agent);
      opts.onListed?.();
      recordReadSnapshot(db, agent, msgs, boundary);
      return msgs;
    })
    .immediate();
}

function loadReadSnapshot(db: Database, agent: string): ReadSnapshot | null {
  const row = db.query('SELECT ids, boundary FROM inbox_read_snapshot WHERE agent = ?').get(agent) as
    | { ids: string; boundary: number | null }
    | null;
  if (!row) return null;
  const parsed = JSON.parse(row.ids) as unknown;
  const boundary = typeof row.boundary === 'number' ? row.boundary : null;
  // 古い写しは id の配列そのものか、{ ids, readAt } だった。id だけを引き継ぎ、境は持たぬものとして扱う。
  if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
    return { ids: parsed, boundary };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ids?: unknown }).ids)) {
    const ids = (parsed as { ids: unknown[] }).ids;
    if (!ids.every((x) => typeof x === 'string')) return null;
    return { ids: ids as string[], boundary };
  }
  return null;
}

function clearReadSnapshot(db: Database, agent: string): void {
  db.prepare('DELETE FROM inbox_read_snapshot WHERE agent = ?').run(agent);
}

/**
 * 自分の未読を、直近の read が見せた分だけ既読にする。
 *
 * read 以降に届いた未読があるなら一件も触らず断る——読まれぬまま既読にしない。
 * 「届いた」は、境（rowid）より後に入った己宛ての未読が一件でも在るか、**件数の上限なしの EXISTS**
 * で判じる（走査に上限があると、古い未読が上限を越えて並ぶ時、新着が走査の外に出て見逃される）。
 * その判じと既読化は同じ取引の中で行う（間に届いた物を、既読化の後で見逃さぬ）。
 */
export function ackAll(db: Database, selfId: string): AckResult {
  return db
    .transaction((): AckResult => {
      const snapshot = loadReadSnapshot(db, selfId);
      if (snapshot === null) {
        return {
          ok: false,
          changed: [],
          already: [],
          message:
            'inbox read をまだ打っておらぬ。見せた報せが無いまま ack --all はできぬ。\n' +
            '  先に honden inbox read して、届いた分を読んだ上で ack --all せよ。',
        };
      }
      if (snapshot.boundary === null) {
        return {
          ok: false,
          changed: [],
          already: [],
          message:
            'inbox read の写しに境が無い（古い版が残した写し）。どこまで見せたか分からぬゆえ、既読にできぬ。\n' +
            '  もう一度 honden inbox read してから ack --all せよ。',
        };
      }

      const arrived = db
        .query('SELECT EXISTS (SELECT 1 FROM inbox WHERE agent = ? AND read = 0 AND rowid > ?) AS e')
        .get(selfId, snapshot.boundary) as { e: number };
      if (arrived.e === 1) {
        // 断る文のために件数と先頭の id を引く（判じは上の EXISTS。ここは言葉の材料だけ）。
        const n = (
          db
            .query('SELECT count(*) AS n FROM inbox WHERE agent = ? AND read = 0 AND rowid > ?')
            .get(selfId, snapshot.boundary) as { n: number }
        ).n;
        const head = (
          db
            .query('SELECT id FROM inbox WHERE agent = ? AND read = 0 AND rowid > ? ORDER BY rowid LIMIT 5')
            .all(selfId, snapshot.boundary) as { id: string }[]
        ).map((r) => r.id);
        return {
          ok: false,
          changed: [],
          already: [],
          message:
            `inbox read のあとに未読が ${n} 件届いた（${head.join(', ')}${n > head.length ? ' ほか' : ''}）。\n` +
            '  読まれぬまま既読にできぬ。もう一度 honden inbox read してから ack --all せよ。',
        };
      }

      if (snapshot.ids.length === 0) {
        clearReadSnapshot(db, selfId);
        return { ok: true, changed: [], already: [] };
      }
      const r = ack(db, selfId, snapshot.ids);
      if (r.ok) clearReadSnapshot(db, selfId);
      return r;
    })
    .immediate();
}

/**
 * 他人の未読を代わりに片付ける（殿の裁可・cmd_20 の求め）。
 *
 * 「他人の報せを既読にすると、その相手は報せが来たことを永久に知らぬ」——
 * `ack` がこれを断るのは正しい。だが**当人が動けぬ時、その正しさが輪を閉じる**。
 * 閉じた司令の古い未読は誰も消さず（inbox の行は cmd と紐づいておらぬ）、
 * 未読が残る限り芯は段を上げ続け、三度で見放す。見放された当人は合図を受けぬゆえ
 * 己では ack を打てぬ。正本を手で書き換えるほか無かった（実測: 足軽6号）。
 *
 * ゆえに上役だけに、理由を添えて開ける。作法は `lease release --force` に倣い、
 * 別の名（`inbox.ack.force`）で台帳へ残す——「誰が・なぜ・何件を」当人が後から
 * 辿れるように。読む側には既に `--agent` の前例がある（`inbox read --agent` は
 * 覗いた跡を `inbox.peek` として刻む）。足りなんだのは片付ける側だけである。
 */
export function ackFor(
  db: Database,
  opts: { agent: string; by: string; reason?: string },
): AckResult {
  if (roleOrNull(opts.by) !== 'commander') {
    return {
      ok: false,
      changed: [],
      already: [],
      message:
        '他人の報せを片付けられるのは家老までである。\n' +
        '  足軽が互いに片付け合うと、報せが届いておらぬことに誰も気づけぬ。家老へ回されよ。',
    };
  }
  const bad = checkReason(opts.reason, `${opts.agent} は止まっており、閉じた司令の未読が残っておる`);
  if (bad) return { ok: false, changed: [], already: [], message: bad };

  const ids = list(db, opts.agent, { limit: INBOX_ACK_SCAN_LIMIT }).map((m) => m.id);
  if (ids.length === 0) return { ok: true, changed: [], already: [] };

  tx(db, () => {
    db.prepare(`UPDATE inbox SET read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    journal(db, {
      actor: opts.by,
      action: 'inbox.ack.force',
      target: opts.agent,
      detail: `${ids.length}件: ${ids.join(',')} reason=${JSON.stringify(opts.reason)}`,
    });
  });
  return { ok: true, changed: ids, already: [] };
}

/**
 * 報せを一通、相手の inbox へ入れる。
 *
 * inbox への挿入はここだけを通す。4 か所に同じ INSERT が散っていると、
 * 合図を出す所と出さぬ所が生まれ、届いたのに誰も起きない筋ができる。
 *
 * 取引 (tx) の中から呼ぶこと。合図は取引の外へ出てから上げる。
 */
export function deliver(
  db: Database,
  msg: { id: string; agent: string; at: string; type: string; sender: string; body: string },
): void {
  db.prepare('INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)').run(
    msg.id,
    msg.agent,
    msg.at,
    msg.type,
    msg.sender,
    msg.body,
  );
}

/** 取引が済んでから合図を上げる。届いた分だけ起こす。 */
export function signal(db: Database): void {
  raiseSignal(db);
}
