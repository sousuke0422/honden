/**
 * 正本の写し。
 *
 * 正本は SQLite 一つ——**一つ壊れれば全てを失う**器である。旧環境は
 * `--clean` のたび `logs/backup_*` へ queue を退避していたが、honden には
 * 写しの仕掛けが無かった（切り替え前の総点検で発覚・2026-08-29）。
 *
 * `VACUUM INTO` で写す。生きた正本から、錠を止めずに、断片も詰めて一枚に
 * 焼ける——cp と違い、書き込み途中の姿を写す恐れが無い。
 *
 * 保持は世代で刈る。写しが無限に育てば、写しが正本を圧迫する本末転倒になる。
 */
import type { Database } from 'bun:sqlite';
import { readdirSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const KEEP_DEFAULT = 10;

/** 写しの名。時刻で並び、時刻で刈れる。 */
export function backupName(now: Date): string {
  return `honden-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
}

export function backup(
  db: Database,
  dir: string,
  now: Date = new Date(),
  keep: number = KEEP_DEFAULT,
): { path: string; bytes: number; pruned: string[] } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, backupName(now));
  // VACUUM INTO は既存ファイルには焼けぬ。名に秒まで入れて衝突を避ける。
  db.run(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const bytes = statSync(path).size;

  // 古い写しを刈る（名前順 = 時刻順）。
  const all = readdirSync(dir)
    .filter((f) => /^honden-.*\.db$/.test(f))
    .sort();
  const pruned: string[] = [];
  while (all.length > keep) {
    const victim = all.shift()!;
    unlinkSync(join(dir, victim));
    pruned.push(basename(victim));
  }
  return { path, bytes, pruned };
}
