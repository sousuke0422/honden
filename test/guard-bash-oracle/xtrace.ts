/**
 * 箱の中の bash の xtrace（recorder.sh の PS4 = `\x01<関数の名>\x02`）を、単純命令ごとの argv に戻す。
 *
 * bash の xtrace は、展開・引用の除去・$IFS の分割・brace 展開の後の語を、要れば引用し直して出す:
 * - 字だけの語はそのまま
 * - shell の字を含む語は `'…'`（中の `'` は `'\''`）
 * - 制御の字を含む語は `$'…'`（C の escape）
 * 件の頭は \x01 の連なり（入れ子の深さの分だけ繰り返る）。件の行は最初の改行まで（改行を含む語は bash が
 * `$'…'` で出す）。記録係の command_not_found_handle の中の件は捨てる。
 */

export interface Traced {
  /** その件を出した関数の名（関数の外なら空） */
  func: string;
  /** 代入だけの件（`X=1`）は argv が空で assigns に入る */
  assigns: string[];
  argv: string[];
}

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/**
 * 一行の xtrace を語に分ける。読めぬ形なら undefined。
 * 箱の中の bash は C の locale で走るゆえ、ASCII の外の字は `$'\303\250'` の byte で出る。語は byte で組み、
 * 最後に UTF-8 として読み直す。
 */
export function splitWords(line: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i >= line.length) break;
    const bytes: number[] = [];
    const add = (s: string) => {
      for (const b of Buffer.from(s, 'utf8')) bytes.push(b);
    };
    while (i < line.length && line[i] !== ' ') {
      const c = line[i]!;
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) return undefined;
        add(line.slice(i + 1, end));
        i = end + 1;
      } else if (c === '$' && line[i + 1] === "'") {
        i += 2;
        while (i < line.length && line[i] !== "'") {
          if (line[i] === '\\') {
            const n = line[i + 1]!;
            if (n in ANSI) {
              add(ANSI[n]!);
              i += 2;
            } else if (/[0-7]/.test(n)) {
              const m = /^[0-7]{1,3}/.exec(line.slice(i + 1))![0];
              bytes.push(Number.parseInt(m, 8) & 0xff);
              i += 1 + m.length;
            } else if (n === 'x') {
              const m = /^[0-9a-fA-F]{1,2}/.exec(line.slice(i + 2))?.[0] ?? '';
              bytes.push(Number.parseInt(m || '0', 16));
              i += 2 + m.length;
            } else {
              add(n);
              i += 2;
            }
          } else {
            add(line[i]!);
            i++;
          }
        }
        if (line[i] !== "'") return undefined;
        i++;
      } else if (c === '\\') {
        add(line[i + 1] ?? '');
        i += 2;
      } else {
        add(c);
        i++;
      }
    }
    out.push(Buffer.from(bytes).toString('utf8'));
  }
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** 記録の全体を件に分ける。記録係の関数の中の件は捨てる。 */
export function parseTrace(stream: string): { traced: Traced[]; unreadable: string[]; output: string } {
  const traced: Traced[] = [];
  const unreadable: string[] = [];
  // 件の行の後に続く字は、命が fd 9 へ出した生の出力（陽性対照の痕はここで見る）
  let output = stream.split('\x01')[0] ?? '';
  for (const chunk of stream.split(/\x01+/)) {
    if (chunk === '') continue;
    const sep = chunk.indexOf('\x02');
    if (sep < 0) continue;
    const func = chunk.slice(0, sep);
    const rest = chunk.slice(sep + 1);
    const nl = rest.indexOf('\n');
    const body = nl < 0 ? rest : rest.slice(0, nl);
    if (nl >= 0) output += rest.slice(nl + 1);
    if (func === 'command_not_found_handle') continue;
    const words = splitWords(body);
    if (words === undefined) {
      unreadable.push(body);
      continue;
    }
    const assigns: string[] = [];
    while (words.length > 0 && ASSIGN.test(words[0]!)) assigns.push(words.shift()!);
    traced.push({ func, assigns, argv: words });
  }
  return { traced, unreadable, output };
}
