/**
 * 顔ぶれの試験。
 *
 * 布陣は環境ごとに大きさが違う。投資分析用の環境は足軽 2 体で足りる。
 * そこで ashigaru5 が通ってしまわないことが、この層の要になる。
 */

import { expect, test, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tx } from '../src/store';
import {
  readRosterFromSettings,
  syncRoster,
  roster,
  isKnown,
  isEmpty,
  roleOf,
  RosterError,
  MAX_WORKERS,
} from '../src/roster';
import { inboxWrite, inboxUnread, EXIT_OK, EXIT_INVALID } from '../src/cli';

const mem = () => openStore({ path: ':memory:' });

const settings = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'honden-roster-'));
  const p = join(dir, 'settings.yaml');
  writeFileSync(p, body, 'utf8');
  return p;
};

const twoWorkers = `
cli:
  agents:
    shogun:
      type: claude
      model: claude-opus-5
    karo:
      type: cursor
      model: auto
    ashigaru1:
      type: claude
      model: claude-fable-5
    ashigaru2:
      type: codex
      model: gpt-5.6-sol
`;

describe('役の振り分け', () => {
  test('上役は 3 つ', () => {
    expect(roleOf('shogun')).toBe('commander');
    expect(roleOf('karo')).toBe('commander');
    expect(roleOf('gunshi')).toBe('commander');
  });

  test('足軽は番号つき', () => {
    expect(roleOf('ashigaru1')).toBe('worker');
    expect(roleOf(`ashigaru${MAX_WORKERS}`)).toBe('worker');
  });

  test('上限を超える番号は置けぬ', () => {
    expect(() => roleOf(`ashigaru${MAX_WORKERS + 1}`)).toThrow(RosterError);
  });

  test('振り分けられぬ名は置けぬ', () => {
    // fshogun は環境の名であって役職名ではない
    expect(() => roleOf('fshogun')).toThrow(RosterError);
    expect(() => roleOf('ashigaru0')).toThrow(RosterError);
  });
});

describe('settings.yaml から読む', () => {
  test('cli.agents の鍵がそのまま顔ぶれになる', () => {
    const p = settings(twoWorkers);
    try {
      const r = readRosterFromSettings(p);
      expect(r.map((e) => e.id)).toEqual(['ashigaru1', 'ashigaru2', 'karo', 'shogun']);
      expect(r.find((e) => e.id === 'karo')?.cli).toBe('cursor');
      expect(r.filter((e) => e.role === 'worker').length).toBe(2);
    } finally {
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });

  // 上限は名で効く。ashigaru8 という名が存在しないので、8 体目は名の時点で落ちる。
  test('上限を超える足軽が居れば受け付けぬ', () => {
    const body =
      'cli:\n  agents:\n' +
      Array.from({ length: MAX_WORKERS + 1 }, (_, i) => `    ashigaru${i + 1}:\n      type: claude\n`).join('');
    const p = settings(body);
    try {
      expect(() => readRosterFromSettings(p)).toThrow(/範囲の外/);
    } finally {
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });

  test('上限ちょうどは通る', () => {
    const body =
      'cli:\n  agents:\n' +
      Array.from({ length: MAX_WORKERS }, (_, i) => `    ashigaru${i + 1}:\n      type: claude\n`).join('');
    const p = settings(body);
    try {
      expect(readRosterFromSettings(p).length).toBe(MAX_WORKERS);
    } finally {
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });

  test('cli.agents が無ければ受け付けぬ', () => {
    const p = settings('language: ja\n');
    try {
      expect(() => readRosterFromSettings(p)).toThrow(/cli.agents/);
    } finally {
      rmSync(join(p, '..'), { recursive: true, force: true });
    }
  });
});

describe('入れ替え', () => {
  test('足すのではなく入れ替える', () => {
    const db = mem();
    tx(db, () =>
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: null, model: null },
        { id: 'ashigaru1', role: 'worker', cli: null, model: null },
        { id: 'ashigaru2', role: 'worker', cli: null, model: null },
      ]),
    );
    // 足軽を減らした環境へ切り替える
    tx(db, () =>
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: null, model: null },
        { id: 'ashigaru1', role: 'worker', cli: null, model: null },
      ]),
    );
    expect(roster(db).map((e) => e.id)).toEqual(['ashigaru1', 'shogun']);
    // 消したはずの名が残ると、居ない相手へ送れてしまう
    expect(isKnown(db, 'ashigaru2')).toBe(false);
  });

  test('増減は台帳に残る', () => {
    const db = mem();
    tx(db, () => syncRoster(db, [{ id: 'shogun', role: 'commander', cli: null, model: null }]));
    tx(db, () =>
      syncRoster(db, [
        { id: 'shogun', role: 'commander', cli: null, model: null },
        { id: 'ashigaru1', role: 'worker', cli: null, model: null },
      ]),
    );
    const l = db.query("SELECT detail FROM ledger WHERE action = 'roster.sync' ORDER BY id").all() as {
      detail: string;
    }[];
    expect(l[1]?.detail).toContain('added=[ashigaru1]');
  });

  test('変わらなければ台帳を汚さぬ', () => {
    const db = mem();
    const r = [{ id: 'shogun', role: 'commander' as const, cli: null, model: null }];
    tx(db, () => syncRoster(db, r));
    tx(db, () => syncRoster(db, r));
    const n = (db.query("SELECT count(*) c FROM ledger WHERE action = 'roster.sync'").get() as {
      c: number;
    }).c;
    expect(n).toBe(1);
  });
});

