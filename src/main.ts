/**
 * honden の入口。
 *
 * 影の段では、shogun 側へは一切書かない。取り込みと検索だけを提供する。
 *
 * 書き戻し (正本 → queue/**.yaml) を入れると書き手が 2 人になる。honden が
 * 吐いたそばからエージェントが同じファイルへ書き、後から書いたほうが相手を潰す。
 * 切り替えの日を決めるまでは、影に徹するのが安全になる。
 */

import { openStore, search, tx, type Hit } from './store';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importTree, collectYaml, type ImportResult } from './import';
import { ingestAll } from './ingest';
import { inboxWrite, inboxUnread, parseFlags, fromPositional, EXIT_OK, EXIT_INVALID, EXIT_SYSTEM } from './cli';
import { readRosterFromSettings, syncRoster, roster, RosterError } from './roster';
import { readLimitsFromSettings, syncLimits, recommend } from './routing';
import type { RunResult } from './cli';

/** 取り込む対象。config は秘密を含みうるので既定では入れない。 */
const DEFAULT_SUBDIRS = ['queue', 'saytask'];

export function runImport(
  dbPath: string | undefined,
  root: string,
  subdirs: string[],
): RunResult {
  const db = openStore({ path: dbPath });
  const t0 = Bun.nanoseconds();
  let r: ImportResult;
  try {
    r = importTree(db, root, subdirs);
  } catch (e) {
    return { code: EXIT_SYSTEM, err: `取り込みが止まった: ${String(e).slice(0, 300)}` };
  }
  // 本文を入れたあと、形が読めたものを型のある表へ写す。
  const files = subdirs
    .flatMap((s) => collectYaml(join(root, s)))
    .map((p) => ({ path: relative(root, p).split('\\').join('/'), body: readFileSync(p, 'utf8') }));
  const ing = ingestAll(db, root, files);
  const ms = ((Bun.nanoseconds() - t0) / 1e6).toFixed(0);

  const lines = [
    `  走査 ${r.scanned}  取込 ${r.imported}  据置 ${r.skipped}  ${ms}ms`,
    `  構造化: inbox ${ing.inbox} / task ${ing.task} / report ${ing.report}（読めず飛ばした ${ing.skipped}）`,
  ];
  if (r.outstanding > 0) {
    // 当たった件数ではなく残っている件数を出す。sha256 が変わっていないファイルは
    // 素通りするので、当たった数だけを見ると残りが消えたように見える。
    lines.push(`  難あり ${r.outstanding} 件が残っておる（この回で当たったのは ${r.issues.length} 件）:`);
    const rows = db
      .query('SELECT path, kind, detail FROM import_issue ORDER BY path')
      .all() as { path: string; kind: string; detail: string }[];
    for (const i of rows) lines.push(`    [${i.kind}] ${i.path}  ${i.detail}`);
  }
  // 難ありが残っているうちは非ゼロで終わる。黙って 0 を返すと、
  // 呼んだ側は「全部入った」と読む。
  return { code: r.outstanding > 0 ? EXIT_INVALID : EXIT_OK, out: lines.join('\n') };
}

/** `honden roster sync --settings <settings.yaml>` — 顔ぶれを入れ替える。 */
export function runRosterSync(dbPath: string | undefined, settingsPath: string | undefined): RunResult {
  if (!settingsPath) {
    return {
      code: EXIT_INVALID,
      err:
        '名簿の出所が要る。\n' +
        '  honden roster sync --settings <環境の settings.yaml>\n' +
        '  cli.agents の鍵がそのまま顔ぶれになる。',
    };
  }
  let entries;
  try {
    entries = readRosterFromSettings(settingsPath);
  } catch (e) {
    if (e instanceof RosterError) return { code: EXIT_INVALID, err: `  ${e.message}` };
    return { code: EXIT_SYSTEM, err: String(e).slice(0, 300) };
  }
  const limits = readLimitsFromSettings(settingsPath);
  const db = openStore({ path: dbPath });
  tx(db, () => {
    syncRoster(db, entries);
    syncLimits(db, limits);
  });
  const w = entries.filter((e) => e.role === 'worker');
  return {
    code: EXIT_OK,
    out:
      `  ${entries.length} 人（上役 ${entries.length - w.length} / 足軽 ${w.length}）\n` +
      entries.map((e) => `    ${e.id.padEnd(10)} ${e.role.padEnd(9)} ${e.cli ?? ''} ${e.model ?? ''}`).join('\n') +
      `\n  能力制限 ${limits.filter((l) => l.maxBloom < 6).length} 件（表に無いモデルは制限なし）`,
  };
}

