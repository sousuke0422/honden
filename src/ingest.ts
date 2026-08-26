/**
 * 現行の YAML を、型のある表へ写す。
 *
 * `import.ts` は本文と索引だけを入れる（読めないものも本文は入る）。
 * こちらは形が読めたものを構造化して、cmd / task / inbox / report の表へ入れる。
 *
 * ## 現行踏襲
 *
 * 鍵の名も値も、いまの YAML のまま受ける。読み替えは最小にする。
 * 型に収まらないものは捨てず legacy へ落とす（store.ts の legacy を参照）。
 *
 * 2026-08-25 に実データを数えた結果:
 *
 *   inbox   145 件。content / from / id / read / timestamp / type が全件に揃う
 *   task      8 件。task_id / worker_id / status は揃うが、他は割当中の 1 件だけ厚い
 *   report  多数。task_id / worker_id / status / result が中心
 *
 * ## 何度走らせても同じ結果になること
 *
 * 取り込みは繰り返し走る。id を持つものは id で upsert し、
 * 持たないもの（task）は agent で upsert する。
 */

import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import { legacy, tx } from './store';

/** inbox の既知の鍵。これ以外は legacy へ。 */
const INBOX_KEYS = new Set(['id', 'from', 'type', 'content', 'timestamp', 'read']);
/** task の既知の鍵。 */
const TASK_KEYS = new Set(['task_id', 'worker_id', 'status', 'updated_at', 'parent_cmd']);
/** report の既知の鍵。 */
const REPORT_KEYS = new Set(['task_id', 'worker_id', 'status', 'timestamp', 'verdict']);

/** 規定の 4 値。外れた値は verdict を空にして legacy へ落とす。 */
const VERDICTS = new Set(['APPROVED', 'APPROVED_WITH_CONCERNS', 'CHANGES_REQUESTED', 'REJECTED']);

const rest = (obj: Record<string, unknown>, known: Set<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !known.has(k)));

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v));

export interface IngestCount {
  inbox: number;
  task: number;
  report: number;
  skipped: number;
}

/**
 * `queue/inbox/<agent>.yaml` を写す。
 *
 * 宛先はファイル名から取る。中身に宛先は書かれていないため。
 */
export function ingestInbox(db: Database, path: string, doc: unknown): number {
  const agent = basename(path).replace(/\.ya?ml$/, '');
  const msgs = (doc as { messages?: unknown[] })?.messages;
  if (!Array.isArray(msgs)) return 0;

  // 影は影の報せだけを触る。実運用の報せに当たると、届いた本文が
  // YAML から写したもので置き換わり、誰宛の何であったかが消える。
  const ins = db.prepare(
    `INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read, origin) VALUES (?,?,?,?,?,?,?,'import')
     ON CONFLICT(id) DO UPDATE SET
       agent = excluded.agent, created_at = excluded.created_at,
       msg_type = excluded.msg_type, sender = excluded.sender,
       body = excluded.body, read = excluded.read
     WHERE inbox.origin = 'import'`,
  );
  let n = 0;
  for (const raw of msgs) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const id = str(m['id']);
    if (!id) continue; // id の無いものは追えないので入れない
    ins.run(
      id,
      agent,
      str(m['timestamp']) ?? '',
      str(m['type']) ?? 'unknown',
      str(m['from']) ?? 'unknown',
      str(m['content']) ?? '',
      m['read'] === true ? 1 : 0,
    );
    n++;
  }
  return n;
}

