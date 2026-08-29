/**
 * 命を構文で解いた形を受け取る。芯は `core/guard`（Rust・brush-parser）。
 *
 * # なぜ紋様から離れるか
 *
 * 門は生の文字列を紋様で当てておった。四度継ぎを当てて限界が見えた
 * （`docs/decisions.md` 十八）。最後の一枚が最も雄弁である——
 * **引用の中の字面が、命と区別できなんだ**。決め書きを書く手が、その中の
 * 危うい字面に当たって己の門に弾かれた（将軍が二度）。
 *
 * 構文を解けば一目で分かる。`echo "rm -rf /"` の `rm` は命令位置に居らぬ。
 *
 * # ここは**必ず拒みへ倒れる**
 *
 * 解けぬ・畳めぬ・道具が無い・落ちた・返事が読めぬ——**全て同じ一つの型**
 * （`ok: false` と理由）に畳んである。呼ぶ側が「この場合は通してよいか」と
 * 迷う余地を残さぬため。
 *
 * 迷う余地があれば、いつか誰かが通す。**新しい層は fail-open として生まれる**
 * ——本日そう四度書いた。型で塞ぐのが最も確かである。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 語ひとつの素性。**引用されておるか**が最も重い。 */
export interface Word {
  /** 書かれたままの姿（引用も含む） */
  text: string;
  /**
   * **引用を剥いだ値。掟はこちらに照らす。**
   *
   * `rm -rf "/"` は `rm -rf /` と同じ害であり、引用したからとて赦されぬ。
   * 展開（`$X` / `$(…)`）は走らせるまで判らぬゆえ、書かれたまま残る。
   */
  value: string;
  /** 語の全体が引用に包まれておる。引用の中の `rm` は命ではない */
  quoted: boolean;
  /** 引用の外に `*` `?` `[` がある */
  glob: boolean;
  /** 引用の外に変数展開がある（中身は走らせるまで判らぬ） */
  var: boolean;
  /** 命令置換を含む */
  cmdsubst: boolean;
}

/** 単純命令ひとつ。`argv[0]` が命令位置である。 */
export interface Cmd {
  argv: Word[];
  assigns: string[];
}

export type Parsed =
  | {
      ok: true;
      commands: Cmd[];
      /** heredoc の中身。**命令位置には決して入らぬ** */
      heredocs: string[];
      /** 命令置換の中身。要れば再帰して解ける */
      substitutions: string[];
    }
  | { ok: false; reason: string };

/** 解く手。試験では贋物を注ぐ（`identity.ts` の lookup と同じ流儀）。 */
export type Runner = (input: string) => { ok: boolean; stdout: string };

export function parserPath(root: string): string {
  return join(root, 'bin', 'honden-parse');
}

/**
 * 実物の手。**道具が無ければ拒みへ倒れる**——「無いから素通し」は
 * 見張りが黙って消える型そのもの。
 */
