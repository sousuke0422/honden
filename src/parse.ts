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

/**
 * **後で実行される命**を取り出す。
 *
 * # なぜ `units` では足りぬか
 *
 * `units` は解析器が返した単純命令をそのまま並べる。だが命の中には、
 * **別の命を起こすもの**がある。
 *
 * ```
 * sh -c 'rm -rf /'              引用の中は文字ではなく命である
 * find /tmp -exec rm -rf / \;   -exec の後ろは命である
 * env -i rm -rf /               包み。中の命が本体
 * chroot / rm -rf /             同上
 * ```
 *
 * `units` はこれらを一つの命として返し、門は `sh` や `find` を見て通す。
 * 実測（2026-09-01・二度目の監査が釣った）——`sh -c '…'`、`bash -lc '…'`、
 * `chroot / …`、`flock /tmp/x …`、`find -exec …`、`ssh host '…'`、
 * いずれも**素通りしておった**。
 *
 * # 名の一覧で追うのをやめる
 *
 * 一度目の直しでは「包みの名」を数えて剥がした。**筋が違った。**
 * 問いは「これは包みか」ではなく、**「この語は、後で命として実行されるか」**
 * である。名を増やしても追いつかぬ。
 *
 * ゆえに**包みごとに旗を正しく読み**、命の位置に来た語を取り出し、
 * 文字列として渡される命（`-c` の後ろ）は**解き直して再帰する**。
 *
 * # 解けぬなら通さぬ
 *
 * 命の名が変数や命令置換なら（`$SHELL -c …`、`${CMD:-rm} …`）、走らせるまで
 * 判らぬ。**判らぬ物は拒む。** 深さや数の上限に達した時も同じ——
 * 一度目の直しは上限に達したら通しており、無害な候補で枠を食い潰す形で
 * 素通りできた（実測）。
 */
export interface ExecScan {
  /** 実際に走る命（argv を空白で繋いだ形） */
  units: string[];
  /** 解けなんだ理由。**在れば拒む** */
  unresolved?: string;
}

/** 名から道を落とす。`/bin/rm` → `rm`。 */
export function baseName(w: string): string {
  const i = w.lastIndexOf('/');
  return i < 0 ? w : w.slice(i + 1);
}

/**
 * 包みの仕様。**旗をどう読むかを、包みごとに書く。**
 *
 * `value`: 値を一つ取る旗。`pos`: 命の前に来る位置引数の数。
 *
 * 一度目の直しは「包みの後にある命らしき語すべて」を候補にした。
 * 乱暴すぎた——`env echo rm -rf /` を止めてしまう（`echo` の引数にすぎぬ）。
 * **旗を正しく読めば、命の位置は一つに定まる。**
 */
const WRAP: Record<string, { value?: string[]; pos?: number; scriptFlag?: string; script?: 'rest' }> = {
  env: { value: ['-u', '--unset', '-C', '--chdir'] },
  command: {},
  builtin: {},
  exec: { value: ['-a'] },
  nohup: {},
  setsid: {},
  doas: { value: ['-u'] },
  stdbuf: { value: ['-i', '-o', '-e'] },
  nice: { value: ['-n'] },
  ionice: { value: ['-c', '-n', '-p'] },
  time: {},
  watch: { value: ['-n', '--interval'] },
  unshare: { value: ['--map-user', '--map-group', '--setuid', '--setgid'] },
  xargs: { value: ['-n', '-I', '-P', '-a', '-d', '-E', '-s', '--replace', '--max-args'] },
  parallel: { value: ['-j', '-N'] },
  // 位置引数を一つ食ってから命が来る
  timeout: { value: ['-s', '--signal', '-k', '--kill-after'], pos: 1 },
  chroot: { value: ['--userspec', '--groups'], pos: 1 },
  // **ssh は遠方の shell へ文字列を渡す。** 位置引数（host）の後は argv では
  // なく一つの文字列であることが多い。shell と同じく解き直す。
  // 遠方で走るとて、我らが撃たせておることに変わりはない。
  ssh: { value: ['-p', '-i', '-l', '-o', '-F'], pos: 1, script: 'rest' },
  // 文字列で命を渡す旗を持つ包み
  flock: { value: ['-w', '--timeout', '-E', '--conflict-exit-code'], pos: 1, scriptFlag: '-c' },
  runuser: { value: ['-u', '-g', '-G'], scriptFlag: '-c' },
};

