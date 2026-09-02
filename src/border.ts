/**
 * pane の縁に、いま握っておる任を出す（乙・旧環境の pane-border 表示の移植）。
 *
 * 出陣は縁の形（`#{@agent_id} (#{@model_name}) #{@current_task}`）だけを敷き、
 * `@current_task` は空のまま誰も書いておらなんだ——**器だけあって水が無い**。
 * 書くのは芯の輪（nudge）である。60 秒ごとに正本と縁を突き合わせ、
 * 変わった pane にだけ書く（毎回全部へ書くと tmux が無駄に描き直す）。
 */
import type { Database } from 'bun:sqlite';
import { panes as livePanes, type TmuxRunner } from './pane';

/** 縁に出す短い文。空 = 消す。 */
export function borderText(taskId: string | null, status: string | null): string {
  if (!taskId || !status) return '';
  // 済んだ・寝かせた任は縁に出さぬ。縁は「いま何を握っておるか」の場である
  if (status !== 'assigned' && status !== 'in_progress') return '';
  // 縁は狭い。subtask_2_mtjzu3g71pby → subtask_2 のような頭だけで足りる
  const short = taskId.length > 18 ? taskId.slice(0, 17) + '…' : taskId;
  return `${short} [${status === 'in_progress' ? '進' : '受'}]`;
}

/** 書くべき差分。試験は run を注ぎ替えて叩く。 */
export function borderPlans(
  db: Database,
  run: TmuxRunner,
): { pane: string; value: string }[] {
  const rows = db
    .query("SELECT agent, task_id, status FROM task")
    .all() as { agent: string; task_id: string | null; status: string | null }[];
  const want = new Map<string, string>();
  for (const r of rows) want.set(r.agent, borderText(r.task_id, r.status));

  const out: { pane: string; value: string }[] = [];
  const seen = run(['list-panes', '-a', '-F', '#{pane_id}\t#{@agent_id}\t#{@current_task}']);
  if (seen === null) return out; // tmux が居らぬなら書く先も無い
  const known = livePanes(undefined, run); // 印で絞った我らの pane（他陣の縁を汚さぬ）
  const ours = new Set([...known.values()].map((p) => p.id));
  for (const line of seen.split('\n')) {
    const [pane, agent, cur] = line.split('\t');
    if (!pane || !agent || !ours.has(pane)) continue;
    const v = want.get(agent.trim());
    if (v === undefined) continue; // 名簿に無い者の縁は触らぬ
    if ((cur ?? '') !== v) out.push({ pane, value: v });
  }
  return out;
}

/** 差分を書く。失敗は黙って流す——縁は飾りで、合図の輪を落とす価値が無い。 */
export function applyBorders(db: Database, run: TmuxRunner): number {
  const plans = borderPlans(db, run);
  for (const p of plans) run(['set-option', '-p', '-t', p.pane, '@current_task', p.value]);
  return plans.length;
}
