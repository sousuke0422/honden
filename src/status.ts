/**
 * 布陣の様子を一枚に並べる。
 *
 * 旧 scripts/agent_status.sh（258 行・bash + python + yaml）の移植。
 * だが honden では**書き直すほどのものが無い**——並べる値はすべて
 * 正本と busy の見立てに既に在る:
 *
 *   顔ぶれ・CLI・模型   roster 表
 *   pane の在り処        tmux（src/pane.ts）
 *   手が塞がっておるか   pane を写して見立てる（src/busy.ts）
 *   任と其の様           task 表
 *   持ち場の貸与         lease（期限切れの印つき）
 *   未読と急ぎ           inbox 表
 *
 * 旧は task YAML と inbox YAML を python で開いて読んでいた。
 * 正本を一つに寄せた今、開く先も一つである。
 */
import type { Database } from 'bun:sqlite';
import { roster } from './roster';
import { summarize } from './inbox';
import { panes, type Pane } from './pane';
import { captureBusy } from './busy';
import { leaseState } from './lease';

export interface Row {
  agent: string;
  role: string;
  cli: string | null;
  model: string | null;
  pane: string | null;
  busy: boolean | null;
  taskId: string | null;
  taskStatus: string;
  lease: 'held' | 'expired' | 'free';
  unread: number;
  urgent: boolean;
}

export function collect(
  db: Database,
  opts: { panes?: Map<string, Pane>; busy?: (p: Pane, cli: string | null) => boolean; now?: Date } = {},
): Row[] {
  const p = opts.panes ?? panes();
  const isBusy = opts.busy ?? captureBusy;
  const now = opts.now ?? new Date();

  return roster(db).map((e) => {
    const pane = p.get(e.id);
    const t = db
      .query('SELECT task_id, status, holder, lease_until FROM task WHERE agent = ?')
      .get(e.id) as { task_id: string | null; status: string; holder: string | null; lease_until: string | null } | null;
    const s = summarize(db, e.id);
    return {
      agent: e.id,
      role: e.role,
      cli: e.cli,
      model: e.model,
      pane: pane?.label ?? null,
      // pane が無ければ見立てようが無い。false（手すき）と言い切らぬ——
      // 「居らぬ」と「手すき」は別物である。
      busy: pane ? isBusy(pane, e.cli) : null,
      taskId: t?.task_id ?? null,
      taskStatus: t?.status ?? 'idle',
      lease: t ? leaseState({ holder: t.holder, leaseUntil: t.lease_until }, now) : 'free',
      unread: s.total,
      urgent: s.urgent,
    };
  });
}

export function render(rows: Row[]): string {
  // 全角を 2 と数える。揃わぬ表は読む気を削ぐ。
  const width = (s: string) =>
    [...s].reduce((a, ch) => a + (/[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1), 0);
  /** n 桁へ収める。**溢れたら削る**——溢れさせると以降の桁が全て崩れる。 */
  const pad = (s: string, n: number) => {
    let t = s;
    if (width(t) > n - 1) {
      const chars = [...t];
      let w = 0;
      const kept: string[] = [];
      for (const ch of chars) {
        const cw = /[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1;
        if (w + cw > n - 2) break;
        kept.push(ch);
        w += cw;
      }
      t = kept.join('') + '…';
    }
    return t + ' '.repeat(Math.max(0, n - width(t)));
  };
  const head =
    '  ' + pad('名', 11) + pad('役', 8) + pad('CLI', 9) + pad('様', 8) + pad('任', 26) + pad('持ち場', 10) + '未読';
  const line = '  ' + '─'.repeat(76);
  const body = rows.map((r) => {
    const state = r.pane === null ? '不在' : r.busy ? '働中' : '待機';
    const lease = r.lease === 'expired' ? '★期限切' : r.lease === 'held' ? '握中' : '空き';
    const unread = r.unread === 0 ? '—' : `${r.unread}${r.urgent ? ' ⚠急' : ''}`;
    return (
      '  ' +
      pad(r.agent, 11) +
      pad(r.role === 'commander' ? '差配' : '働き', 8) +
      pad(r.cli ?? '—', 9) +
      pad(state, 8) +
      pad(r.taskId ? `${r.taskId} ${r.taskStatus}` : r.taskStatus, 26) +
      pad(lease, 10) +
      unread
    );
  });
  return [head, line, ...body].join('\n');
}