/** `honden roster` — いまの顔ぶれ。 */
export function runRosterShow(dbPath: string | undefined): RunResult {
  const db = openStore({ path: dbPath });
  const r = roster(db);
  if (r.length === 0) {
    return {
      code: EXIT_INVALID,
      err: '名簿が空である。\n  honden roster sync --settings <settings.yaml> で入れられよ。',
    };
  }
  return {
    code: EXIT_OK,
    out: r.map((e) => `  ${e.id.padEnd(10)} ${e.role.padEnd(9)} ${e.cli ?? ''} ${e.model ?? ''}`).join('\n'),
  };
}

/** `honden route <bloom>` — 誰に振れるかを挙げる。 */
export function runRoute(
  dbPath: string | undefined,
  bloomRaw: string | undefined,
  role: string | undefined,
  providers: string | undefined,
  busy: string | undefined,
): RunResult {
  const bloom = Number(String(bloomRaw ?? '').replace(/^[Ll]/, ''));
  if (!Number.isFinite(bloom)) {
    return {
      code: EXIT_INVALID,
      err: '難度が要る。\n  honden route <1-6> [--role worker] [--providers openai,anthropic] [--busy a,b]',
    };
  }
  if (role && role !== 'worker' && role !== 'commander') {
    return { code: EXIT_INVALID, err: `役は worker か commander。受け取った値: ${JSON.stringify(role)}` };
  }
  const db = openStore({ path: dbPath });
  const r = recommend(db, {
    bloom,
    role: role as 'worker' | 'commander' | undefined,
    allowedProviders: providers ? providers.split(',').filter(Boolean) : undefined,
    busy: busy ? busy.split(',').filter(Boolean) : undefined,
  });
  if (!r.ok) return { code: EXIT_INVALID, err: `  ${r.message}` };
  const sw =
    r.switchable.length > 0
      ? '\n  切り替えれば足りる者もおる:\n' +
        r.switchable.map((s) => `    ${s.agent}: ${s.from} → ${s.to}`).join('\n')
      : '';
  return {
    code: EXIT_OK,
    out:
      `  L${bloom} に振れる者（足りる中で軽い順）\n` +
      r.candidates
        .map((c) => `    ${c.agent.padEnd(10)} ${c.model.padEnd(16)} ${c.provider.padEnd(10)} L${c.maxBloom} まで`)
        .join('\n') + sw,
  };
}

export function runSearch(dbPath: string | undefined, query: string, limit: number): RunResult {
  if (query.trim() === '') {
    return {
      code: EXIT_INVALID,
      err: '探す語が無い。\n  honden search <語> [--limit N]',
    };
  }
  const db = openStore({ path: dbPath });
  let hits: Hit[];
  try {
    hits = search(db, query, limit);
  } catch (e) {
    return { code: EXIT_SYSTEM, err: `検索が止まった: ${String(e).slice(0, 300)}` };
  }
  if (hits.length === 0) {
    return {
      code: EXIT_OK,
      out:
        `  「${query}」は見つからぬ。\n` +
        '  語の途中からは当たらぬ造りゆえ、語の頭から打たれよ。\n' +
        '  取り込みが済んでおるかは honden import で確かめられる。',
    };
  }
  const lines = [`  「${query}」 ${hits.length} 件`];
  for (const h of hits) lines.push(`    ${h.kind.padEnd(8)} ${h.source ?? h.ref ?? ''}`);
  return { code: EXIT_OK, out: lines.join('\n') };
}

