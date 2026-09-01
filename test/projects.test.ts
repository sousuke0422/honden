/**
 * 案件の所在と、場所の補いの試験。
 *
 * 中心は 3 つ。
 *
 *   1. path をそのまま補わぬこと（work_location: coder の罠）
 *   2. 補った値は見立てであって、重なっても断らぬこと
 *   3. 所在が無ければ補わぬこと（無いなら無いでよい）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { syncProjects, workRootOf, readProjectsFromFile } from '../src/projects';
import { live, conflicts } from '../src/claim';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECTS = [
  { id: 'vrt', path: '/w/vrt', workLocation: null, coderWorkspace: null, coderWorkdir: null, status: 'active', raw: '{}' },
  {
    id: 'task',
    path: '/mnt/c/Users/example/work/task',
    workLocation: 'coder',
    coderWorkspace: 'yellow-louse-10',
    coderWorkdir: '/home/coder/task',
    status: 'active',
    raw: '{}',
  },
  {
    id: 'task-local',
    path: '/mnt/c/Users/example/work/task',
    workLocation: null,
    coderWorkspace: null,
    coderWorkdir: null,
    status: 'standby',
    raw: '{}',
  },
];

function seeded(project = 'vrt') {
  const db = openStore({ path: ':memory:' });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: null },
      { id: 'karo', role: 'commander', cli: 'cursor', model: null },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
      { id: 'ashigaru2', role: 'worker', cli: 'claude', model: null },
    ]);
    syncProjects(db, PROJECTS);
  });
  const c = createCmd(db, 'shogun', {
    north_star: '場所を書かずに振られた時に補う',
    purpose: '所在から補う',
    acceptance_criteria: ['補うこと'],
    command: '実装せよ',
    project,
  });
  return { db, cmdId: c.id! };
}

describe('働く場所の割り出し', () => {
  test('path が実体なら path', () => {
    const { db } = seeded();
    expect(workRootOf(db, 'vrt')!.value).toBe('/w/vrt');
  });

  test('work_location: coder なら path を返さぬ', () => {
    // 現行で足軽が二度これで失敗しておる (cmd_266, cmd_273 — WSL で作業して push 403)。
    const { db } = seeded();
    const r = workRootOf(db, 'task')!;
    expect(r.value).not.toContain('/mnt/c/');
    expect(r.value).toBe('coder:yellow-louse-10:/home/coder/task');
    expect(r.why).toContain('参照専用');
  });

  test('休眠中の案件は補わぬ。平時に使ってはならぬ枠ゆえ', () => {
    const { db } = seeded();
    expect(workRootOf(db, 'task-local')).toBeNull();
  });

  test('知らぬ案件は補わぬ', () => {
    const { db } = seeded();
    expect(workRootOf(db, '知らぬ案件')).toBeNull();
  });
});

describe('場所を書かずに振る', () => {
  test('所在から補う', () => {
    const { db, cmdId } = seeded();
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    expect(a.ok).toBe(true);
    const held = live(db);
    expect(held.length).toBe(1);
    expect(held[0]!.value).toBe('/w/vrt');
    expect(held[0]!.source).toBe('inferred');
    // 振った者に、補ったことが伝わること
    expect(a.message).toContain('見立て');
  });

  test('補った見立ては、重なっても断らぬ', () => {
    // 現行は一つの案件へ複数の足軽を振るのが常。案件の根を握らせて
    // 断れば、その常道が止まる。
    const { db, cmdId } = seeded();
    expect(assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' }).ok).toBe(true);
    expect(assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' }).ok).toBe(true);
    expect(live(db).length).toBe(2);
  });

  test('明示された約束は、いまも断る', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const b = assignTask(db, 'karo', {
      agent: 'ashigaru2',
      cmd_id: cmdId,
      title: '二',
      workspace: '/w/.worktrees/x',
    });
    expect(b.ok).toBe(false);
  });

  test('明示があれば補わぬ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/.worktrees/x' });
    const held = live(db).filter((c) => c.kind === 'path');
    expect(held.length).toBe(1);
    expect(held[0]!.source).toBe('declared');
  });

  test('所在が無ければ補わぬ。無いなら無いでよい', () => {
    const { db, cmdId } = seeded('知らぬ案件');
    const a = assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    expect(a.ok).toBe(true);
    expect(live(db).length).toBe(0);
    expect(a.message).toBeUndefined();
  });

  test('先に居る約束が、後から補う見立てを断らせぬ', () => {
    // ここが二つの門の片割れ。
    //   ① 見立てを取る時は、そもそも検めを通さない（この試験）
    //   ② 約束を取る時は、見立てを重なりに数えない（次の試験）
    // ①が無いと、案件の根が誰かの約束を含んでおる時に、
    // 場所を書かずに振っただけで振れなくなる。
    const { db, cmdId } = seeded();
    // 足軽1号が案件の中の一角を約束する
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一', workspace: '/w/vrt/apps' });
    // 足軽2号は場所を書かぬ → /w/vrt が補われる（/w/vrt/apps を含む）
    const b2 = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二' });
    expect(b2.ok).toBe(true);
    expect(live(db).some((c) => c.source === 'inferred' && c.value === '/w/vrt')).toBe(true);
  });

  test('見立ては約束を断らせぬ', () => {
    // 見立てが先に居ても、明示の約束は通ること
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' }); // /w/vrt を見立てで
    const b = assignTask(db, 'karo', { agent: 'ashigaru2', cmd_id: cmdId, title: '二', workspace: '/w/vrt/apps' });
    expect(b.ok).toBe(true);
  });

  test('conflicts は見立ても出す。見えることが目的ゆえ', () => {
    const { db, cmdId } = seeded();
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '一' });
    expect(conflicts(db, 'path', '/w/vrt').length).toBe(1);
    expect(conflicts(db, 'path', '/w/vrt', undefined, true).length).toBe(0);
  });
});

describe('所在の読み取り', () => {
  test('現行の形をそのまま読む', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-proj-'));
    const f = join(dir, 'projects.yaml');
    writeFileSync(
      f,
      [
        'projects:',
        '  - id: vrt',
        '    path: "/w/vrt"',
        '    status: active',
        '  - id: task',
        '    path: "/mnt/c/Users/example/work/task"',
        '    work_location: coder',
        '    coder_workspace: yellow-louse-10',
        '    coder_workdir: /home/coder/task',
        '    status: active',
      ].join('\n'),
    );
    const list = readProjectsFromFile(f);
    expect(list.length).toBe(2);
    expect(list[1]!.coderWorkdir).toBe('/home/coder/task');
  });
});

/**
 * 案件の覚書（context/<id>.md）の見え方。
 *
 * 旧環境の context/ は「足軽への引き継ぎの一枚」の意図で始まり、一つの書が
 * 80KB・1,214 行の設計書に育った。雛形の「シンプルに保つ」は定めだけで、
 * 誰も測っていなかった。ここでは大きさを見せ、育ちすぎたら警める。
 */
