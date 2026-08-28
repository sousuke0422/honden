/**
 * 許状の試験。五重の縛りを一つずつ落として検める:
 * agent・cmd（閉じれば死ぬ）・的（repo/verb）・回数（尽きれば落ちる）・刻。
 */
import { describe, expect, test } from 'bun:test';
import { openStore, tx } from '../src/store';
import { createCmd } from '../src/dispatch';
import { issueCharter, findCharter, useCharter, revokeCharter, listCharters } from '../src/charter';

const NOW = new Date('2026-08-29T12:00:00Z');
const TTL = 60 * 60_000;

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  const made = createCmd(db, 'shogun', {
    north_star: '北極星',
    purpose: '許状の的になる cmd',
    acceptance_criteria: ['一つ'],
    command: '本文',
    project: 'honden',
  });
  if (!made.ok) throw new Error(made.message);
  const cmd = (db.query('SELECT id FROM cmd').get() as { id: string }).id;
  return { db, cmd };
};

const grant = (db: ReturnType<typeof openStore>, cmd: string, over: Record<string, unknown> = {}) =>
  tx(db, () =>
    issueCharter(
      db,
      { agent: 'ashigaru1', cmdId: cmd, repo: 'o/r', verb: 'create', uses: 2, issuer: 'shogun', reason: '個数が多い', ...over } as never,
      NOW,
      TTL,
    ),
  );

describe('issueCharter', () => {
  test('開いた cmd へは切れる・閉じた cmd へは切れぬ', () => {
    const { db, cmd } = seeded();
    expect(grant(db, cmd).ok).toBe(true);
    db.prepare("UPDATE cmd SET status = 'done' WHERE id = ?").run(cmd);
    const r = grant(db, cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('開いておらぬ');
    expect(grant(db, 'cmd_無い').ok).toBe(false);
  });

  test('repo の形と verb と回数を検める', () => {
    const { db, cmd } = seeded();
    expect(grant(db, cmd, { repo: 'まがい物' }).ok).toBe(false);
    expect(grant(db, cmd, { verb: 'delete' }).ok).toBe(false);
    expect(grant(db, cmd, { uses: 0 }).ok).toBe(false);
    expect(grant(db, cmd, { uses: 999 }).ok).toBe(false);
  });
});

describe('切れる者・取り消せる者', () => {
  test('将軍以外は切れぬ（CLI の門でなく芯で止める）', () => {
    const { db, cmd } = seeded();
    for (const who of ['ashigaru1', 'karo', 'gunshi', '']) {
      const r = grant(db, cmd, { issuer: who });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('将軍のみ');
    }
    expect(grant(db, cmd, { issuer: 'shogun' }).ok).toBe(true); // 陽性対照
  });

  test('訳を書かねば切れぬ', () => {
    const { db, cmd } = seeded();
    expect(grant(db, cmd, { reason: '   ' }).ok).toBe(false);
  });

  test('将軍以外は取り消せぬ', () => {
    const { db, cmd } = seeded();
    const r = grant(db, cmd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bad = tx(db, () => revokeCharter(db, r.id, 'ashigaru1', NOW));
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('将軍のみ');
    // まだ生きておる（陽性対照）
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)).not.toBeNull();
    expect(tx(db, () => revokeCharter(db, r.id, 'shogun', NOW)).ok).toBe(true);
  });
});

describe('findCharter — 五重の縛り', () => {
  test('合う者・的・刻なら見つかる', () => {
    const { db, cmd } = seeded();
    grant(db, cmd);
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)?.cmd_id).toBe(cmd);
  });

  test('agent 違い・repo 違い・verb 違いは見つからぬ', () => {
    const { db, cmd } = seeded();
    grant(db, cmd);
    expect(findCharter(db, 'ashigaru2', 'o/r', 'create', NOW)).toBeNull();
    expect(findCharter(db, 'ashigaru1', 'o/other', 'create', NOW)).toBeNull();
    expect(findCharter(db, 'ashigaru1', 'o/r', 'comment', NOW)).toBeNull();
  });

  test('cmd が閉じれば刻中でも死ぬ', () => {
    const { db, cmd } = seeded();
    grant(db, cmd);
    db.prepare("UPDATE cmd SET status = 'done' WHERE id = ?").run(cmd);
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)).toBeNull();
  });

  test('刻が過ぎれば死ぬ・取り消せば死ぬ', () => {
    const { db, cmd } = seeded();
    const r = grant(db, cmd);
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', new Date(NOW.getTime() + TTL + 1000))).toBeNull();
    if (r.ok) tx(db, () => revokeCharter(db, r.id, 'shogun', NOW));
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)).toBeNull();
  });
});

describe('useCharter — 回数', () => {
  test('使うたび減り、尽きれば見つからず、無理に使えば投げる', () => {
    const { db, cmd } = seeded();
    grant(db, cmd); // uses: 2
    const c1 = findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)!;
    tx(db, () => useCharter(db, c1, '一発目'));
    const c2 = findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)!;
    expect(c2.uses_left).toBe(1);
    tx(db, () => useCharter(db, c2, '二発目'));
    expect(findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)).toBeNull(); // 尽きた
    expect(() => tx(db, () => useCharter(db, c2, '三発目'))).toThrow('尽きて');
  });

  test('使用は台帳に落ちる（監査）', () => {
    const { db, cmd } = seeded();
    grant(db, cmd);
    const c = findCharter(db, 'ashigaru1', 'o/r', 'create', NOW)!;
    tx(db, () => useCharter(db, c, 'o/r へ起票「題」'));
    const row = db
      .query("SELECT actor, detail FROM ledger WHERE action = 'charter_use'")
      .get() as { actor: string; detail: string };
    expect(row.actor).toBe('ashigaru1');
    expect(row.detail).toContain('起票');
  });
});

describe('listCharters', () => {
  test('死んだ許状も由つきで見える', () => {
    const { db, cmd } = seeded();
    const r = grant(db, cmd);
    if (r.ok) tx(db, () => revokeCharter(db, r.id, 'shogun', NOW));
    grant(db, cmd);
    const states = listCharters(db, NOW).map((c) => c.state);
    expect(states).toContain('生');
    expect(states).toContain('取消');
  });
});