const USAGE = `honden — 多エージェント運用の差配層

  honden roster sync --settings <settings.yaml>        顔ぶれを入れ替える
  honden roster                                        いまの顔ぶれ
  honden import [--root PATH] [--sub queue,saytask]   shogun の YAML を取り込む
  honden route <1-6> [--role worker] [--providers ...] 誰に振れるかを挙げる
  honden search <語> [--limit N]                       取り込んだものを引く
  honden inbox write <宛先> <本文> <種別> <差出人>      旧 inbox_write.sh と同じ並び
  honden inbox write --to A --from B --type T --body 本文
  honden inbox write <<'EOF'
    to: karo
    from: shogun
    type: cmd_new
    body: |
      本文
  EOF
  honden inbox unread <agent>                          手動 nudge 用の未読数

  --dry-run  読み取り結果だけ見せて書き込まない
  --db PATH  正本の場所 (既定 ~/.honden/honden.db)

並び順・旗・標準入力は、どれか一つを使う。二つ以上渡すと弾かれる。
長い本文は EOF が向いておる。シェルが引用符に手を入れぬゆえ。

布陣の外 (TMUX_PANE が無い) から送るときは、役職を騙れぬ。
review_session / external_audit のような、外だと分かる名を from に使うこと。

いまは影の段で、shogun 側の YAML へは一切書かない。

顔ぶれは環境ごとに違う。足軽は 1 体から 7 体まで。
まず roster sync で入れること。名簿が空のままでは送れない。
`;

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  const dryRun = flags['dry-run'] === 'true';
  delete flags['dry-run'];
  const dbPath = flags['db'];
  delete flags['db'];

  const emit = (r: RunResult): number => {
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.code;
  };

  if (rest[0] === 'import') {
    const root = flags['root'] ?? process.cwd();
    const subs = (flags['sub'] ?? DEFAULT_SUBDIRS.join(',')).split(',').filter(Boolean);
    delete flags['root'];
    delete flags['sub'];
    return emit(runImport(dbPath, root, subs));
  }

  if (rest[0] === 'roster') {
    if (rest[1] === 'sync') {
      const s = flags['settings'];
      delete flags['settings'];
      return emit(runRosterSync(dbPath, s));
    }
    return emit(runRosterShow(dbPath));
  }

  if (rest[0] === 'route') {
    const role = flags['role']; const providers = flags['providers']; const busy = flags['busy'];
    delete flags['role']; delete flags['providers']; delete flags['busy'];
    return emit(runRoute(dbPath, rest[1], role, providers, busy));
  }

  if (rest[0] === 'search') {
    const limit = Number(flags['limit'] ?? '20');
    delete flags['limit'];
    return emit(runSearch(dbPath, rest.slice(1).join(' '), Number.isFinite(limit) ? limit : 20));
  }

  if (rest[0] === 'inbox' && rest[1] === 'write') {
    const positional = fromPositional(rest.slice(2));
    if (positional && Object.keys(flags).length > 0) {
      console.error('並び順の引数と旗の両方が来ておる。どちらが効いたのか分からなくなるゆえ、片方にされよ。');
      return EXIT_INVALID;
    }
    if (rest.length > 2 && !positional) {
      console.error(
        `並び順で渡すなら 4 つ要る (受け取ったのは ${rest.length - 2} つ)。\n` +
          '  honden inbox write <宛先> <本文> <種別> <差出人>\n' +
          '  旗や EOF でも渡せる。書き込みは行っておらぬ。',
      );
      return EXIT_INVALID;
    }
    const stdin = process.stdin.isTTY ? undefined : await Bun.stdin.text();
    const pane = process.env.TMUX_PANE ?? '';
    const insideFormation = pane !== '';
    // 名乗りは環境から取る。引数の from とは突き合わせるだけで、信じない。
    // skills/external-to-shogun の Step 0 と同じ。TMUX_PANE が空のまま
    // tmux display-message を打つと、アクティブな他人の @agent_id を返す。
    let selfId = process.env.HONDEN_AGENT_ID?.trim();
    if (!selfId && insideFormation) {
      const p = Bun.spawnSync(['tmux', 'display-message', '-t', pane, '-p', '#{@agent_id}']);
      const got = p.success ? new TextDecoder().decode(p.stdout).trim() : '';
      selfId = got === '' ? undefined : got;
    }
    return emit(
      inboxWrite(dbPath, { flags: positional ?? flags, stdin }, dryRun, { insideFormation, selfId }),
    );
  }

  if (rest[0] === 'inbox' && rest[1] === 'unread') {
    return emit(inboxUnread(dbPath, rest[2] ?? ''));
  }

  console.error(USAGE);
  return EXIT_INVALID;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
