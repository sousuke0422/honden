/**
 * honden の唯一の書き口。
 *
 * ## 入口は 2 つ、検査は 1 つ
 *
 * 各項を旗で渡してもよいし、その節の YAML を標準入力へ流してもよい。
 * どちらで入っても同じ検査を通る。通らなければ EOF 側が型の抜け道になる。
 *
 *   honden inbox write --to karo --type cmd_new --from shogun --body "短い用件"
 *
 *   honden inbox write <<'EOF'
 *   to: karo
 *   type: cmd_new
 *   from: shogun
 *   body: |
 *     長い本文。バックスラッシュも ''' も $ もそのまま通る。
 *   EOF
 *
 * EOF を引用符で囲めばシェルが一切手を触れない。旧 inbox_write.sh は本文を
 * Python のソースへ直に展開していたので、\n が黙って実改行に化け、Windows パスや
 * ''' を含む本文は送信そのものが失敗した。この形にすればその筋が消える。
 *
 * ## 終了コード
 *
 *   0  通った
 *   2  入力が受け付けられぬ (何が駄目かは stderr に全件出る。書き込みはしていない)
 *   1  それ以外の失敗
 */

import { openStore, tx, journal } from './store';
import { validate, explain, type Schema } from './validate';

export const EXIT_OK = 0;
export const EXIT_SYSTEM = 1;
export const EXIT_INVALID = 2;

const AGENTS = [
  'shogun', 'karo', 'gunshi',
  'ashigaru1', 'ashigaru2', 'ashigaru3', 'ashigaru4',
  'ashigaru5', 'ashigaru6', 'ashigaru7',
] as const;

const INBOX_SCHEMA: Schema = {
  to: { required: true, oneOf: AGENTS, about: '宛先の agent' },
  from: { required: true, oneOf: AGENTS, about: '差出人の agent' },
  type: { required: true, about: 'cmd_new / task_assigned / report_received など' },
  body: { required: true, about: '本文。長いものは EOF 側で渡すとよい' },
};

/** 旗を解く。`--k v` と `--k=v` の両方を受ける。 */
export function parseFlags(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[body] = 'true'; continue; }
    flags[body] = next;
    i++;
  }
  return { flags, rest };
}

export interface InputSource {
  /** 旗。--dry-run のような制御旗は除いてある。 */
  flags: Record<string, string>;
  /** 標準入力の中身。端末なら undefined。 */
  stdin?: string;
}

/**
 * 旗と EOF のどちらか一方を採る。
 *
 * 両方来たら弾く。黙って片方を優先すると、どちらが効いたのか撃った側に分からない。
 */
export function pickInput(src: InputSource): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const hasFlags = Object.keys(src.flags).length > 0;
  const hasStdin = src.stdin !== undefined && src.stdin.trim() !== '';

  if (hasFlags && hasStdin) {
    return {
      ok: false,
      message:
        '旗と標準入力の両方が来ておる。どちらが効いたのか分からなくなるゆえ、片方にされよ。\n' +
        '  長い本文なら EOF 側、短い更新なら旗が向いておる。',
    };
  }
  if (!hasFlags && !hasStdin) {
    return {
      ok: false,
      message:
        '入力が無い。旗で渡すか、その節の YAML を標準入力へ流されよ。\n' +
        "  例: honden inbox write --to karo --type cmd_new --from shogun --body '用件'\n" +
        "      honden inbox write <<'EOF'\n" +
        '        to: karo\n' +
        '        …\n' +
        '      EOF',
    };
  }
  if (hasStdin) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(src.stdin!);
    } catch (e) {
      return {
        ok: false,
        message:
          `標準入力が YAML として読めぬ: ${String(e).slice(0, 160)}\n` +
          "  EOF は引用符で囲まれておるか確かめられよ (<<'EOF')。囲まぬとシェルが本文へ手を入れる。",
      };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '標準入力は「鍵: 値」の形で書かれよ。一覧や素の値は受けられぬ。' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  }
  return { ok: true, value: { ...src.flags } };
}

export interface RunResult {
  code: number;
  out?: string;
  err?: string;
}

/** `honden inbox write` の中身。 */
export function inboxWrite(dbPath: string | undefined, src: InputSource, dryRun: boolean): RunResult {
  const picked = pickInput(src);
  if (!picked.ok) return { code: EXIT_INVALID, err: picked.message };

  const problems = validate(INBOX_SCHEMA, picked.value);
  if (problems.length > 0) {
    return {
      code: EXIT_INVALID,
      err: explain(problems, "本文が長いなら <<'EOF' で流すと引用符に悩まされぬ。"),
    };
  }

  const v = picked.value as { to: string; from: string; type: string; body: string };
  const at = new Date().toISOString();
  const id = `msg_${at.replace(/[-:.TZ]/g, '')}_${Bun.hash(v.body + at).toString(16).slice(0, 8)}`;
  const summary =
    `  宛: ${v.to}  差出: ${v.from}  種: ${v.type}\n` +
    `  本文 ${[...v.body].length} 文字 / ${v.body.replace(/\n$/, '').split('\n').length} 行\n` +
    `  ${v.body.split('\n')[0]?.slice(0, 60) ?? ''}`;

  if (dryRun) return { code: EXIT_OK, out: `${summary}\n  → 書き込んでおらぬ (--dry-run)` };

  const db = openStore({ path: dbPath });
  tx(db, () => {
    db.prepare(
      'INSERT INTO inbox(id, agent, created_at, msg_type, sender, body, read) VALUES (?,?,?,?,?,?,0)',
    ).run(id, v.to, at, v.type, v.from, v.body);
    journal(db, { actor: v.from, action: 'inbox.write', target: v.to, detail: v.type });
  });
  return { code: EXIT_OK, out: `${summary}\n  → ${id}` };
}

const USAGE = `honden — 多エージェント運用の差配層

  honden inbox write [--to A --from B --type T --body 本文] [--dry-run]
  honden inbox write [--dry-run] <<'EOF'
    to: karo
    from: shogun
    type: cmd_new
    body: |
      本文
  EOF

旗と標準入力は、どちらか一方を使う。両方渡すと弾かれる。
`;

export async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv);
  const dryRun = flags['dry-run'] === 'true';
  delete flags['dry-run'];
  const dbPath = flags['db'];
  delete flags['db'];

  const stdin = process.stdin.isTTY ? undefined : await Bun.stdin.text();

  if (rest[0] === 'inbox' && rest[1] === 'write') {
    const r = inboxWrite(dbPath, { flags, stdin }, dryRun);
    if (r.out) console.log(r.out);
    if (r.err) console.error(r.err);
    return r.code;
  }

  console.error(USAGE);
  return EXIT_INVALID;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
