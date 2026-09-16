import { describe, expect, test } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import { LEVEL_3_AFTER_MS, markSince, plan, record } from '../src/nudge';
import type { Pane } from '../src/pane';
import { hasLimitSignalText } from '../src/busy';
import { deferLimitResets } from '../src/main';

const T0 = new Date('2026-09-16T06:30:00Z');
const NOW = new Date(T0.getTime() + LEVEL_3_AFTER_MS);
const PANES = new Map<string, Pane>([
  ['ashigaru1', { id: '%4', label: 'honden:agents.1' }],
]);

const CLAUDE_LIMIT = "You've hit your session limit · resets 6:20pm (Asia/Tokyo)";
const CLAUDE_LOW_PRIORITY = '/low-priority continue now priority weekly limit';
const CODEX_LIMIT =
  "You've hit your usage limit. Upgrade to Pro, visit settings or try again at 5:55 AM.";

function seeded(cli: 'claude' | 'codex') {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'ashigaru1', role: 'worker', cli, model: null },
    ]);
    deliver(db, {
      id: `msg_${cli}`,
      agent: 'ashigaru1',
      at: T0.toISOString(),
      type: 'report_received',
      sender: 'gunshi',
      body: '検めあり',
    });
    markSince(db, 'ashigaru1', T0);
  });
  return db;
}

describe('枠の気配がある者の文脈を焼かぬ', () => {
  for (const [cli, capture] of [
    ['claude', CLAUDE_LIMIT],
    ['codex', CODEX_LIMIT],
  ] as const) {
    test(`${cli} の実文面では段3を素の合図へ降ろし、台帳へ理由を刻む`, () => {
      const db = seeded(cli);
      const before = plan(db, NOW, { panes: PANES });
      expect(before[0]!.level).toBe(3);
      expect(before[0]!.text).toMatch(/^\/(clear|new)$/);
      expect(hasLimitSignalText(capture, cli)).toBe(true);

      const after = deferLimitResets(db, before, new Set(['ashigaru1']), NOW, {
        wakeShogun: false,
        dryRun: false,
        decisionEvidence: new Map([
          ['ashigaru1', `cli=${cli} pane=honden:agents.1 recognized_limit_signal=true`],
        ]),
      });
      expect(after[0]!.level).toBe(2);
      expect(after[0]!.escalationLevel).toBe(3);
      expect(after[0]!.text).toContain('inbox_notice');
      expect(after[0]!.hardRecovery).toBe(false);
      const row = db
        .query("SELECT target, detail FROM ledger WHERE action = 'nudge.reset.deferred.limit'")
        .get() as { target: string; detail: string };
      expect(row.target).toBe('ashigaru1');
      expect(row.detail).toContain(`cli=${cli}`);
      expect(row.detail).toContain('recognized_limit_signal=true');
      expect(row.detail).toContain('文脈消しを見送った');
    });
  }

  test('常時表示の low-priority 案内では従来どおり段3へ届き、撃つ根拠も残る', () => {
    const db = seeded('claude');
    const before = plan(db, NOW, { panes: PANES });
    expect(hasLimitSignalText(CLAUDE_LOW_PRIORITY, 'claude')).toBe(false);
    const after = deferLimitResets(db, before, new Set(), NOW, {
      wakeShogun: false,
      dryRun: false,
      decisionEvidence: new Map([
        ['ashigaru1', 'cli=claude pane=honden:agents.1 recognized_limit_signal=false'],
      ]),
    });
    expect(after[0]!.level).toBe(3);
    expect(after[0]!.text).toBe('/clear');
    record(db, after[0]!, NOW);
    expect(db.query("SELECT 1 FROM ledger WHERE action = 'nudge.reset.deferred.limit'").get()).toBeNull();
    const sent = db.query("SELECT detail FROM ledger WHERE action = 'nudge.reset'").get() as { detail: string };
    expect(sent.detail).toContain('recognized_limit_signal=false');
  });
});
