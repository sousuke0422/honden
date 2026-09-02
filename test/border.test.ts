/**
 * 縁の任表示（乙）。器（pane-border-format）は出陣が敷いたが、
 * `@current_task` を書く者が居らなんだ——ここで芯の輪が書く。
 */
import { describe, expect, test } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { borderText, borderPlans } from '../src/border';
import type { TmuxRunner } from '../src/pane';

function camp() {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'x' },
      { id: 'karo', role: 'commander', cli: 'claude', model: 'x' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'x' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'x' },
    ]);
  });
  return db;
}

/** 印つきの贋 tmux。list-sessions / list-panes / set-option を写す。 */
function fake(cur: Record<string, string>): { run: TmuxRunner; sets: string[][] } {
  const sets: string[][] = [];
  const run: TmuxRunner = (args) => {
    if (args[0] === 'set-option') { sets.push(args); return ''; }
    if (args[0] === 'list-sessions') return 'honden-agents\t/w/honden\n';
    if (args[0] === 'list-panes' && args.includes('-a'))
      return Object.entries(cur).map(([p, c]) => `${p}\tashigaru1\t${c}`).join('\n');
    if (args[0] === 'list-panes') return `%1\thonden-agents:agents.1\tashigaru1\n`;
    return '';
  };
  return { run, sets };
}

describe('縁の文', () => {
  test('握っておる任だけ出る。済み・空は消える', () => {
    expect(borderText('subtask_2_mtjzu3g71pby', 'assigned')).toBe('subtask_2_mtjzu3g… [受]');
    expect(borderText('t1', 'in_progress')).toBe('t1 [進]');
    expect(borderText('t1', 'done')).toBe('');
    expect(borderText(null, null)).toBe('');
  });
});

describe('差分だけ書く', () => {
  const HOME = process.env.HONDEN_ROOT;
  test('縁が正本とずれた pane にだけ書く', () => {
    process.env.HONDEN_ROOT = '/w/honden';
    try {
      const db = camp();
      const c = createCmd(db, 'shogun', { north_star: 'x', purpose: 'x', acceptance_criteria: ['a'], command: 'x', project: 'p' });
      assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: c.id!, title: '調べよ' });
      const t = (db.query("SELECT task_id FROM task WHERE agent='ashigaru1'").get() as { task_id: string }).task_id;
      const f1 = fake({ '%1': '' });
      const p1 = borderPlans(db, f1.run);
      expect(p1).toHaveLength(1);
      expect(p1[0]!.value).toContain('[受]');
      // 既に縁が合っておれば書かぬ
      const f2 = fake({ '%1': p1[0]!.value });
      expect(borderPlans(db, f2.run)).toHaveLength(0);
    } finally {
      if (HOME === undefined) delete process.env.HONDEN_ROOT; else process.env.HONDEN_ROOT = HOME;
    }
  });
});
