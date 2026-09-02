/**
 * 隔離（床）の設定解きと包み。
 *
 * 芯は一つ——**頼んで得られなかったときに、黙って弱い方へ倒れぬこと。**
 * 未実装の段、支えられぬ規則、包めぬ命。いずれも拒んで止まる。
 */
import { describe, expect, test } from 'bun:test';
import { parseIsolation, wrapLaunch, requiredTools, LEVELS, IMPLEMENTED } from '../src/isolate';

const y = (s: string) => Bun.YAML.parse(s);

describe('設定を解く', () => {
  test('isolation が無ければ none — 今の状態（殿の下知 2026-09-02）', () => {
    for (const doc of [y('cli: {default: claude}'), null, undefined, {}]) {
      const r = parseIsolation(doc);
      expect(r).toEqual({ ok: true, cfg: { level: 'none', outbound: false } });
    }
  });

  test('bwrap + outbound を受ける', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow:\n      - outbound\n'));
    expect(r).toEqual({ ok: true, cfg: { level: 'bwrap', outbound: true } });
  });

  test('bwrap で allow が空なら、外も無し', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n'));
    expect(r).toEqual({ ok: true, cfg: { level: 'bwrap', outbound: false } });
  });

  test('**予約語の段は「隔離なし」に落ちず、拒む**', () => {
    for (const lv of ['systemd-run', 'lxc']) {
      const r = parseIsolation(y(`isolation:\n  level: ${lv}\n`));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('予約語');
    }
  });

  test('知らぬ段は拒む', () => {
    const r = parseIsolation(y('isolation:\n  level: chroot\n'));
    expect(r.ok).toBe(false);
  });

  test('**口ごとの粒度（tcp/443）は名指しで拒む**——書いたとおりに縛れぬ規則を受けぬ', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow:\n      - tcp/443\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('tcp/443');
      expect(r.message).toContain('outbound');
    }
  });

  test('default: allow は受けぬ（書き漏らしが全通しになる）', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: allow\n'));
    expect(r.ok).toBe(false);
  });

  test('net.deny の節は受けぬ（既定が deny。許す物だけを並べる）', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    deny: [x]\n'));
    expect(r.ok).toBe(false);
  });

  test('bwrap なのに net が無ければ拒む', () => {
    expect(parseIsolation(y('isolation:\n  level: bwrap\n')).ok).toBe(false);
  });

  test('段の一覧と実装済みの表は矛盾せぬ', () => {
    for (const l of IMPLEMENTED) expect(LEVELS).toContain(l);
  });
});

describe('包む', () => {
  const OUT = { level: 'bwrap', outbound: true } as const;
  const IN = { level: 'bwrap', outbound: false } as const;

  test('none はそのまま', () => {
    expect(wrapLaunch({ level: 'none', outbound: false }, 'claude --model x')).toEqual({ ok: true, cmd: 'claude --model x' });
  });

  test('outbound あり: pasta が外を作り、その中で bwrap（順序が肝）', () => {
    const r = wrapLaunch(OUT, 'claude --model x');
    if (!r.ok) throw new Error(r.message);
    expect(r.cmd).toBe(
      "pasta --config-net -T none -U none --quiet -- bwrap --dev-bind / / --die-with-parent -- bash -lc 'claude --model x'",
    );
    // -T none を落とすと母屋の loopback が中から見える（実測 2026-09-01）
    expect(r.cmd).toContain('-T none -U none');
    // bwrap 側で網を切ると pasta の路まで切れる
    expect(r.cmd).not.toContain('--unshare-net');
  });

  test('outbound なし: pasta ごと要らず、bwrap が網を切る', () => {
    const r = wrapLaunch(IN, 'codex --search');
    if (!r.ok) throw new Error(r.message);
    expect(r.cmd).toContain('--unshare-net');
    expect(r.cmd).not.toContain('pasta');
  });

  test('**単引用を含む命は包めぬと言って拒む**（黙って裸で起こさぬ）', () => {
    const r = wrapLaunch(OUT, "echo 'x'");
    expect(r.ok).toBe(false);
  });

  test('要る道具: outbound あり=pasta+bwrap / なし=bwrap / none=無し', () => {
    expect(requiredTools({ level: 'none', outbound: false })).toEqual([]);
    expect(requiredTools(IN)).toEqual(['bwrap']);
    expect(requiredTools(OUT).sort()).toEqual(['bwrap', 'pasta']);
  });
});