describe('名簿に従って送る', () => {
  const seed = (db: ReturnType<typeof mem>, ids: string[]) =>
    tx(db, () =>
      syncRoster(
        db,
        ids.map((id) => ({ id, role: roleOf(id), cli: null, model: null })),
      ),
    );

  test('名簿が空なら書かせぬ', () => {
    const r = inboxWrite(':memory:', { flags: { to: 'karo', from: 'shogun', type: 'cmd_new', body: 'x' } }, true, {
      insideFormation: true,
      selfId: 'shogun',
    });
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('名簿が空');
    expect(r.err).toContain('roster sync');
  });

  // 足軽 2 体の環境で ashigaru5 が通ってはならない。
  // 固定の名簿を持っていると、ここが通ってしまう。
  test('居ない足軽へは送れぬ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-r2-'));
    const path = join(dir, 'x.db');
    try {
      seed(openStore({ path }), ['shogun', 'karo', 'ashigaru1', 'ashigaru2']);
      const r = inboxWrite(path, { flags: { to: 'ashigaru5', from: 'shogun', type: 'cmd_new', body: 'x' } }, true, {
        insideFormation: true,
        selfId: 'shogun',
      });
      expect(r.code).toBe(EXIT_INVALID);
      // 居る者だけを並べる。理論上の最大を並べては助言にならない
      expect(r.err).toContain('ashigaru1 / ashigaru2');
      expect(r.err).not.toContain('ashigaru5 /');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('居る足軽へは送れる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-r3-'));
    const path = join(dir, 'x.db');
    try {
      seed(openStore({ path }), ['shogun', 'karo', 'ashigaru1', 'ashigaru2']);
      const r = inboxWrite(path, { flags: { to: 'ashigaru2', from: 'shogun', type: 'cmd_new', body: 'x' } }, true, {
        insideFormation: true,
        selfId: 'shogun',
      });
      expect(r.code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未読数も名簿に従う', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honden-r4-'));
    const path = join(dir, 'x.db');
    try {
      seed(openStore({ path }), ['shogun', 'karo', 'ashigaru1']);
      expect(inboxUnread(path, 'ashigaru1').code).toBe(EXIT_OK);
      const r = inboxUnread(path, 'ashigaru5');
      expect(r.code).toBe(EXIT_INVALID);
      expect(r.err).toContain('いま居るのは');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('空の名簿', () => {
  test('空を見分けられる', () => {
    const db = mem();
    expect(isEmpty(db)).toBe(true);
    tx(db, () => syncRoster(db, [{ id: 'shogun', role: 'commander', cli: null, model: null }]));
    expect(isEmpty(db)).toBe(false);
  });
});