const MAX_UNITS = 64;

/** 文字列で渡された命を解き直して降りる。 */
function descendScript(w: Word, run: Runner, depth: number, out: ExecScan): void {
  if (w.var || w.cmdsubst) {
    out.unresolved = out.unresolved ?? '走らせる文字列が展開に依っておる';
    return;
  }
  const inner = parseCommand(w.value, run);
  if (!inner.ok) {
    out.unresolved = out.unresolved ?? `走らせる文字列を解けぬ（${inner.reason}）`;
    return;
  }
  for (const c of inner.commands) resolveArgv(c.argv, run, depth - 1, out);
}

/** 一つの argv を辿り、実際に走る命へ降りる。 */
function resolveArgv(argv: Word[], run: Runner, depth: number, out: ExecScan): void {
  if (depth <= 0 || out.units.length >= MAX_UNITS) {
    out.unresolved = out.unresolved ?? '入れ子が深すぎる、または命が多すぎる';
    return;
  }
  if (argv.length === 0) return;

  const head = argv[0]!;
  // **命の名が判らぬなら拒む。** `$SHELL -c …` や `${CMD:-rm} …` は
  // 走らせるまで何が起きるか判らぬ
  if (head.var || head.cmdsubst) {
    out.unresolved = out.unresolved ?? `命の名が展開に依っておる（${head.text}）`;
    return;
  }
  const name = baseName(head.value);
  // **名から道を落として出す。** `/bin/rm -rf /` を書かれたまま渡すと、
  // 紋様の行頭アンカーが外れて素通りする（実測 2026-09-01）。
  // 判ずるのは「何が走るか」であって、どう書かれたかではない。
  const emit = () => out.units.push([name, ...argv.slice(1).map((w) => w.value)].join(' '));

  // ── shell へ文字列で渡された命は、解き直す ──
  if (SHELLS.has(name)) {
    const ci = argv.findIndex((w, i) => i > 0 && !w.quoted && /^-[a-z]*c[a-z]*$/.test(w.value));
    if (ci >= 0 && ci + 1 < argv.length) {
      descendScript(argv[ci + 1]!, run, depth, out);
      return;
    }
    emit();
    return;
  }

  // ── find の -exec / -execdir ──
  if (name === 'find') {
    const ei = argv.findIndex((w) => w.value === '-exec' || w.value === '-execdir');
    if (ei >= 0) {
      const rest = argv.slice(ei + 1);
      // 終端は `;` `\;` `+`。**書かれ方が幾通りもある**——shell に食われぬよう
      // 逃がすのが常で、解析器は `\;` をそのまま値に持つ（実測 2026-09-01）
      const end = rest.findIndex((w) => w.value === ';' || w.value === '\\;' || w.value === '+');
      resolveArgv(end >= 0 ? rest.slice(0, end) : rest, run, depth - 1, out);
      return;
    }
    emit();
    return;
  }

  // ── 包み。旗を読んで、命の位置まで進む ──
  const spec = WRAP[name];
  if (!spec) {
    emit();
    return;
  }
  let i = 1;
  let pos = spec.pos ?? 0;
  while (i < argv.length) {
    const v = argv[i]!.value;
    if (spec.scriptFlag && v === spec.scriptFlag && i + 1 < argv.length) {
      descendScript(argv[i + 1]!, run, depth, out);
      return;
    }
    if (/^\w+=/.test(v)) { i++; continue; }
    if (v === '--') { i++; break; }
    if (v.startsWith('-')) {
      i += spec.value?.includes(v) ? 2 : 1;
      continue;
    }
    if (pos > 0) { pos--; i++; continue; }
    break;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) {
    // 包みだけで命が無い（`env` 単体など）。害は無い
    emit();
    return;
  }
  // 残りが「一つの文字列としての命」なら、解き直す（ssh の類）
  if (spec.script === 'rest' && rest.length === 1) {
    descendScript(rest[0]!, run, depth, out);
    return;
  }
  resolveArgv(rest, run, depth - 1, out);
}

/** 実際に走る命を、包みと文字列越しの入れ子まで辿って集める。 */
export function execUnits(p: Parsed, run: Runner, depth = 4): ExecScan {
  const out: ExecScan = { units: [] };
  if (!p.ok) return { units: [], unresolved: p.reason };
  for (const c of p.commands) resolveArgv(c.argv, run, depth, out);
  return out;
}
