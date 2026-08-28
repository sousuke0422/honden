/**
 * 切り戻しの綱 — 正本を旧環境の YAML へ書き出す。
 *
 * **やりたくて作るのではない**（殿の言・2026-08-29）。honden から旧環境へ
 * 戻る日のための綱である。常時の書き戻し（併走）は作らぬ——書き手が二人に
 * なれば、どちらが正か分からなくなる（src/main.ts の決め）。これは
 * **切り戻す瞬間に一度だけ吐く**одно方向の写しである。
 *
 * 吐く先は必ず新しい場所（--out）。生きた queue/ へ直接は書かぬ——
 * 上書き事故を作らぬため、配置は人の手で行う。
 *
 * 形は旧環境の実ファイルに合わせる（import の逆向き）:
 *   queue/tasks/{agent}.yaml           一件のフラット YAML
 *   queue/inbox/{agent}.yaml           messages: [{content, from, id, read, timestamp, type}]
 *   queue/reports/{agent}_report.yaml  {worker_id, task_id, status, timestamp, result:{summary}}
 *   queue/shogun_to_karo.yaml          cmds: [{id, …, acceptance_criteria: []}]
 */
import type { Database } from 'bun:sqlite';

const yaml = (v: unknown): string => Bun.YAML.stringify(v, null, 2) + '\n';

export interface ExportedFile {
  path: string;
  body: string;
}

export function exportAll(db: Database): ExportedFile[] {
  const out: ExportedFile[] = [];

  // ── 司令 ──
  const cmds = db
    .query('SELECT id, created_at, north_star, purpose, body, project, priority, status, assigned_to FROM cmd ORDER BY created_at')
    .all() as { id: string; created_at: string; north_star: string | null; purpose: string | null; body: string | null; project: string | null; priority: string; status: string; assigned_to: string | null }[];
  const crit = db.prepare('SELECT text FROM cmd_acceptance WHERE cmd_id = ? ORDER BY idx');
  out.push({
    path: 'queue/shogun_to_karo.yaml',
    body: yaml({
      cmds: cmds.map((c) => ({
        id: c.id,
        timestamp: c.created_at,
        north_star: c.north_star ?? '',
        purpose: c.purpose ?? '',
        acceptance_criteria: (crit.all(c.id) as { text: string }[]).map((r) => r.text),
        command: c.body ?? '',
        project: c.project ?? '',
        priority: c.priority,
        status: c.status,
      })),
    }),
  });

  // ── 受け渡し ──
  const agents = (db.query('SELECT id FROM roster ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  for (const a of agents) {
    const msgs = db
      .query('SELECT id, created_at, msg_type, sender, body, read FROM inbox WHERE agent = ? ORDER BY created_at')
      .all(a) as { id: string; created_at: string; msg_type: string; sender: string; body: string; read: number }[];
    out.push({
      path: `queue/inbox/${a}.yaml`,
      body: yaml({
        messages: msgs.map((m) => ({
          content: m.body,
          from: m.sender,
          id: m.id,
          read: m.read === 1,
          timestamp: m.created_at,
          type: m.msg_type,
        })),
      }),
    });
  }

  // ── 任 ──
  const tasks = db
    .query('SELECT agent, task_id, status, cmd_id, updated_at, raw FROM task WHERE task_id IS NOT NULL')
    .all() as { agent: string; task_id: string; status: string; cmd_id: string | null; updated_at: string; raw: string }[];
  for (const t of tasks) {
    let extra: Record<string, unknown> = {};
    try {
      extra = JSON.parse(t.raw) as Record<string, unknown>;
    } catch {
      /* raw が読めずとも骨は吐ける */
    }
    out.push({
      path: `queue/tasks/${t.agent}.yaml`,
      body: yaml({
        task_id: t.task_id,
        parent_cmd: t.cmd_id ?? '',
        worker_id: t.agent,
        status: t.status,
        assigned_at: t.updated_at,
        title: (extra['title'] as string) ?? '',
        ...(extra['workspace'] ? { workdir: extra['workspace'] } : {}),
        ...(extra['branch'] ? { branch: extra['branch'] } : {}),
        ...(extra['bloom'] ? { bloom_level: extra['bloom'] } : {}),
      }),
    });
  }

  // ── 報告（agent ごとに最新の一件。旧環境は一枚に最新を上書きする流儀）──
  for (const a of agents) {
    const r = db
      .query(
        `SELECT task_id, cmd_id, created_at, raw FROM report
         WHERE agent = ? AND origin = 'native' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(a) as { task_id: string | null; cmd_id: string | null; created_at: string | null; raw: string } | null;
    if (!r) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(r.raw) as Record<string, unknown>;
    } catch {
      /* 生のまま summary へ */
    }
    out.push({
      path: `queue/reports/${a}_report.yaml`,
      body: yaml({
        worker_id: a,
        task_id: r.task_id ?? '',
        parent_cmd: r.cmd_id ?? '',
        status: (parsed['status'] as string) ?? 'done',
        timestamp: r.created_at ?? '',
        result: { summary: (parsed['summary'] as string) ?? r.raw },
      }),
    });
  }

  return out;
}
