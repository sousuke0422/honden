/**
 * 規約の棚を読み返す試験。
 *
 * 中心は 4 つ。
 *
 *   1. 段の敷居（規約より下は指示文へ入れぬ）
 *   2. 出典の無い行は入れぬ（後から検算できぬゆえ）
 *   3. README と .example を棚として読まぬ（kagemusha の造りを曲げぬ）
 *   4. 空を異常として扱わぬ（棚は空で出荷される）
 */

import { expect, test, describe } from 'bun:test';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { createCmd, assignTask } from '../src/dispatch';
import { readNorms, select, parseEntry, forTask, PROMPT_TIERS } from '../src/norms';
import { setSetting } from '../src/settings';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** kagemusha の棚をその形のまま作る。 */
function shelf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'honden-norms-'));
  const dir = join(root, 'ssot', 'norms');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

const ENTRY = (tier: string, text: string, tail = '— 一文一行 — 出典: 章2 2026-08-26') =>
  `- **[${tier}]** ${text} ${tail}`;

describe('1 行を解く', () => {
  test('段・本文・軸・出典を取る', () => {
    const n = parseEntry(ENTRY('規約', '中黒とダッシュを使い分ける'), 'writing')!;
    expect(n.tier).toBe('規約');
    expect(n.text).toBe('中黒とダッシュを使い分ける');
    expect(n.axis).toBe('一文一行');
    expect(n.source).toBe('章2 2026-08-26');
  });

  test('知らぬ段は行として拾わぬ', () => {
    expect(parseEntry('- **[至高]** 何か — 軸 — 出典: x', 'writing')).toBeNull();
  });

  test('ただの箇条書きは拾わぬ', () => {
    expect(parseEntry('- 普通の箇条書き', 'writing')).toBeNull();
  });

  test('軸が無くとも通る。棚は空欄を許しておる', () => {
    const n = parseEntry('- **[規約]** 何かをする — 出典: 章2 2026-08-26', 'writing')!;
    expect(n.axis).toBeUndefined();
    expect(n.source).toBe('章2 2026-08-26');
  });
});

describe('棚の読み方', () => {
  test('README は棚ではない', () => {
    // 器の説明であって規約ではない。拾うと見出しの箇条書きが規約になる。
    const root = shelf({
      'README.md': ['# 棚の説明', ENTRY('規約', 'これは説明文の中の例である')].join('\n'),
      'writing.md': ENTRY('規約', '本物の規約'),
    });
    const all = readNorms(root);
    expect(all.length).toBe(1);
    expect(all[0]!.text).toBe('本物の規約');
  });

  test('.example は読まぬ。拡張子を緩めてはならぬ', () => {
    // .md で終わっておらぬのは意図で、*.md で拾う仕組みが
    // 配られた見本を「あなたの規約」として読み込まぬための造り。
    const root = shelf({
      'writing.md.example': ENTRY('規約', '見本の中の行'),
    });
    expect(readNorms(root).length).toBe(0);
  });

  test('ドメインはファイル名から取る', () => {
    const root = shelf({ 'proposal.md': ENTRY('規約', '提案の規約') });
    expect(readNorms(root)[0]!.domain).toBe('proposal');
  });

  test('棚が無くとも投げぬ。空で出荷されるものゆえ', () => {
    expect(readNorms('/そのような棚は無い')).toEqual([]);
  });
});

describe('指示文へ入れるものを選ぶ', () => {
  const all = () => [
    parseEntry(ENTRY('観測 n=1', '一度きりの直し'), 'writing')!,
    parseEntry(ENTRY('候補', '三度目の直し'), 'writing')!,
    parseEntry(ENTRY('規約', '八度目の直し'), 'writing')!,
    parseEntry(ENTRY('常設', '出てこなくなった直し'), 'writing')!,
  ];

  test('規約と常設だけが入る', () => {
    const s = select(all());
    expect(s.chosen.map((n) => n.tier)).toEqual(['規約', '常設']);
    expect(s.tooYoung.length).toBe(2);
  });

  test('段の敷居は棚の決めと同じ', () => {
    expect([...PROMPT_TIERS]).toEqual(['規約', '常設']);
  });

  test('段が足りても出典が無ければ入れぬ', () => {
    // 出典の無い行は後から誰も検算できぬ。
    // 誰かの思いつきが規約の顔をして回り始める。
    const n = parseEntry('- **[規約]** 出典の無い規約', 'writing')!;
    const s = select([n]);
    expect(s.chosen.length).toBe(0);
    expect(s.unsourced.length).toBe(1);
  });

  test('ドメインで絞れる', () => {
    const list = [
      parseEntry(ENTRY('規約', '文章の規約'), 'writing')!,
      parseEntry(ENTRY('規約', '提案の規約'), 'proposal')!,
    ];
    expect(select(list, 'writing').chosen.length).toBe(1);
  });

  test('空なら添える文も空。見出しだけを付けぬ', () => {
    // 中身の無い節が毎回付くと、読む側がその節ごと読み飛ばすようになる。
    expect(forTask(select([]))).toBe('');
    expect(forTask(select([parseEntry(ENTRY('候補', 'まだ若い'), 'writing')!]))).toBe('');
  });
});

describe('生成側へ差し込む', () => {
  function seeded(root: string) {
    const db = openStore({ path: ':memory:' });
    tx(db, () => {
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: 'claude', model: null },
        { id: 'karo', role: 'commander', cli: 'cursor', model: null },
        { id: 'ashigaru1', role: 'worker', cli: 'claude', model: null },
      ]);
      setSetting(db, 'norms_root', root, 'shogun');
    });
    const c = createCmd(db, 'shogun', {
      north_star: '規約を初稿へ戻す',
      purpose: '生成側へ還流する',
      acceptance_criteria: ['差し込まれること'],
      command: '実装せよ',
      project: 'honden',
    });
    return { db, cmdId: c.id! };
  }

  const bodyOf = (db: ReturnType<typeof openStore>) =>
    (db.query("SELECT body FROM inbox WHERE agent = 'ashigaru1' ORDER BY rowid DESC LIMIT 1").get() as {
      body: string;
    }).body;

  test('振る仕事に規約が載る', () => {
    // 検めの側へ戻すと見つけるのが速くなるだけ。生成側へ戻して複利になる。
    const root = shelf({ 'writing.md': ENTRY('規約', '中黒とダッシュを使い分ける') });
    const { db, cmdId } = seeded(root);
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '書け' });
    const body = bodyOf(db);
    expect(body).toContain('中黒とダッシュを使い分ける');
    expect(body).toContain('初稿から効かせよ');
  });

  test('段の足りぬ行は載らぬ', () => {
    const root = shelf({ 'writing.md': ENTRY('候補', 'まだ三度目である') });
    const { db, cmdId } = seeded(root);
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '書け' });
    expect(bodyOf(db)).not.toContain('まだ三度目');
  });

  test('棚が空なら何も足さぬ', () => {
    const root = shelf({});
    const { db, cmdId } = seeded(root);
    assignTask(db, 'karo', { agent: 'ashigaru1', cmd_id: cmdId, title: '書け' });
    expect(bodyOf(db)).not.toContain('規約');
  });
});
