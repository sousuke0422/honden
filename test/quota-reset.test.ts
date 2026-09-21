/**
 * 日付つき枠切れの旗と段梯子の試験。
 *
 * 眼目は刻が読めることではなく、**仕掛かりが焼かれぬこと**である。
 * 枠切れの pane へ段梯子が上がると、/clear が仕掛かりを焼いた上で
 * 空の prompt で固まる。日付つきの旗（codex・2026-09-20 採取）は
 * 従来の読み手では null となり、この守りが素通しになっておった。
 */
import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { deliver } from '../src/inbox';
import { limitedWaitMs } from '../src/busy';
import { runNudge } from '../src/main';

// 実物の字面（2026-09-20 採取・ashigaru3 の pane・codex）を含む pane の写し
const DATED_PANE =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing)\n" +
  '  or visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 21st, 2026 12:03 AM.\n';

function seeded(path: string) {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'ashigaru9', role: 'worker', cli: 'codex', model: null },
    ]);
  });
  // 未読を抱えさせる（撃つ理由を作る）
  deliver(db, {
    id: 'msg_test_quota_1',
    agent: 'ashigaru9',
    at: new Date(Date.now() - 10 * 60_000).toISOString(),
    type: 'task_assigned',
    sender: 'karo',
    body: '試料の任',
  });
  // 未読を 10 分抱えた覚え——段 3（文脈消し）へ届く経ち
  db.run('INSERT INTO nudge(agent, since) VALUES (?, ?)', [
    'ashigaru9',
    new Date(Date.now() - 10 * 60_000).toISOString(),
  ]);
  return db;
}

describe('枠切れの相手へ段梯子を上げぬ（日付つきの旗）', () => {
  // 実在しえぬ pane 番号を使う。実陣の pane 番号（%9 等）を書けば、
  // どこかの守りが破れた時に本物の pane へ命が飛ぶ——番号の側でも塞ぐ
  const FAKE_PANE = '%2147483647';
  const paneReader = () => new Map([['ashigaru9', { id: FAKE_PANE, label: 'fake:agents.9' }]]);
  // 実物の旗を実際の読み手（limitedWaitMs）へ通す。刻は採取当夜 21:00 に固定
  const limitedReader = () => limitedWaitMs(DATED_PANE, new Date(2026, 8, 20, 21, 0));
  // 送る手は注ぎ替える。試験は tmux へ一つも命を出さぬ——
  // dryRun=false で実装の送信路を通しつつ、送られた中身は spy が受ける
  const spy = () => {
    const sent: { pane: string; text: string }[] = [];
    const sender = async (p: { pane?: { id: string } | null; text: string }) => {
      sent.push({ pane: p.pane?.id ?? '', text: p.text });
      return { ok: true as const };
    };
    return { sent, sender };
  };

  test('nudge は撃たず、段も覚えも進まず、文脈消しへ進まぬ', async () => {
    const path = join(tmpdir(), `quota-dated-${Date.now()}.db`);
    try {
      const db = seeded(path);
      const { sent, sender } = spy();
      const r = await runNudge(path, false, false, undefined, 'core', paneReader, () => false, limitedReader, sender);
      expect(r.code).toBe(0);
      // 撃たぬ——理由に使用枠が出て、送る手は一度も呼ばれぬ
      expect(r.out).toContain('使用枠が尽きておる');
      expect(r.out).toContain('撃たぬ');
      expect(r.out).toContain('再訪'); // 明けの刻の直後に見に戻る
      expect(sent).toEqual([]);
      // 段の覚えが進んでおらぬ（record が呼ばれておらぬ）
      const row = db
        .query('SELECT last_level, last_reset_at FROM nudge WHERE agent = ?')
        .get('ashigaru9') as { last_level: number | null; last_reset_at: string | null };
      expect(row.last_level).toBeNull();
      expect(row.last_reset_at).toBeNull();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('陰性対照: 旗が過ぎておれば従来どおり撃つ——「いつも待つ」に倒れぬ', async () => {
    const path = join(tmpdir(), `quota-dated-past-${Date.now()}.db`);
    try {
      const db = seeded(path);
      // 同じ実物の旗を、明けた後（09-22 09:00）の刻で読む——scroll-back の残骸
      const pastReader = () => limitedWaitMs(DATED_PANE, new Date(2026, 8, 22, 9, 0));
      expect(pastReader()).toBeNull(); // 前提の確認: 旗はもう枠切れと読まれぬ
      const { sent, sender } = spy();
      const r = await runNudge(path, false, false, undefined, 'core', paneReader, () => false, pastReader, sender);
      expect(r.code).toBe(0);
      // 梯子は動く——「使用枠」で据え置かれず、送信まで進む。
      // 何番の pane へ何を送ろうとしたかまで spy で検める
      expect(r.out).not.toContain('使用枠が尽きておる');
      expect(r.out).not.toContain('撃たぬ');
      expect(r.out).toContain('撃った');
      expect(sent.length).toBe(1);
      expect(sent[0]!.pane).toBe(FAKE_PANE);
      expect(sent[0]!.text).toBe('/new'); // 段 3・codex の文脈消し
      // 段の覚えが進む（record が呼ばれた）
      const row = db
        .query('SELECT last_level FROM nudge WHERE agent = ?')
        .get('ashigaru9') as { last_level: number | null };
      expect(row.last_level).not.toBeNull();
      db.close();
    } finally {
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
});