export function realRunner(root: string): Runner {
  return (input: string) => {
    const bin = parserPath(root);
    if (!existsSync(bin)) return { ok: false, stdout: '' };
    try {
      const p = Bun.spawnSync([bin], { stdin: Buffer.from(input) });
      return { ok: p.success, stdout: new TextDecoder().decode(p.stdout) };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
}

/** 芯が返す生の形。ここでしか使わぬ。 */
interface Raw {
  ok: boolean;
  error?: string;
  complete?: boolean;
  commands?: { argv?: Partial<Word>[]; assigns?: string[] }[];
  heredocs?: string[];
  substitutions?: string[];
  unhandled?: string[];
}

/** 語の素性は**欠けたら真**に倒す——「印が無い」を「安全」と読まぬため。 */
function word(w: Partial<Word> | undefined): Word {
  const text = typeof w?.text === 'string' ? w.text : '';
  return {
    text,
    // 値が無ければ書かれたままを使う。**掟が何も見ぬ状態にはせぬ。**
    value: typeof w?.value === 'string' ? w.value : text,
    quoted: w?.quoted !== false,
    glob: w?.glob !== false,
    var: w?.var !== false,
    cmdsubst: w?.cmdsubst !== false,
  };
}

/**
 * 芯の返事を型へ畳む。**読めぬ返事は拒み。**
 *
 * `complete: false`（畳めぬ部分がある）も拒みに落とす。中途半端な argv を
 * 全体と思うて掟に照らせば、隠れた命が門の外を素通りする——
 * 成功の顔をした fail-open になる。
 */
export function interpret(ok: boolean, stdout: string): Parsed {
  if (!ok) return { ok: false, reason: '構文の解き手が応えぬ（bin/honden-parse が無いか落ちた）' };
  let raw: Raw;
  try {
    raw = JSON.parse(stdout) as Raw;
  } catch {
    return { ok: false, reason: '構文の解き手の返事を読めぬ' };
  }
  if (raw.ok !== true) {
    return { ok: false, reason: `命を構文で解けぬ: ${raw.error ?? '（理由不明）'}` };
  }
  if (raw.complete !== true) {
    const why = (raw.unhandled ?? []).join(' / ') || '（内訳不明）';
    return { ok: false, reason: `解けたが畳めぬ部分がある: ${why}` };
  }
  return {
    ok: true,
    commands: (raw.commands ?? []).map((c) => ({
      argv: (c.argv ?? []).map(word),
      assigns: Array.isArray(c.assigns) ? c.assigns : [],
    })),
    heredocs: Array.isArray(raw.heredocs) ? raw.heredocs : [],
    substitutions: Array.isArray(raw.substitutions) ? raw.substitutions : [],
  };
}

export function parseCommand(cmd: string, run: Runner): Parsed {
  const r = run(cmd);
  return interpret(r.ok, r.stdout);
}

/**
 * 命令位置に立つ語だけを返す。掟の多くはここだけ見れば足りる。
 *
 * 引用された語は**命ではない**ゆえ除く——`echo "rm -rf /"` の `rm` を
 * 命と数えたのが、これまでの誤検知の源であった。
 */
export function commandNames(p: Parsed): string[] {
  if (!p.ok) return [];
  const out: string[] = [];
  for (const c of p.commands) {
    const head = c.argv[0];
    if (head && !head.quoted && head.text !== '') out.push(head.text);
  }
  return out;
}

/**
 * 掟を照らす単位を組む。
 *
 * # なぜ「単位」なのか
 *
 * 紋様の錨 `(?:^|[;&|]\s*)` は命令位置の**近似**にすぎず、実測で六つ破れた
 * （2026-08-30）——改行・`if … then`・`$( )`・`for … do`・`{ … }` の中では
 * 絶対域の D001 すら素通りしておった。
 *
 * 構造なら近似が要らぬ。**単純命令ひとつを一つの単位**として渡せば、
 * その先頭が命令位置そのものである。紋様は書き換えずに済み、
 * 錨がただ本物になる。
 *
 * 値は引用を剥いだもの（`rm -rf "/"` → `rm -rf /`）。
 */
export function units(p: Parsed): string[] {
  if (!p.ok) return [];
  return p.commands
    .map((c) => c.argv.map((w) => w.value).join(' ').trim())
    .filter((u) => u !== '');
}

/**
 * 命令置換の中身は**別の命**である。門は再帰して解く。
 *
 * `x=$(rm -rf /)` が素通りしておった筋がこれ（実測）。深さは限る——
 * 際限なく潜れば、細工された入力で門が止まる。
 */
export function substUnits(p: Parsed, run: Runner, depth = 2): string[] {
  if (!p.ok || depth <= 0) return [];
  const out: string[] = [];
  for (const s of p.substitutions) {
    const inner = parseCommand(s, run);
    out.push(...units(inner), ...substUnits(inner, run, depth - 1));
  }
  return out;
}

/**
 * heredoc の中身を掟に照らすか。
 *
 * **貰い手による。** `python3 <<EOF` の中身は python への文字であって命ではない
 * ——将軍が己の門に二度弾かれたのがこの形。だが `bash <<EOF` の中身は**命**で
 * あり、照らさねば素通りする。
 *
 * 構文では見分けられぬ（`docs/decisions.md` 十八の「AST でも買えぬもの」）。
 * ゆえに貰い手の名で決める。名簿は短く、明示で持つ。
 */
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'source', '.']);

export function heredocUnits(p: Parsed, run: Runner): string[] {
  if (!p.ok || p.heredocs.length === 0) return [];
  const toShell = p.commands.some((c) => {
    const head = c.argv[0];
    if (!head) return false;
    const base = head.value.split('/').pop() ?? head.value;
    return SHELLS.has(base);
  });
  if (!toShell) return [];
  const out: string[] = [];
  for (const h of p.heredocs) {
    out.push(...units(parseCommand(h, run)));
  }
  return out;
}
