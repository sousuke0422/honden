/**
 * 名乗りの決め方の試験。
 *
 * 現行 (scripts/session_start_hook.sh) は `@agent_id` だけを見て、
 * 取れなければ布陣の外として何もしない。環境変数の名乗りは持たない。
 * honden が足した `HONDEN_AGENT_ID` は布陣の外から名乗るためのもので、
 * **布陣の中で pane を上書きしてよいものではない。**
 */

import { expect, test, describe } from 'bun:test';
import { resolve } from '../src/identity';

const lookupOf = (m: Record<string, string>) => (pane: string) => m[pane] ?? '';

describe('布陣の中', () => {
  test('pane が正。環境変数では上書きできぬ', () => {
    const r = resolve({
      tmuxPane: '%4',
      agentIdEnv: 'karo',
      lookup: lookupOf({ '%4': 'ashigaru1' }),
    });
    expect(r.id).toBe('ashigaru1');
    expect(r.source).toBe('pane');
  });

  test('食い違いは黙って解かぬ', () => {
    const r = resolve({ tmuxPane: '%4', agentIdEnv: 'karo', lookup: lookupOf({ '%4': 'ashigaru1' }) });
    expect(r.conflict).toContain('ashigaru1');
    expect(r.conflict).toContain('karo');
  });

  test('食い違いが無ければ黙る', () => {
    const r = resolve({ tmuxPane: '%4', agentIdEnv: 'ashigaru1', lookup: lookupOf({ '%4': 'ashigaru1' }) });
    expect(r.conflict).toBeUndefined();
  });

  test('pane に @agent_id が無ければ、環境変数で名乗れる', () => {
    // 布陣の tmux 内だが持ち場ではない pane（個人の Claude Code など）。
    const r = resolve({ tmuxPane: '%9', agentIdEnv: 'review_session', lookup: lookupOf({}) });
    expect(r.id).toBe('review_session');
    expect(r.source).toBe('env');
    expect(r.insideFormation).toBe(true);
  });
});

describe('布陣の外', () => {
  test('TMUX_PANE が空なら pane を引かぬ', () => {
    // 空のまま display-message を打つと、tmux はアクティブな pane の
    // @agent_id を返す。2026-07-06 に将軍が別陣営の pane を自分と誤認しておる。
    let called = 0;
    const r = resolve({
      tmuxPane: '',
      agentIdEnv: 'review_session',
      lookup: () => {
        called++;
        return 'shogun';
      },
    });
    expect(called).toBe(0);
    expect(r.id).toBe('review_session');
    expect(r.insideFormation).toBe(false);
  });

  test('環境変数も無ければ、誰でもない', () => {
    const r = resolve({ tmuxPane: '', lookup: () => 'shogun' });
    expect(r.id).toBeUndefined();
    expect(r.source).toBe('none');
  });
});
