/**
 * 殿ご自身の task 一覧（SayTask）。
 *
 * # なぜ正本へ移すか
 *
 * 旧環境では将軍が `saytask/tasks.yaml` を直に読み書きしておった。家老を
 * 通さぬ**唯一の例外**である（旧 F001 の穴）。切り替えの後は旧 repo が凍る
 * ——凍った repo の YAML を書き続ければ、**書き手が二人**の禍根になる。
 *
 * 中身は殿の私の案件であり、陣の司令とは別物。ゆえに `cmd` とは混ぜぬ。
 *
 * # 判定はここ、入出力は外
 *
 * 他の箱と同じく、ここは純関数と DB だけを持つ。
 */
import type { Database } from 'bun:sqlite';
import { journal } from './store';

export const STATUSES = ['todo', 'pending', 'in_progress', 'done', 'dropped'] as const;
export type Status = (typeof STATUSES)[number];

export interface Item {
  id: string;
  title: string;
  category: string | null;
  priority: string | null;
  rfc_level: string | null;
  status: Status;
  tags: string[];
  description: string | null;
  due: string | null;
  created_at: string;
  done_at: string | null;
}

export interface Streak {
  current: number;
  longest: number;
  last_date: string | null;
}

interface Row extends Omit<Item, 'tags'> {
  tags: string | null;
}

