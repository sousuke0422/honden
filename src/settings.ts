/**
 * 環境ごとの決め事の読み書き。
 *
 * 正本の `setting` 表を薄く包む。設定ファイルへ置かないのは、
 * 書き換えても走っておるものが拾わないため（mode と同じ理由）。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';
import { dirname, join, resolve } from 'node:path';

/** kagemusha の根の既定。submodule として置いてある所。 */
export const DEFAULT_NORMS_ROOT = 'kagemusha';

export function getSetting(db: Database, key: string): string | null {
  const r = db.query('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string, by?: string): void {
  db.prepare(
    `INSERT INTO setting(key, value, at, by) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at, by = excluded.by`,
  ).run(key, value, new Date().toISOString(), by ?? null);
  journal(db, { actor: by ?? '不明', action: `setting.${key}`, target: value, detail: '' });
}

/**
 * 規約の棚の在り処。
 *
 * 決めてなければ、この実装の隣の `kagemusha/` を見る。
 * submodule として置いてあるので、通常はそれで足りる。
 */
export function normsRoot(db: Database): string {
  const set = getSetting(db, 'norms_root');
  if (set) return set;
  // import.meta.dir は src/ を指す。その親が実装の根。
  return resolve(join(dirname(import.meta.dir), DEFAULT_NORMS_ROOT));
}