/** `queue/tasks/<agent>.yaml` を写す。 */
export function ingestTask(db: Database, path: string, doc: unknown, raw: string): number {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 0;
  const d = doc as Record<string, unknown>;
  const agent = str(d['worker_id']) ?? basename(path).replace(/\.ya?ml$/, '');
  // pending.yaml のような持ち場でないものは入れない
  if (!/^(shogun|karo|gunshi|ashigaru[1-9])$/.test(agent)) return 0;

  // honden が振った生きた持ち場は潰さない。
  //
  // 取り込みは繰り返し走る前提だが、task 表は agent を鍵に上書きする。
  // honden で振った直後に shogun 側の YAML を取り込むと task_id が差し替わり、
  // **足軽は自分の仕事の報告を出せなくなる**（外部レビューで再現・2026-08-26）。
  //
  // 「影は一方通行ゆえ安全」は doc 表には成り立つが、task・report・inbox は
  // 影と実運用が同じ行を取り合う。生きた持ち主が居る行は、影の側が譲る。
  const holder = db.query('SELECT holder FROM task WHERE agent = ?').get(agent) as { holder: string | null } | null;
  if (holder?.holder) return 0;

  db.prepare(
    `INSERT INTO task(agent, task_id, status, cmd_id, updated_at, raw)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(agent) DO UPDATE SET
       task_id = excluded.task_id, status = excluded.status,
       cmd_id = excluded.cmd_id, updated_at = excluded.updated_at, raw = excluded.raw`,
  ).run(
    agent,
    str(d['task_id']),
    str(d['status']) ?? 'idle',
    str(d['parent_cmd']),
    str(d['updated_at']) ?? '',
    raw,
  );
  // 持ち場に載らなかった鍵は raw に残っている。lease はここでは触らない
  // （取り込みで貸与を握らせると、誰も居ないのに握られた形になる）。
  void rest(d, TASK_KEYS);
  return 1;
}

/** `queue/reports/*.yaml` を写す。 */
export function ingestReport(db: Database, path: string, doc: unknown, raw: string): number {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 0;
  const d = doc as Record<string, unknown>;
  const agent = str(d['worker_id']) ?? basename(path).split('_')[0] ?? 'unknown';
  const v = str(d['verdict']);
  const ok = v !== null && VERDICTS.has(v);

  // 同じ報告を二度入れない。task_id と agent で見分ける。
  //
  // **影の行だけを触る。** honden が受けた報告に当てると、raw が YAML 原文へ化け、
  // coverageOf の json_extract が倒れて**その司令の門が丸ごと止まる**
  // （外部レビューで再現・2026-08-27）。
  //
  // ingestTask には同じ門を足しておきながら、その註が名指ししておった
  // report と inbox には足しておらなんだ。同じ型の見落としである。
  const dup = db
    .query("SELECT id FROM report WHERE agent = ? AND task_id IS ? AND origin = 'import'")
    .get(agent, str(d['task_id'])) as { id: number } | null;

  // 実運用の行が既に在るなら、影は退く。
  const native = db
    .query("SELECT id FROM report WHERE agent = ? AND task_id IS ? AND origin = 'native'")
    .get(agent, str(d['task_id'])) as { id: number } | null;
  if (native) return 0;
  const extra = legacy({ ...rest(d, REPORT_KEYS), ...(ok ? {} : { verdict: v }) });

  if (dup) {
    db.prepare('UPDATE report SET created_at = ?, verdict = ?, raw = ?, legacy = ? WHERE id = ?').run(
      str(d['timestamp']),
      ok ? v : null,
      raw,
      extra,
      dup.id,
    );
  } else {
    db.prepare(
      "INSERT INTO report(agent, task_id, created_at, verdict, raw, legacy, origin) VALUES (?,?,?,?,?,?,'import')",
    ).run(agent, str(d['task_id']), str(d['timestamp']), ok ? v : null, raw, extra);
  }
  return 1;
}

/**
 * 取り込み済みの doc から、形が読めたものを構造化する。
 *
 * `import.ts` が本文を入れたあとに走らせる。読めなかったものは
 * import_issue に残っているので、ここでは黙って飛ばしてよい。
 */
export function ingestAll(db: Database, root: string, files: { path: string; body: string }[]): IngestCount {
  const c: IngestCount = { inbox: 0, task: 0, report: 0, skipped: 0 };
  for (const f of files) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(f.body);
    } catch {
      c.skipped++;
      continue;
    }
    const rel = f.path;
    tx(db, () => {
      if (rel.includes('/inbox/')) c.inbox += ingestInbox(db, rel, doc);
      else if (rel.includes('/tasks/')) c.task += ingestTask(db, rel, doc, f.body);
      else if (rel.includes('/reports/')) c.report += ingestReport(db, rel, doc, f.body);
      else c.skipped++;
    });
  }
  void root;
  return c;
}
