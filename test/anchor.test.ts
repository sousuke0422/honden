/**
 * 偽れぬ名乗りの試験。
 *
 * 要は「環境変数を書き換えても名乗りが変わらぬ」ことである。
 * ゆえに resolve() へ錨と食い違う TMUX_PANE を渡し、**錨が勝つ**を見る。
 */
import { describe, expect, test } from 'bun:test';
import { anchorFrom, parentOf, chainFrom, parsePanes } from '../src/anchor';
import { resolve } from '../src/identity';

/** /proc/<pid>/stat の贋物。comm に空白と括弧を入れて桁ずれを誘う。 */
const fakeProc = (tree: Record<number, number>) => (path: string) => {
  const m = /^\/proc\/(\d+)\/stat$/.exec(path);
  if (!m) throw new Error('無い');
  const pid = Number(m[1]);
  if (!(pid in tree)) throw new Error('無い');
  return `${pid} (tmux: server (x)) S ${tree[pid]} 999 999 34816 999 ...`;
};

describe('parentOf / chainFrom', () => {
  test('comm に空白と括弧があっても親を読み違えぬ', () => {
    expect(parentOf(10, fakeProc({ 10: 7 }))).toBe(7);
  });

  test('系譜を辿り、init まで来れば止まる', () => {
    // 10 → 7 → 3 → 1
    expect(chainFrom(10, fakeProc({ 10: 7, 7: 3, 3: 1 }))).toEqual([10, 7, 3]);
  });

  test('輪になっても止まる（自分を親に持つ贋物）', () => {
    expect(chainFrom(5, fakeProc({ 5: 5 }))).toEqual([5]);
  });

  test('読めぬ pid でそこまでで返る', () => {
    expect(chainFrom(10, fakeProc({ 10: 7 }))).toEqual([10, 7]);
  });
});

describe('parsePanes', () => {
  test('tmux の三欄を読み、@agent_id が空の pane も落とさぬ', () => {
    const rows = parsePanes(['2183328 %51 ashigaru1', '2555877 %0 shogun', '999 %9', '', '  '].join('\n'));
    expect(rows).toEqual([
      { pid: 2183328, pane: '%51', agentId: 'ashigaru1' },
      { pid: 2555877, pane: '%0', agentId: 'shogun' },
      { pid: 999, pane: '%9', agentId: '' },
    ]);
  });
});

describe('anchorFrom', () => {
  const panes = () => [
    { pid: 100, pane: '%0', agentId: 'shogun' },
    { pid: 200, pane: '%51', agentId: 'ashigaru1' },
    { pid: 300, pane: '%9', agentId: '' },
  ];

  test('系譜の先に pane があれば、その pane が我が家', () => {
    expect(anchorFrom({ chain: () => [500, 400, 200, 99], panes })).toEqual({ pane: '%51', agentId: 'ashigaru1' });
  });

  test('一番近い先祖を採る（入れ子でも手前が勝つ）', () => {
    expect(anchorFrom({ chain: () => [500, 200, 100], panes })?.agentId).toBe('ashigaru1');
  });

  test('当たらねば null（布陣の外か、系譜を切った者）', () => {
    expect(anchorFrom({ chain: () => [1, 2, 3], panes })).toBeNull();
  });

  test('tmux が居らねば null', () => {
    expect(anchorFrom({ chain: () => [100], panes: () => [] })).toBeNull();
  });

  test('@agent_id の無い pane は agentId 無しで返る（布陣内だが持ち場でない）', () => {
    expect(anchorFrom({ chain: () => [300], panes })).toEqual({ pane: '%9', agentId: undefined });
  });
});

describe('resolve — 錨は環境変数に勝つ', () => {
  const anchored = (agentId?: string) => () => ({ pane: '%51', agentId });
  const never = () => {
    throw new Error('錨がある時に pane を引いてはならぬ');
  };

  test('TMUX_PANE を空にしても布陣外を騙れぬ（critical の塞ぎ）', () => {
    const id = resolve({ tmuxPane: '', agentIdEnv: 'shogun', lookup: never, anchor: anchored('ashigaru1') });
    expect(id.insideFormation).toBe(true);
    expect(id.anchored).toBe(true);
    expect(id.id).toBe('ashigaru1'); // env の「shogun」は通らぬ
  });

  test('他人の pane を指しても、系譜が勝ち、断りが出る', () => {
    const id = resolve({ tmuxPane: '%0', agentIdEnv: undefined, lookup: never, anchor: anchored('ashigaru1') });
    expect(id.id).toBe('ashigaru1');
    expect(id.conflict).toContain('%0');
    expect(id.conflict).toContain('系譜');
  });

  test('錨と TMUX_PANE が合えば断りは出ぬ', () => {
    const id = resolve({ tmuxPane: '%51', agentIdEnv: undefined, lookup: never, anchor: anchored('ashigaru1') });
    expect(id.conflict).toBeUndefined();
  });

  test('錨の pane に @agent_id が無ければ、env へ落ちぬ', () => {
    const id = resolve({ tmuxPane: '', agentIdEnv: 'karo', lookup: never, anchor: anchored(undefined) });
    expect(id.id).toBeUndefined();
    expect(id.source).toBe('none');
    expect(id.anchored).toBe(true);
  });

  test('錨が取れねば従前どおり（陽性対照: 塞ぎが効いておるのは錨のある時だけ）', () => {
    const id = resolve({ tmuxPane: '', agentIdEnv: 'shogun', lookup: never, anchor: () => null });
    expect(id.insideFormation).toBe(false);
    expect(id.anchored).toBeUndefined();
    expect(id.id).toBe('shogun'); // 錨が無ければ env を採る——ゆえに bot は錨を要求する
  });
});