import { runProjectsShow } from '../src/main';
import { mkdirSync } from 'node:fs';

describe('honden projects — 覚書の見え方', () => {
  function withProjects() {
    const db = mkdtempSync(join(tmpdir(), 'honden-ctx-')) + '/h.db';
    const root = mkdtempSync(join(tmpdir(), 'honden-ctxroot-'));
    mkdirSync(join(root, 'context'));
    const y = join(root, 'projects.yaml');
    writeFileSync(y, 'projects:\n  - id: alpha\n    path: /w/alpha\n');
    const d = openStore({ path: db });
    tx(d, () => syncProjects(d, readProjectsFromFile(y)));
    return { db, root };
  }

  test('覚書が無ければ、その行ごと出ない', () => {
    const { db, root } = withProjects();
    const r = runProjectsShow(db, root);
    expect(r.out).toContain('alpha');
    expect(r.out).not.toContain('覚書');
  });

  test('在れば名と大きさが出る', () => {
    const { db, root } = withProjects();
    writeFileSync(join(root, 'context', 'alpha.md'), '# alpha\n場所と罠。\n');
    const r = runProjectsShow(db, root);
    expect(r.out).toContain('覚書: context/alpha.md');
    expect(r.out).not.toContain('育ちすぎ');
  });

  test('**育ちすぎたら警める**（80KB の教訓。定めだけでは止まらなかった）', () => {
    const { db, root } = withProjects();
    writeFileSync(join(root, 'context', 'alpha.md'), '設計書。\n'.repeat(2000)); // > 8KB
    const r = runProjectsShow(db, root);
    expect(r.out).toContain('育ちすぎ');
    expect(r.out).toContain('案件の docs へ');
  });
});
