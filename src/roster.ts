/**
 * 顔ぶれ。
 *
 * 布陣は環境ごとに大きさが違う。投資分析用の環境 (fshogun) は足軽 7 体を
 * 要さないし、2 体で足りるなら 2 体で回る。だから名簿を固定で持たない。
 *
 * 役職の名そのものは変わらない。変わるのは足軽の頭数だけで、上限が 7。
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { journal } from './store';

/** 上役。環境が変わっても、この 3 つは変わらない。 */
export const COMMANDERS = ['shogun', 'karo', 'gunshi'] as const;

/** 足軽の上限。これを超える名簿は受け付けない。 */
export const MAX_WORKERS = 7;

const WORKER_RE = /^ashigaru([1-9][0-9]*)$/;

export interface RosterEntry {
  id: string;
  role: 'commander' | 'worker';
  cli: string | null;
  model: string | null;
}

export class RosterError extends Error {}

/** 名を役へ振り分ける。振り分けられない名は受け付けない。 */
export function roleOf(id: string): 'commander' | 'worker' {
  if ((COMMANDERS as readonly string[]).includes(id)) return 'commander';
  const m = WORKER_RE.exec(id);
  if (!m) {
    throw new RosterError(
      `名簿に置けぬ名: ${JSON.stringify(id)}\n` +
        `  上役は ${COMMANDERS.join(' / ')} のいずれか。足軽は ashigaru1 から ashigaru${MAX_WORKERS}。`,
    );
  }
  const n = Number(m[1]);
  if (n < 1 || n > MAX_WORKERS) {
    throw new RosterError(
      `足軽の番号が範囲の外: ${id}\n  ashigaru1 から ashigaru${MAX_WORKERS} まで。`,
    );
  }
  return 'worker';
}

/**
 * 環境の settings.yaml から名簿を読む。
 *
 * 出所は `cli.agents`。鍵がそのまま顔ぶれになる。
 */
export function readRosterFromSettings(path: string): RosterEntry[] {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new RosterError(`${path} を YAML として読めぬ: ${String(e).slice(0, 160)}`);
  }
  const agents = (doc as { cli?: { agents?: Record<string, unknown> } })?.cli?.agents;
  if (!agents || typeof agents !== 'object') {
    throw new RosterError(`${path} に cli.agents が無い。名簿の出所が要る。`);
  }

  const out: RosterEntry[] = [];
  for (const [id, v] of Object.entries(agents)) {
    const spec = (v ?? {}) as { type?: unknown; model?: unknown };
    out.push({
      id,
      role: roleOf(id),
      cli: typeof spec.type === 'string' ? spec.type : null,
      model: typeof spec.model === 'string' ? spec.model : null,
    });
  }

  // 頭数の検査はここに置かない。名が ashigaru1 から ashigaru7 に限られる以上、
  // 8 体目は roleOf の時点で弾かれる。同じ制約を 2 箇所に書くと、
  // 片方が到達不能になり、後から読む者を惑わせる。
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 名簿を入れ替える。
 *
 * 足すのではなく入れ替える。足軽を減らした環境で、消したはずの名が
 * 残り続けると、居ない相手へ送れてしまう。
 *
 * 取引の中から呼ぶこと。
 */
export function syncRoster(db: Database, entries: RosterEntry[], actor = 'roster'): void {
  const before = (db.query('SELECT id FROM roster').all() as { id: string }[]).map((r) => r.id);
  db.run('DELETE FROM roster');
  const ins = db.prepare('INSERT INTO roster(id, role, cli, model) VALUES (?,?,?,?)');
  for (const e of entries) ins.run(e.id, e.role, e.cli, e.model);

  const after = entries.map((e) => e.id);
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (added.length || removed.length) {
    journal(db, {
      actor,
      action: 'roster.sync',
      target: `${after.length}人`,
      detail: `added=[${added.join(',')}] removed=[${removed.join(',')}]`,
    });
  }
}

/** いまの名簿。 */
export function roster(db: Database): RosterEntry[] {
  return db.query('SELECT id, role, cli, model FROM roster ORDER BY id').all() as RosterEntry[];
}

/** 名簿に載っている名か。 */
export function isKnown(db: Database, id: string): boolean {
  return (
    (db.query('SELECT count(*) c FROM roster WHERE id = ?').get(id) as { c: number }).c > 0
  );
}

/** 名簿が空か。空なら書かせない。 */
export function isEmpty(db: Database): boolean {
  return (db.query('SELECT count(*) c FROM roster').get() as { c: number }).c === 0;
}
