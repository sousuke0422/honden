/**
 * 場所の取り置きの試験。
 *
 * 中心は 4 つ。
 *
 *   1. 貸与が空いておっても、場所が重なれば振れぬこと
 *   2. 重なりは前置きまで見ること（一段深い所から入れさせぬ）
 *   3. 断る時に路が示されること（誰が握っておるか＋取りうる三つの手）
 *   4. 納めたら解けること（解かねば永久に握られたままになる）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport } from '../src/report';
import { take, release, releaseAllOf, live, conflicts, overlaps, normalize } from '../src/claim';

const CMD = {
  north_star: '同じ木を二人で触ると merge commit が生まれる',
  purpose: '場所の重なりを振る前に検める',
  acceptance_criteria: ['重なれば振れぬこと'],
  command: '実装せよ',
  project: 'honden',
};

function seeded() {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
    ]);
  });
  const c = createCmd(db, 'shogun', CMD);
  return { db, cmdId: c.id! };
}

describe('重なりの見方', () => {
  test('path は前置きまで見る', () => {
    const a = { kind: 'path' as const, value: '/w/.worktrees/x' };
    expect(overlaps(a, { kind: 'path', value: '/w/.worktrees/x' })).toBe(true);
    expect(overlaps(a, { kind: 'path', value: '/w/.worktrees/x/apps/backend' })).toBe(true);
    // 区切りの境目で切る。文字が続いておるだけの別物は重ならぬ
    expect(overlaps(a, { kind: 'path', value: '/w/.worktrees/xyz' })).toBe(false);
    expect(overlaps(a, { kind: 'path', value: '/w/.worktrees/y' })).toBe(false);
  });

  test('枝は完全一致のみ', () => {
    const a = { kind: 'branch' as const, value: 'feat/x' };
    expect(overlaps(a, { kind: 'branch', value: 'feat/x' })).toBe(true);
    expect(overlaps(a, { kind: 'branch', value: 'feat/x/y' })).toBe(false);
  });

  test('種が違えば重ならぬ', () => {
    expect(overlaps({ kind: 'path', value: 'a' }, { kind: 'branch', value: 'a' })).toBe(false);
  });

  test('path は絶対へ均す。相対のままだと同じ場所が別物に見える', () => {
    expect(normalize('path', '.worktrees/x', '/w')).toBe('/w/.worktrees/x');
    expect(normalize('path', '/w/.worktrees/x/', '/w')).toBe('/w/.worktrees/x');
  });
});

describe('振る時に検める', () => {
  test('貸与が空いておっても、場所が重なれば振れぬ', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: '一人目',
      workspace: '/w/.worktrees/vrt-fix32',
    });
    expect(a.ok).toBe(true);

    // 足軽2号は空いておる。だが同じ木である
    const b = assignTask(db, 'karo', {
      agent: 'ashigaru2',
      cmd_id: cmdId,
      title: '二人目',
      workspace: '/w/.worktrees/vrt-fix32',
    });
    expect(b.ok).toBe(false);
    expect(b.message).toContain('ashigaru1');
    // 振っておらぬこと。半端な状態を残さぬ
    const t = db.query("SELECT status FROM task WHERE agent = 'ashigaru2'").get() as { status: string } | null;
    expect(t?.status ?? 'idle').toBe('idle');
  });

  test('一段深い所からも入れぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一人目', workspace: '/w/.worktrees/x' });
    const b = assignTask(db, 'karo', {
      agent: 'ashigaru2',
      cmd_id: cmdId,
      title: '二人目',
      workspace: '/w/.worktrees/x/apps',
    });
    expect(b.ok).toBe(false);
  });

  test('別の場所なら振れる', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const b = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二', workspace: '/w/.worktrees/y' });
    expect(b.ok).toBe(true);
  });

  test('枝の重なりも見る', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', branch: 'feat/x' });
    const b = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二', branch: 'feat/x' });
    expect(b.ok).toBe(false);
  });

  test('場所を書かねば検めようがない。振れてしまう', () => {
    // 型で守れるのは書かれた分だけ。書かぬ自由は残っておる。
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    expect(assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' }).ok).toBe(true);
  });
});

describe('断る時は路を示す', () => {
  test('誰が・いつから握っておるかと、取りうる三つの手', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const b = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二', workspace: '/w/.worktrees/x' });
    const m = b.message!;
    expect(m).toContain('ashigaru1');
    expect(m).toContain('一、待つ');
    expect(m).toContain('二、別の場所');
    expect(m).toContain('三、譲らせる');
    expect(m).toContain('claim release');
  });

  test('足軽は他人の持ち場を読まずに問える', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const held = conflicts(db, 'path', '/w/.worktrees/x');
    expect(held.length).toBe(1);
    expect(held[0]!.agent).toBe('ashigaru1');
    expect(conflicts(db, 'path', '/w/.worktrees/z').length).toBe(0);
  });
});

describe('手放す', () => {
  test('納めれば解ける', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: '一',
      workspace: '/w/.worktrees/x',
    });
    expect(live(db).length).toBe(1);
    submitReport(db, 'ashigaru1', {
      task_id: a.id!,
      status: 'done',
      summary: '納めた',
      acceptance: { 1: '重なりの試験が通った。bun test 279 件' },
    });
    expect(live(db).length).toBe(0);
  });

  test('blocked では握ったまま。まだ仕掛かっておる', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: '一',
      workspace: '/w/.worktrees/x',
    });
    submitReport(db, 'ashigaru1', { task_id: a.id!, status: 'blocked', summary: '塞がれた' });
    expect(live(db).length).toBe(1);
  });

  test('他人の取り置きは force と理由が要る', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const id = live(db)[0]!.id;

    // 理由も force も無い
    expect(release(db, { id, by: 'karo' }).ok).toBe(false);
    // force が無い。理由だけ書いても通らぬこと——
    // ここを見ておかぬと、force の門を外しても理由の門が拾ってしまい、
    // 試験が緑のままになる（実際に一度そうなった）
    const noForce = release(db, { id, by: 'karo', reason: 'ashigaru1 の pane が落ちて 1 時間' });
    expect(noForce.ok).toBe(false);
    expect(noForce.message).toContain('--force');
    // force はあるが理由が無い
    expect(release(db, { id, by: 'karo', force: true }).ok).toBe(false);
    const r = release(db, { id, by: 'karo', force: true, reason: 'ashigaru1 の pane が落ちて 1 時間' });
    expect(r.ok).toBe(true);

    const led = db.query("SELECT detail FROM ledger WHERE action = 'claim.release.force'").all() as {
      detail: string;
    }[];
    expect(led.length).toBe(1);
    // 相手がその時どう見えていたかが残ること
    expect(led[0]!.detail).toContain('prev=ashigaru1');
    expect(led[0]!.detail).toContain('握り始め=');
  });

  test('自分のものは理由なしで解ける', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    expect(release(db, { id: live(db)[0]!.id, by: 'ashigaru1' }).ok).toBe(true);
  });

  test('解けば次の者が入れる', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    releaseAllOf(db, 'ashigaru1');
    expect(
      assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二', workspace: '/w/.worktrees/x' }).ok,
    ).toBe(true);
  });

  test('同じ者が同じ所を取り直すのは通る', () => {
    const db = openStore({ path: ':memory:' });
    expect(take(db, { kind: 'path', value: '/w/x', agent: 'ashigaru1' }).ok).toBe(true);
    expect(take(db, { kind: 'path', value: '/w/x', agent: 'ashigaru1' }).ok).toBe(true);
  });
});
