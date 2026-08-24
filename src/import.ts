/**
 * shogun 側の YAML を正本へ取り込む。
 *
 * ## 何度も走ることを前提にする
 *
 * honden が単体で動くまで、shogun は現役のまま動き続ける。その間ずっと、
 * 取り込みは繰り返し走る。だから一度きりの移行として書いてはならない。
 *
 * - ファイルの sha256 が変わっていなければ触らない
 * - 変わっていれば、そのファイル由来の doc を**消してから**入れ直す
 *   (足すだけにすると二度目で重複が積もる。索引側も同じ)
 * - 取り込み自体は何度走らせても結果が同じになる
 *
 * ## 読めないものの扱い
 *
 * 黙って飛ばさない。飛ばしたことが残らなければ、取り込みが「全部入った」ように
 * 見える。だが 1 本読めないだけで全体を止めると、繰り返しの取り込みが成立しない。
 *
 * なので「import_issue に記録して続け、最後に非ゼロで終わる」。
 * 記録が残るので、後から `SELECT * FROM import_issue` で名指しできる。
 */

import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { indexDoc, journal, tx } from './store';

export interface ImportResult {
  scanned: number;
  imported: number;
  skipped: number; // sha256 が同じで触らなかったもの
  /** この回で当たったもの。 */
  issues: { path: string; kind: string; detail: string }[];
  /**
   * いま残っている難ありの総数 (import_issue の行数)。
   *
   * `issues` だけを見てはならない。sha256 が変わっていないファイルは素通りするので、
   * 2 回目以降は当たった件数が減る。1 回目に 8 件出たものが 2 回目は 1 件に見えて、
   * 残り 7 件はそのままそこに在る、という形になる。
   * 「難ありが有るか」の判断はこちらを使うこと。
   */
  outstanding: number;
}

/** YAML ファイルを再帰的に集める。 */
export function collectYaml(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 取り込み元の path から kind を決める。 */
function kindOf(rel: string): string {
  if (rel.includes('archive')) return 'archive';
  if (rel.startsWith('queue/inbox/')) return 'inbox';
  if (rel.startsWith('queue/reports/')) return 'report';
  if (rel.startsWith('queue/tasks/')) return 'task';
  if (rel.startsWith('queue/metrics/')) return 'metric';
  if (rel.startsWith('queue/')) return 'cmd';
  if (rel.startsWith('saytask/')) return 'saytask';
  if (rel.startsWith('config/')) return 'config';
  return 'other';
}

const sha256 = (s: string): string =>
  new Bun.CryptoHasher('sha256').update(s).digest('hex');

/**
 * 1 ファイルを取り込む。
 *
 * 戻り値の `changed` が false なら、内容が前回と同じで何もしていない。
 */
export function importFile(
  db: Database,
  root: string,
  path: string,
): { changed: boolean; issue?: { kind: string; detail: string } } {
  const rel = relative(root, path).split('\\').join('/');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { changed: false, issue: { kind: 'encoding', detail: String(e).slice(0, 200) } };
  }

  // NUL が混じっていると YAML としても git としても壊れる。
  // 実データで 1 本見つかったので、形として検出できるようにしておく。
  const nul = (text.match(/\0/g) ?? []).length;
  if (nul > 0) {
    return { changed: false, issue: { kind: 'encoding', detail: `NUL バイトが ${nul} 個` } };
  }

  const hash = sha256(text);
  const prev = db.query('SELECT sha256 FROM source WHERE path = ?').get(rel) as
    | { sha256: string }
    | null;
  if (prev?.sha256 === hash) return { changed: false };

  const kind = kindOf(rel);
  // YAML として読めるかは記録するが、読めなくても本文は取り込む。
  // 全文検索から引ける状態にしておくことのほうが、構造化より先に効く。
  let shape = 'ok';
  try {
    Bun.YAML.parse(text);
  } catch {
    shape = 'unparsed';
  }

  tx(db, () => {
    // 前回ぶんを消してから入れ直す。足すだけにすると二度目で重複する。
    const olds = (db.query('SELECT id FROM doc WHERE source = ?').all(rel) as { id: number }[]).map(
      (r) => r.id,
    );
    for (const id of olds) {
      db.prepare('DELETE FROM doc_fts WHERE doc_id = ?').run(id);
      db.prepare('DELETE FROM doc WHERE id = ?').run(id);
    }
    indexDoc(db, { kind, source: rel, at: statSync(path).mtime.toISOString(), body: text });
    db.prepare(
      `INSERT INTO source(path, sha256, bytes, imported_at, doc_count) VALUES (?,?,?,?,1)
       ON CONFLICT(path) DO UPDATE SET
         sha256 = excluded.sha256, bytes = excluded.bytes,
         imported_at = excluded.imported_at, doc_count = excluded.doc_count`,
    ).run(rel, hash, Buffer.byteLength(text), new Date().toISOString());
    db.prepare('DELETE FROM import_issue WHERE path = ?').run(rel);
    journal(db, {
      actor: 'import',
      action: prev ? 'source.update' : 'source.add',
      target: rel,
      detail: `kind=${kind} shape=${shape}`,
    });
  });

  return shape === 'ok'
    ? { changed: true }
    : { changed: true, issue: { kind: 'parse', detail: 'YAML として読めない (本文は取り込み済み)' } };
}

/** ディレクトリ配下をまとめて取り込む。 */
export function importTree(db: Database, root: string, subdirs: string[]): ImportResult {
  const res: ImportResult = { scanned: 0, imported: 0, skipped: 0, issues: [], outstanding: 0 };
  for (const sub of subdirs) {
    for (const path of collectYaml(join(root, sub))) {
      res.scanned++;
      const rel = relative(root, path).split('\\').join('/');
      const r = importFile(db, root, path);
      if (r.changed) res.imported++;
      else if (!r.issue) res.skipped++;
      if (r.issue) {
        res.issues.push({ path: rel, ...r.issue });
        tx(db, () => {
          db.prepare(
            `INSERT INTO import_issue(path, at, kind, detail) VALUES (?,?,?,?)
             ON CONFLICT(path) DO UPDATE SET
               at = excluded.at, kind = excluded.kind, detail = excluded.detail`,
          ).run(rel, new Date().toISOString(), r.issue!.kind, r.issue!.detail);
        });
      }
    }
  }
  res.outstanding = (db.query('SELECT count(*) c FROM import_issue').get() as { c: number }).c;
  return res;
}
