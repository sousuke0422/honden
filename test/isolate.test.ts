/**
 * 隔離（床）の設定解きと包み。
 *
 * 芯は一つ——**頼んで得られなかったときに、黙って弱い方へ倒れぬこと。**
 * 未実装の段、支えられぬ規則、包めぬ命。いずれも拒んで止まる。
 */
import { describe, expect, test } from 'bun:test';
import { parseIsolation, wrapLaunch, requiredTools, dnsWarning, LEVELS, IMPLEMENTED } from '../src/isolate';

const y = (s: string) => Bun.YAML.parse(s);

describe('設定を解く', () => {
  test('isolation が無ければ none — 今の状態（殿の下知 2026-09-02）', () => {
    for (const doc of [y('cli: {default: claude}'), null, undefined, {}]) {
      const r = parseIsolation(doc);
      expect(r).toEqual({ ok: true, cfg: { level: 'none', outbound: false, tcpPorts: [] } });
    }
  });

  test('bwrap + outbound を受ける', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow:\n      - outbound\n'));
    expect(r).toEqual({ ok: true, cfg: { level: 'bwrap', outbound: true, tcpPorts: [] } });
  });

  test('bwrap で allow が空なら、外も無し', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n'));
    expect(r).toEqual({ ok: true, cfg: { level: 'bwrap', outbound: false, tcpPorts: [] } });
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
  const OUT = { level: 'bwrap', outbound: true, tcpPorts: [] as number[] } as const;
  const IN = { level: 'bwrap', outbound: false, tcpPorts: [] as number[] } as const;

  test('none はそのまま', () => {
    expect(wrapLaunch({ level: 'none', outbound: false, tcpPorts: [] }, 'claude --model x')).toEqual({ ok: true, cmd: 'claude --model x' });
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
    expect(requiredTools({ level: 'none', outbound: false, tcpPorts: [] })).toEqual([]);
    expect(requiredTools(IN)).toEqual(['bwrap']);
    expect(requiredTools(OUT).sort()).toEqual(['bwrap', 'pasta']);
  });
});

describe('口の許し（fw 機器の流儀・v2）', () => {
  test('tcp の並びを受ける', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [tcp/443, tcp/80]\n'));
    expect(r).toEqual({ ok: true, cfg: { level: 'bwrap', outbound: false, tcpPorts: [443, 80] } });
  });

  test('**udp は縛れぬと言って拒む**', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [udp/53]\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('TCP');
  });

  test('**outbound と tcp の混在は拒む**（広い方が勝って口の意図が消える）', () => {
    const r = parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [outbound, tcp/443]\n'));
    expect(r.ok).toBe(false);
  });

  test('口の範囲の外は拒む', () => {
    expect(parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [tcp/0]\n')).ok).toBe(false);
    expect(parseIsolation(y('isolation:\n  level: bwrap\n  net:\n    default: deny\n    allow: [tcp/70000]\n')).ok).toBe(false);
  });

  test('包み: pasta → bwrap → 檻 → CLI の順', () => {
    const r = wrapLaunch({ level: 'bwrap', outbound: false, tcpPorts: [443, 80] }, 'claude', '/x/bin/honden-cage');
    if (!r.ok) throw new Error(r.message);
    expect(r.cmd).toBe(
      "pasta --config-net -T none -U none --quiet -- bwrap --dev-bind / / --die-with-parent -- /x/bin/honden-cage --tcp 443 --tcp 80 -- bash -lc 'claude'",
    );
  });

  test('檻の在り処が無ければ包めぬと言う', () => {
    const r = wrapLaunch({ level: 'bwrap', outbound: false, tcpPorts: [443] }, 'claude');
    expect(r.ok).toBe(false);
  });

  test('口の許しにも pasta が要る（母屋の隔てと NAT）', () => {
    expect(requiredTools({ level: 'bwrap', outbound: false, tcpPorts: [443] }).sort()).toEqual(['bwrap', 'pasta']);
  });
});

describe('名前引きの罠（resolv.conf）', () => {
  test('母屋の loopback だけを向いておれば警める', () => {
    expect(dnsWarning('nameserver 127.0.0.53\n')).toContain('loopback');
    expect(dnsWarning('nameserver ::1\n')).toContain('loopback');
  });
  test('外の宛先が一つでもあれば黙る（WSL の形）', () => {
    expect(dnsWarning('nameserver 172.21.96.1\n')).toBeNull();
    expect(dnsWarning('nameserver 127.0.0.53\nnameserver 8.8.8.8\n')).toBeNull();
  });
  test('nameserver が読めねば黙る（別系の resolver かもしれぬ）', () => {
    expect(dnsWarning('# empty\n')).toBeNull();
  });
});