const toItem = (r: Row): Item => ({
  ...r,
  tags: (() => {
    try {
      const v = JSON.parse(r.tags ?? '[]') as unknown;
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  })(),
});

const COLS = 'id, title, category, priority, rfc_level, status, tags, description, due, created_at, done_at';

export function list(db: Database, status?: Status): Item[] {
  const rows = (
    status
      ? db.query(`SELECT ${COLS} FROM saytask WHERE status = ? ORDER BY due IS NULL, due, id`).all(status)
      : db.query(`SELECT ${COLS} FROM saytask ORDER BY status = 'done', due IS NULL, due, id`).all()
  ) as Row[];
  return rows.map(toItem);
}

export function get(db: Database, id: string): Item | null {
  const r = db.query(`SELECT ${COLS} FROM saytask WHERE id = ?`).get(id) as Row | null;
  return r ? toItem(r) : null;
}

/**
 * 次の番号。旧の採番（`VF-001`）をそのまま継ぐ。
 *
 * 最大値の次を取る——**件数の次ではない**。消した跡があると件数は当てにならず、
 * 既にある番号を二度振れば主キーが弾く（弾いてくれるのは有難いが、
 * 弾かれてから気づくのでは遅い）。
 */
export function nextId(db: Database, prefix = 'VF'): string {
  const rows = (db.query('SELECT id FROM saytask').all() as { id: string }[]).map((r) => r.id);
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of rows) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export interface AddInput {
  title?: unknown;
  category?: unknown;
  priority?: unknown;
  rfc_level?: unknown;
  tags?: unknown;
  description?: unknown;
  due?: unknown;
  id?: unknown;
  status?: unknown;
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

export function add(
  db: Database,
  input: AddInput,
  now: Date,
  raw = '',
): { ok: true; item: Item } | { ok: false; message: string } {
  const title = str(input.title);
  if (!title) return { ok: false, message: '何をなさるのかを書かれよ（title が要る）。' };

  const status = (str(input.status) ?? 'todo') as Status;
  if (!(STATUSES as readonly string[]).includes(status)) {
    return { ok: false, message: `status は ${STATUSES.join('/')} のいずれか（${status}）` };
  }

  const id = str(input.id) ?? nextId(db);
  if (get(db, id)) return { ok: false, message: `${id} は既にある。番号を改められよ` };

  const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  db.prepare(
    `INSERT INTO saytask(id, title, category, priority, rfc_level, status, tags, description, due, created_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    title,
    str(input.category),
    str(input.priority),
    str(input.rfc_level),
    status,
    JSON.stringify(tags),
    str(input.description),
    str(input.due),
    now.toISOString(),
    raw || JSON.stringify(input),
  );
  journal(db, { actor: 'shogun', action: 'saytask.add', target: id, detail: title.slice(0, 80) });
  return { ok: true, item: get(db, id)! };
}

export function setStatus(
  db: Database,
  id: string,
  status: Status,
  now: Date,
): { ok: boolean; message: string } {
  const cur = get(db, id);
  if (!cur) return { ok: false, message: `${id} は無い` };
  if (cur.status === status) return { ok: false, message: `${id} は既に ${status} である` };
  db.prepare('UPDATE saytask SET status = ?, done_at = ? WHERE id = ?').run(
    status,
    status === 'done' ? now.toISOString() : null,
    id,
  );
  journal(db, { actor: 'shogun', action: 'saytask.status', target: id, detail: `${cur.status} → ${status}` });
  return { ok: true, message: `${id} を ${status} にした（${cur.title.slice(0, 40)}）` };
}

export function streak(db: Database): Streak {
  const r = db.query('SELECT current, longest, last_date FROM saytask_streak WHERE one = 1').get() as Streak | null;
  return r ?? { current: 0, longest: 0, last_date: null };
}

/** `YYYY-MM-DD`。連続は日で数えるゆえ、時刻は落とす。 */
export const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 今日の分を果たしたと記す。
 *
 * 昨日から続いておれば伸び、間が空けば一から。**同じ日に二度数えぬ**
 * ——数えれば、一日で連続が伸びる嘘になる。
 */
export function touchStreak(db: Database, now: Date): Streak {
  const s = streak(db);
  const today = day(now);
  if (s.last_date === today) return s;

  const yesterday = day(new Date(now.getTime() - 86_400_000));
  const current = s.last_date === yesterday ? s.current + 1 : 1;
  const longest = Math.max(s.longest, current);
  db.prepare('UPDATE saytask_streak SET current = ?, longest = ?, last_date = ? WHERE one = 1').run(
    current,
    longest,
    today,
  );
  journal(db, { actor: 'shogun', action: 'saytask.streak', target: today, detail: `${current} 日目（最長 ${longest}）` });
  return { current, longest, last_date: today };
}

/**
 * 旧の `saytask/tasks.yaml` を取り込む。
 *
 * **既にある番号は上書きせぬ。** 取り込みは何度打っても同じ結果になるべきで、
 * 上書きすれば手で直した分が消える。
 */
export function importItems(
  db: Database,
  items: unknown,
  now: Date,
): { added: number; skipped: number; failed: { id: string; why: string }[] } {
  const out = { added: 0, skipped: 0, failed: [] as { id: string; why: string }[] };
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const rec = it as AddInput & { created_at?: unknown };
    const id = str(rec.id);
    if (id && get(db, id)) {
      out.skipped++;
      continue;
    }
    const r = add(db, rec, now, JSON.stringify(it));
    if (r.ok) out.added++;
    else out.failed.push({ id: id ?? '(番号無し)', why: r.message });
  }
  return out;
}

/** 一覧を人の読む形へ。 */
export function render(items: Item[], s: Streak): string {
  if (items.length === 0) return '  殿の task は無い。';
  const mark: Record<Status, string> = {
    todo: '・',
    pending: '⏸',
    in_progress: '▶',
    done: '✓',
    dropped: '×',
  };
  const lines = items.map((i) => {
    const due = i.due ? ` 〆${i.due}` : '';
    const cat = i.category ? ` [${i.category}]` : '';
    return `  ${mark[i.status]} ${i.id.padEnd(8)} ${i.title.slice(0, 44)}${cat}${due}`;
  });
  const open = items.filter((i) => i.status !== 'done' && i.status !== 'dropped').length;
  lines.push('', `  残り ${open} / 全 ${items.length}　連続 ${s.current} 日（最長 ${s.longest}）`);
  return lines.join('\n');
}
