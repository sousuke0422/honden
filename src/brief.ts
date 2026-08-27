/**
 * 指示書を組み立てて出す。**生成物は作らぬ。**
 *
 * 旧環境は部品を組んで `instructions/generated/{cli}-{role}.md` を 24 枚
 * 吐いていた。そこに二系統の割れが生まれ（手書き `{role}.md` の本文が
 * どこへも行かぬ）、割れを検める仕掛けが要り、CI に組み込む要が生じ、
 * 「build を忘れた」と「本文が届いておらぬ」の二軸を別々に見張る羽目になった。
 *
 * **出す時に組めば、割れようが無い。** 部品は一系統、読む者は
 * `honden brief` を叩く。生成物が無いゆえ:
 *   - build を忘れる余地が無い（冪等の検めも要らぬ）
 *   - 生成物と部品がずれる余地が無い（drift の検めも要らぬ）
 *   - 部品を直せばその場で全 CLI へ届く
 *
 * 代わりに要るのは「部品が欠けておらぬか」だけである——これは
 * 組み立てが空を返さぬかで分かる。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BriefPart {
  path: string;
  found: boolean;
  lines: number;
}

export interface Brief {
  role: string;
  cli: string | null;
  text: string;
  parts: BriefPart[];
  /** 欠けておる部品。**役の部品が欠けたら組み立ては成らぬ。** */
  missing: string[];
}

/** 役ごとの部品。共通は全役へ、CLI 別はその CLI にだけ。 */
export function partsFor(role: string, cli: string | null): string[] {
  const out = [`roles/${role}.md`, 'common/protocol.md', 'common/task_flow.md', 'common/forbidden_actions.md'];
  if (cli) out.push(`cli/${cli}.md`);
  return out;
}

export function assemble(root: string, role: string, cli: string | null): Brief {
  const dir = join(root, 'instructions');
  const parts: BriefPart[] = [];
  const chunks: string[] = [];
  const missing: string[] = [];

  for (const rel of partsFor(role, cli)) {
    const p = join(dir, rel);
    if (!existsSync(p)) {
      parts.push({ path: rel, found: false, lines: 0 });
      // CLI 別の部品が無いのは咎めぬ（T3 は移しておらぬ）。
      // 役と共通が欠けるのは組み立ての失敗である。
      if (!rel.startsWith('cli/')) missing.push(rel);
      continue;
    }
    const text = readFileSync(p, 'utf8');
    parts.push({ path: rel, found: true, lines: text.split('\n').length });
    chunks.push(text.replace(/\s+$/, ''));
  }

  return { role, cli, text: chunks.join('\n\n'), parts, missing };
}
