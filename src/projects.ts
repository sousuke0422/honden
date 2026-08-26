/**
 * 案件の所在。
 *
 * 現行 `config/projects.yaml` を写す。場所が書かれずに振られた時、ここから補う。
 * 無ければ補わない——「無いなら無いでよい」（殿下知 2026-08-26）。
 *
 * ## path が実体とは限らない
 *
 * `work_location: coder` の案件は、`path` (WSL) が参照専用で、実体は Coder の中。
 * 素直に `path` を補うと、**押せぬ場所を握らせる**。
 * 現行でも足軽が二度これで失敗している (cmd_266, cmd_273 — WSL で作業して push 403)。
 *
 * ゆえに補う値は `path` ではなく「働く場所」にする。
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { journal } from './store';

export class ProjectError extends Error {}

export interface ProjectEntry {
  id: string;
  path: string | null;
  workLocation: string | null;
  coderWorkspace: string | null;
  coderWorkdir: string | null;
  status: string | null;
  raw: string;
}

export function readProjectsFromFile(path: string): ProjectEntry[] {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ProjectError(`${path} を YAML として読めぬ: ${String(e).slice(0, 160)}`);
  }
  const list = (doc as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) {
    throw new ProjectError(`${path} に projects の一覧が無い。所在の出所が要る。`);
  }
  const out: ProjectEntry[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'] : '';
    if (id === '') continue;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
    out.push({
      id,
      path: str('path'),
      workLocation: str('work_location'),
      coderWorkspace: str('coder_workspace'),
      coderWorkdir: str('coder_workdir'),
      status: str('status'),
      raw: JSON.stringify(o),
    });
  }
  return out;
}

export function syncProjects(db: Database, entries: ProjectEntry[], actor = 'projects'): void {
  db.run('DELETE FROM project');
  const ins = db.prepare(
    'INSERT INTO project(id, path, work_location, coder_workspace, coder_workdir, status, raw) VALUES (?,?,?,?,?,?,?)',
  );
  for (const e of entries) {
    ins.run(e.id, e.path, e.workLocation, e.coderWorkspace, e.coderWorkdir, e.status, e.raw);
  }
  journal(db, { actor, action: 'projects.sync', target: `${entries.length}件`, detail: entries.map((e) => e.id).join(',') });
}

export function projects(db: Database): ProjectEntry[] {
  return (
    db
      .query(
        'SELECT id, path, work_location workLocation, coder_workspace coderWorkspace, coder_workdir coderWorkdir, status, raw FROM project ORDER BY id',
      )
      .all() as ProjectEntry[]
  );
}

export interface WorkRoot {
  /** 取り置きに使う値。 */
  value: string;
  /** なぜその値になったか。振った者へ見せる。 */
  why: string;
}

/**
 * その案件で働く場所。
 *
 * `path` をそのまま返さない。`work_location` が実体の在り処を言っている。
 * 休眠中 (`status: standby`) の案件は補わない——平時に使ってはならぬ枠ゆえ。
 */
export function workRootOf(db: Database, id: string): WorkRoot | null {
  const p = db
    .query(
      'SELECT id, path, work_location workLocation, coder_workspace coderWorkspace, coder_workdir coderWorkdir, status FROM project WHERE id = ?',
    )
    .get(id) as ProjectEntry | null;
  if (!p) return null;
  if (p.status === 'standby') return null;

  if (p.workLocation === 'coder') {
    if (!p.coderWorkspace || !p.coderWorkdir) return null;
    return {
      value: `coder:${p.coderWorkspace}:${p.coderWorkdir}`,
      why: `${id} は work_location: coder ゆえ、実体は Coder の中。WSL の path は参照専用である`,
    };
  }
  if (!p.path) return null;
  return { value: p.path, why: `${id} の所在から補った` };
}
