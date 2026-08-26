/**
 * 覗く路と辿る路の試験。
 *
 * 中心は 3 つ。
 *
 *   1. 読むのは通り、実行は通らぬこと（現行が一緒くたにしていた所）
 *   2. 覗いた跡が残ること
 *   3. 解かれた取り置きも辿れること（衝突は後から分かるゆえ）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx, signalPathOf } from '../src/store';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { submitReport } from '../src/report';
import { peek, history } from '../src/peer';
import { release, live } from '../src/claim';

const CMD = {
  north_star: '同じ枝へ二人が押すと衝突する',
  purpose: '何が起きたのか辿れるようにする',
  acceptance_criteria: ['辿れること'],
  command: '実装せよ',
  project: 'honden',
};

const REASON = '同じ枝を触っておる者が居らぬか、押す前に検める';

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

describe('覗く', () => {
  test('理由を添えれば、他の者の持ち場が見える', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: 'vrt32 を緑にせよ',
      workspace: '/w/.worktrees/vrt-fix32',
      branch: 'fix32-rebase',
    });
    const r = peek(db, 'ashigaru2', 'ashigaru1', REASON);
    expect(r.ok).toBe(true);
    expect(r.out).toContain('vrt32 を緑にせよ');
    expect(r.out).toContain('fix32-rebase');
    // 境目が読んで分かること
    expect(r.out).toContain('手を出してはならぬ');
    expect(r.out).toContain('家老へ回されよ');
  });

  test('理由が無ければ覗けぬ', () => {
    const { db } = seeded();
    const r = peek(db, 'ashigaru2', 'ashigaru1', undefined);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('理由');
  });

  test('形だけの理由は弾く', () => {
    const { db } = seeded();
    expect(peek(db, 'ashigaru2', 'ashigaru1', 'テスト').ok).toBe(false);
    expect(peek(db, 'ashigaru2', 'ashigaru1', '確認').ok).toBe(false);
  });

  test('覗いた跡が残る。理由ごと', () => {
    const { db } = seeded();
    peek(db, 'ashigaru2', 'ashigaru1', REASON);
    const led = db.query("SELECT actor, target, detail FROM ledger WHERE action = 'task.peek'").all() as {
      actor: string;
      target: string;
      detail: string;
    }[];
    expect(led.length).toBe(1);
    expect(led[0]!.actor).toBe('ashigaru2');
    expect(led[0]!.target).toBe('ashigaru1');
    expect(led[0]!.detail).toContain('押す前に検める');
  });

  test('弾かれた時は跡も残らぬ', () => {
    const { db } = seeded();
    peek(db, 'ashigaru2', 'ashigaru1', undefined);
    expect((db.query("SELECT count(*) c FROM ledger WHERE action = 'task.peek'").get() as { c: number }).c).toBe(0);
  });

  test('覗けても、その仕事の報告は書けぬ', () => {
    // 現行が禁じたのは「読む」だが、事故は「実行した」であった。
    // 読むのを開いても、実行の側が型で塞がっておること。
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' });
    expect(peek(db, 'ashigaru2', 'ashigaru1', REASON).ok).toBe(true);
    const r = submitReport(db, 'ashigaru2', { task_id: a.id!, status: 'done', summary: '横取り' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('他の者の仕事の報告は書けぬ');
  });

  test('自分の持ち場に旗は要らぬ', () => {
    const { db } = seeded();
    const r = peek(db, 'ashigaru1', 'ashigaru1', REASON);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('旗は要らぬ');
  });
});

describe('辿る', () => {
  test('解いた後も、誰が触ったか残る', () => {
    // 衝突は往々にして「先に居た者が納めた後」に分かる。
    // いま握っておる者だけ見ても経緯が分からぬ。
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', {
      agent: 'ashigaru1',
      cmd_id: cmdId,
      title: '一',
      branch: 'fix32-rebase',
    });
    submitReport(db, 'ashigaru1', {
      task_id: a.id!,
      status: 'done',
      summary: '納めた',
      acceptance: { 1: '辿れることを試験で確かめた' },
    });
    expect(live(db).length).toBe(0);

    const h = history(db, 'branch', 'fix32-rebase');
    expect(h.out).toContain('ashigaru1');
    expect(h.out).toContain('解いた');
  });

  test('いま握っておる者は目立つ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', branch: 'fix32-rebase' });
    expect(history(db, 'branch', 'fix32-rebase').out).toContain('いま握っておる');
  });

  test('譲らせた跡も出る', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', branch: 'fix32-rebase' });
    release(db, {
      id: live(db)[0]!.id,
      by: 'karo',
      force: true,
      reason: 'ashigaru1 の pane が落ちて 1 時間',
    });
    const h = history(db, 'branch', 'fix32-rebase');
    expect(h.out).toContain('claim.release.force');
    expect(h.out).toContain('prev=ashigaru1');
  });

  test('取り置きが無いことを「誰も触っておらぬ」と言わぬ', () => {
    // --workspace を書かずに振れば取り置きは立たぬ。
    // detached HEAD で切った worktree も枝の取り置きを持たぬ。
    // 無いことを証拠にすると、いちばん危うい筋を見落とす。
    const { db } = seeded();
    const h = history(db, 'branch', 'fix32-rebase');
    expect(h.out).toContain('誰も取り置いておらぬ');
    expect(h.out).toContain('取り置きが無いのは「誰も触っておらぬ」ことではない');
    expect(h.out).toContain('detached HEAD');
  });
});

describe('重なっておった時だけ家老へ報せる', () => {
  const karoUnread = (db: ReturnType<typeof openStore>) =>
    (db.query("SELECT count(*) c FROM inbox WHERE agent = 'karo' AND read = 0").get() as { c: number }).c;

  /**
   * 取り置きが二重に入った状態を作る。
   *
   * 振る門も take も重なりを弾くので、**正しく回っておればこの状態は作れない**。
   * 正本へ直に入れる。ここで検めておるのは「万一入ってしまった時に
   * 黙って通り過ぎぬこと」であって、通常の筋ではない。
   */
  function collided() {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', branch: 'fix32-rebase' });
    assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' });
    db.prepare('INSERT INTO claim(kind, value, agent, task_id, at) VALUES (?,?,?,?,?)').run(
      'branch',
      'fix32-rebase',
      'ashigaru2',
      'subtask_x',
      new Date().toISOString(),
    );
    return { db, cmdId };
  }

  test('取り置きが宣言されておらずとも報せる。そこがいちばん危うい', () => {
    // 取り置きが重なる状態は、振る門がそもそも作らせない。
    // 危ういのは宣言されなかった側——枝を書かずに振った、detached で切った。
    // そこには比べる取り置きが無いので、重なりの有無を条件にすると
    // いちばん危うい筋で黙ることになる。
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' }); // 場所の宣言なし
    assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' });
    const before = karoUnread(db);
    const r = peek(db, 'ashigaru2', 'ashigaru1', REASON);
    expect(karoUnread(db)).toBe(before + 1);
    expect(r.out).toContain('家老へ報せた');
    const m = db.query("SELECT body FROM inbox WHERE agent = 'karo' ORDER BY rowid DESC LIMIT 1").get() as {
      body: string;
    };
    expect(m.body).toContain('宣言されておらぬ場所で重なっておる恐れ');
  });

  test('報せには「なぜ覗いたか」が載る', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    peek(db, 'ashigaru2', 'ashigaru1', REASON);
    const m = db.query("SELECT body FROM inbox WHERE agent = 'karo' ORDER BY rowid DESC LIMIT 1").get() as {
      body: string;
    };
    expect(m.body).toContain(REASON);
  });

  test('取り置きが二重に入っておれば、その場所を名指しする（上流が壊れた印）', () => {
    const { db } = collided();
    peek(db, 'ashigaru2', 'ashigaru1', REASON);
    const m = db
      .query("SELECT body FROM inbox WHERE agent = 'karo' ORDER BY rowid DESC LIMIT 1")
      .get() as { body: string };
    expect(m.body).toContain('fix32-rebase');
    expect(m.body).toContain('claim release');
  });

  test('同じ相手の同じ仕事について二度は報せぬ', () => {
    const { db } = collided();
    peek(db, 'ashigaru2', 'ashigaru1', REASON);
    const after1 = karoUnread(db);
    const r = peek(db, 'ashigaru2', 'ashigaru1', REASON);
    expect(karoUnread(db)).toBe(after1);
    expect(r.out).toContain('既に報せてある');
  });

  test('報せたら合図も上がる。家老が起きねば届いておらぬのと同じ', () => {
    // :memory: では合図の口が無いので、正本を実体で置く。
    // deliver だけでは芯が起きぬ——書けたのに誰も知らぬ状態になる。
    const dir = mkdtempSync(join(tmpdir(), 'honden-peer-'));
    const dbPath = join(dir, 'h.db');
    const db = openStore({ path: dbPath });
    tx(db, () => {
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
        { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
        { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
      ]);
    });
    const c = createCmd(db, 'shogun', CMD);
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: c.id!, title: '一' });
    // 振った時点で合図は既に上がっておる。消してから覗く——
    // そうせぬと「前の合図がまだそこにある」だけで通ってしまい、
    // 覗きが合図を上げておるかを見たことにならぬ。
    const sig = signalPathOf(dbPath);
    rmSync(sig, { force: true });
    expect(existsSync(sig)).toBe(false);

    peek(db, 'ashigaru2', 'ashigaru1', REASON);

    expect(existsSync(sig)).toBe(true);
    expect((db.query("SELECT count(*) c FROM ledger WHERE action = 'collision.report'").get() as { c: number }).c).toBe(1);
  });
});
