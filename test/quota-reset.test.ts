/**
 * 日付つき枠切れの旗と段梯子の試験。
 *
 * 眼目は刻が読めることではなく、**仕掛かりが焼かれぬこと**である。
 * 枠切れの pane へ段梯子が上がると、/clear が仕掛かりを焼いた上で
 * 空の prompt で固まる。日付つきの旗（codex・2026-09-20 採取）は
 * 従来の読み手では null となり、この守りが素通しになっておった。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  // 送る手は注ぎ替える。読み取り命は出るが、tmux への送信は行わぬ——
  // dryRun=false で実装の送信路を通しつつ、送られた中身は spy が受ける
  const spy = () => {
    const sent: { pane: string; text: string }[] = [];
    const sender = async (p: { pane?: { id: string } | null; text: string }) => {
      sent.push({ pane: p.pane?.id ?? '', text: p.text });
      return { ok: true as const };
    };
    return { sent, sender };
  };

  const fakeTmux = () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-reset-tmux-'));
    const trace = join(dir, 'trace');
    const executable = join(dir, 'tmux');
    writeFileSync(executable, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$HONDEN_TEST_TMUX_TRACE"',
      'if [ "$1" = "capture-pane" ]; then',
      "  printf '%s\\n' 'Working... (esc to interrupt)'",
      'fi',
    ].join('\n'));
    chmodSync(executable, 0o755);
    return {
      dir,
      trace,
      restore: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  test('段3の busy 判じは注いだ読み手を使い、実体の capture-pane を呼ばぬ', async () => {
    const path = join(tmpdir(), `quota-busy-reader-${Date.now()}.db`);
    const tmux = fakeTmux();
    try {
      const db = seeded(path);
      db.close();
      const source = `
        import { runNudge } from ${JSON.stringify(join(process.cwd(), 'src/main.ts'))};
        const paneReader = () => new Map([['ashigaru9', { id: ${JSON.stringify(FAKE_PANE)}, label: 'fake:agents.9' }]]);
        const sent = [];
        let busyReads = 0;
        const r = await runNudge(
          ${JSON.stringify(path)}, false, false, undefined, 'core', paneReader,
          () => { busyReads += 1; return false; },
          () => null,
          async (p) => { sent.push({ pane: p.pane?.id ?? '', text: p.text }); return { ok: true }; },
        );
        console.log(JSON.stringify({ code: r.code, busyReads, sent }));
      `;
      const child = Bun.spawnSync({
        cmd: [process.execPath, '-e', source],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${tmux.dir}:${process.env.PATH ?? ''}`,
          HONDEN_TEST_TMUX_TRACE: tmux.trace,
        },
      });
      expect(child.success).toBe(true);
      const result = JSON.parse(child.stdout.toString()) as {
        code: number;
        busyReads: number;
        sent: { text: string }[];
      };
      expect(result.code).toBe(0);
      const tmuxCalls = existsSync(tmux.trace) ? readFileSync(tmux.trace, 'utf8') : '';
      expect(tmuxCalls).not.toContain('capture-pane');
      expect(result.busyReads).toBe(1);
      expect(result.sent).toEqual([]); // busy でなくても、無応答なら消去前に確認へ回す
    } finally {
      tmux.restore();
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });

  test('陰性対照: 既定の busy 読み手は capture-pane で段3を止める', async () => {
    const path = join(tmpdir(), `quota-default-busy-${Date.now()}.db`);
    const tmux = fakeTmux();
    try {
      const db = seeded(path);
      db.close();
      const source = `
        import { runNudge } from ${JSON.stringify(join(process.cwd(), 'src/main.ts'))};
        const paneReader = () => new Map([['ashigaru9', { id: ${JSON.stringify(FAKE_PANE)}, label: 'fake:agents.9' }]]);
        const sent = [];
        const r = await runNudge(
          ${JSON.stringify(path)}, false, false, undefined, 'core', paneReader,
          undefined,
          () => null,
          async (p) => { sent.push({ pane: p.pane?.id ?? '', text: p.text }); return { ok: true }; },
        );
        console.log(JSON.stringify({ code: r.code, sent }));
      `;
      const child = Bun.spawnSync({
        cmd: [process.execPath, '-e', source],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${tmux.dir}:${process.env.PATH ?? ''}`,
          HONDEN_TEST_TMUX_TRACE: tmux.trace,
        },
      });
      expect(child.success).toBe(true);
      const result = JSON.parse(child.stdout.toString()) as { code: number; sent: { text: string }[] };
      expect(result.code).toBe(0);
      expect(readFileSync(tmux.trace, 'utf8')).toContain(`capture-pane -t ${FAKE_PANE} -p`);
      expect(result.sent.some((s) => s.text === '/new')).toBe(false);
    } finally {
      tmux.restore();
      try { unlinkSync(path); } catch { /* 消えておればよい */ }
    }
  });
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

  test('陰性対照: 旗が過ぎておれば通常の合図を撃つ', async () => {
    const path = join(tmpdir(), `quota-dated-past-${Date.now()}.db`);
    try {
      const db = seeded(path);
      // 通常の合図で比較する。無応答の段3は上役の確認待ちになる。
      db.run('UPDATE nudge SET since = ? WHERE agent = ?', [new Date().toISOString(), 'ashigaru9']);
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
      expect(sent[0]!.text).toContain('inbox_notice'); // 通常の合図は戻る
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
