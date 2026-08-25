/**
 * 司令と割り当ての試験。
 *
 * 中心は 3 つ。
 *
 *   1. 指揮系統が型で守られること（将軍が足軽へ直に振れぬ）
 *   2. 番号を人に数えさせぬこと（cmd_668 の二重採番）
 *   3. 受け入れ条件を空で通さぬこと（cmd_705 の早すぎる done）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster, roleOf } from '../src/roster';
import { syncLimits } from '../src/routing';
import { createCmd, assignTask, nextCmdId } from '../src/dispatch';
import { leaseState } from '../src/lease';

const FLEET = ['shogun', 'karo', 'gunshi', 'ashigaru1', 'ashigaru2'];

const seeded = () => {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'claude-opus-5' },
      { id: 'karo', role: 'commander', cli: 'cursor', model: 'auto' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'claude-sonnet-5' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'claude-fable-5' },
      { id: 'ashigaru2', role: 'worker', cli: 'cursor', model: 'composer-2.5' },
    ]);
    syncLimits(db, [{ model: 'composer-2.5', maxBloom: 4, costGroup: 'cursor' }]);
  });
  return db;
};

const CMD = {
  north_star: '誤検知で承認が詰まると門にできぬ',
  purpose: '異ブランチ baseline の欠落を removed にしない',
  acceptance_criteria: ['同 branch では従来どおり removed が出る', '修正前に落ちる回帰試験がある'],
  command: '実装せよ',
  project: 'vrt',
  priority: 'high',
};

const withCmd = () => {
  const db = seeded();
  const r = createCmd(db, 'shogun', CMD);
  return { db, cmdId: r.id! };
};

describe('司令を書く', () => {
  test('将軍なら書ける', () => {
    const db = seeded();
    const r = createCmd(db, 'shogun', CMD);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('cmd_1');
  });

  // CLAUDE.md: Chain of command — Shogun → Karo → Ashigaru/Gunshi.
  test('家老は司令を書けぬ', () => {
    const r = createCmd(seeded(), 'karo', CMD);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('shogun だけ');
  });

  test('名乗り無しでは書けぬ', () => {
    expect(createCmd(seeded(), undefined, CMD).ok).toBe(false);
  });

  // 2026-08-24: 行頭一致の grep で最新を数えたが、入れ子の 36 件が拾えず
  // 既存の cmd_668 を上書きしかけた。番号は正本が振る。
  test('番号は正本が振る', () => {
    const db = seeded();
    expect(createCmd(db, 'shogun', CMD).id).toBe('cmd_1');
    expect(createCmd(db, 'shogun', CMD).id).toBe('cmd_2');
    expect(nextCmdId(db)).toBe('cmd_3');
  });

  test('既存の番号の続きから振る', () => {
    const db = seeded();
    db.prepare("INSERT INTO cmd(id, created_at, raw) VALUES ('cmd_703', 'x', '{}')").run();
    expect(createCmd(db, 'shogun', CMD).id).toBe('cmd_704');
  });

  // 2026-08-24: cmd_705 が「軍師レビューを通っている」という条件を満たさぬまま
  // done になった。条件が空だと何をもって完了とするかが誰にも分からない。
  test('受け入れ条件が空なら弾く', () => {
    const r = createCmd(seeded(), 'shogun', { ...CMD, acceptance_criteria: [] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('acceptance_criteria');
  });

  test('受け入れ条件が一覧でなければ弾く', () => {
    const r = createCmd(seeded(), 'shogun', { ...CMD, acceptance_criteria: '一つだけ' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('一覧で書く項目');
  });

  test('north_star が無ければ弾く', () => {
    const { north_star, ...rest } = CMD;
    void north_star;
    expect(createCmd(seeded(), 'shogun', rest).ok).toBe(false);
  });

  test('知らぬ項目は捨てずに指摘する', () => {
    const r = createCmd(seeded(), 'shogun', { ...CMD, acceptance_criteia: ['typo'] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('acceptance_criteria の綴り違い');
  });

  test('受け入れ条件は順序つきで残る', () => {
    const { db, cmdId } = withCmd();
    const rows = db.query('SELECT idx, text FROM cmd_acceptance WHERE cmd_id = ? ORDER BY idx').all(cmdId) as {
      idx: number;
      text: string;
    }[];
    expect(rows.length).toBe(2);
    expect(rows[0]?.idx).toBe(0);
  });
});

describe('持ち場へ振る', () => {
  const assign = (db: ReturnType<typeof seeded>, cmdId: string, over: Record<string, unknown> = {}) =>
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '実装せよ', ...over });

  test('家老なら振れる', () => {
    const { db, cmdId } = withCmd();
    const r = assign(db, cmdId);
    expect(r.ok).toBe(true);
    expect(r.id).toContain('subtask_');
  });

  // 将軍が足軽へ直に振ってはならぬ。
  test('将軍は直に振れぬ', () => {
    const { db, cmdId } = withCmd();
    const r = assignTask(db, 'shogun', { agent: 'ashigaru1', cmd_id: cmdId, title: 'x' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('karo だけ');
  });

  test('上役へは振れぬ', () => {
    const { db, cmdId } = withCmd();
    const r = assign(db, cmdId, { agent: 'shogun' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('上役である');
  });

  test('軍師へは振れる', () => {
    const { db, cmdId } = withCmd();
    expect(assign(db, cmdId, { agent: 'gunshi' }).ok).toBe(true);
  });

  test('名簿に無い者へは振れぬ', () => {
    const { db, cmdId } = withCmd();
    const r = assign(db, cmdId, { agent: 'ashigaru5' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ashigaru1 / ashigaru2');
  });

  test('無い司令の下へは振れぬ', () => {
    const { db } = withCmd();
    const r = assign(db, 'cmd_999');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('そのような司令は無い');
  });

  test('貸与を握る', () => {
    const { db, cmdId } = withCmd();
    assign(db, cmdId);
    const t = db.query('SELECT holder, lease_until, status FROM task WHERE agent = ?').get('ashigaru1') as {
      holder: string;
      lease_until: string;
      status: string;
    };
    // 持ち主は働く当人。家老は振った者であって握る者ではない。
    expect(t.holder).toBe('ashigaru1');
    expect(t.status).toBe('assigned');
    expect(leaseState({ holder: t.holder, leaseUntil: t.lease_until }, new Date())).toBe('held');
  });

  test('すでに握られておれば断る', () => {
    const { db, cmdId } = withCmd();
    assign(db, cmdId);
    const r = assign(db, cmdId, { title: '別の仕事' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('既に仕事を握っておる');
  });

  test('振ると task_assigned が届く', () => {
    const { db, cmdId } = withCmd();
    assign(db, cmdId);
    const m = db.query('SELECT msg_type, sender, body FROM inbox WHERE agent = ?').get('ashigaru1') as {
      msg_type: string;
      sender: string;
      body: string;
    };
    expect(m.msg_type).toBe('task_assigned');
    expect(m.sender).toBe('karo');
    expect(m.body).toContain(cmdId);
  });
});

describe('難度と能力', () => {
  const assign = (db: ReturnType<typeof seeded>, cmdId: string, over: Record<string, unknown>) =>
    assignTask(db, 'karo', { cmd_id: cmdId, title: 'x', ...over });

  test('能力の足りぬ者へは振れぬ', () => {
    const { db, cmdId } = withCmd();
    const r = assign(db, cmdId, { agent: 'ashigaru2', bloom: 'L6' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('L4 まで');
    expect(r.message).toContain('honden route');
  });

  test('足りる者へは振れる', () => {
    const { db, cmdId } = withCmd();
    expect(assign(db, cmdId, { agent: 'ashigaru2', bloom: 'L4' }).ok).toBe(true);
  });

  test('制限の無いモデルなら通る', () => {
    const { db, cmdId } = withCmd();
    expect(assign(db, cmdId, { agent: 'ashigaru1', bloom: 'L6' }).ok).toBe(true);
  });

  test('難度を宣言せねば能力は見ない（現行踏襲）', () => {
    const { db, cmdId } = withCmd();
    expect(assign(db, cmdId, { agent: 'ashigaru2' }).ok).toBe(true);
  });

  test('難度が範囲の外なら弾く', () => {
    const { db, cmdId } = withCmd();
    expect(assign(db, cmdId, { agent: 'ashigaru1', bloom: 'L9' }).ok).toBe(false);
  });
});

describe('台帳', () => {
  test('司令も割り当ても残る', () => {
    const { db, cmdId } = withCmd();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: 'x' });
    const acts = (db.query('SELECT action FROM ledger ORDER BY id').all() as { action: string }[]).map(
      (r) => r.action,
    );
    expect(acts).toContain('cmd.create');
    expect(acts).toContain('lease.acquire');
    expect(acts).toContain('task.assign');
  });

  test('断られた割り当ては何も残さぬ', () => {
    const { db, cmdId } = withCmd();
    const before = (db.query('SELECT count(*) c FROM ledger').get() as { c: number }).c;
    assignTask(db, 'shogun', { agent: 'ashigaru1', cmd_id: cmdId, title: 'x' });
    const after = (db.query('SELECT count(*) c FROM ledger').get() as { c: number }).c;
    expect(after).toBe(before);
    expect((db.query('SELECT count(*) c FROM inbox').get() as { c: number }).c).toBe(0);
  });
});

void FLEET;
