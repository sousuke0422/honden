/**
 * 規約の棚を読み返す。
 *
 * ## なぜ読み返す側から繋ぐか
 *
 * honden は既に理由を集めている——迂回にも、強制解除にも、覗きにも
 * `--reason` を課し、全部台帳へ落としている。だが**一度も読み返していない**。
 * 集めるだけで判定に使わぬのは、集めたことを対処したと取り違えること。
 * この一連で何度も戒めてきた型そのものが、honden 自身に残っていた。
 *
 * kagemusha の棚 (`ssot/norms/`) は、その読み返す先の器である。
 *
 * ## 検出器ではなく生成側へ戻す
 *
 * 棚の README の言——「検出器に戻すと見つけるのが速くなるだけ。生成側に戻すと
 * 最初から起きなくなる。前者は線形、後者が複利」。
 *
 * honden での生成側は、足軽へ渡す仕事そのもの。ゆえに `task assign` の時点で
 * 差し込む。報告を検める側（軍師）へ差し込んでも、線形にしかならない。
 *
 * ## 棚の決めをこちらで曲げない
 *
 *   - 4 段すべてが棚に載る。段が決めるのは「指示文に入れるか」だけ
 *   - 指示文へ入るのは **規約** と **常設** のみ。n=1 を法則にしないための敷居
 *   - **出典の無い行は入れない**。後から誰も検算できないゆえ
 *   - `README.md` は棚ではない。器の説明であって規約ではない
 *   - `.example` は `.md` で終わっていない。**それは意図**で、
 *     `*.md` で拾う仕組みが見本を「あなたの規約」として読み込まぬため。
 *     ここでも `*.md` だけを見て、拡張子を緩めない
 *   - 棚は空で出荷される。**空を異常として扱わない**
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 熟成度の札。棚の README の並びをそのまま持つ。 */
export const TIERS = ['観測 n=1', '候補', '規約', '常設'] as const;
export type Tier = (typeof TIERS)[number];

/** 初稿の指示文へ入る段。ここが n=1 を法則にしないための敷居。 */
export const PROMPT_TIERS: readonly Tier[] = ['規約', '常設'];

export interface Norm {
  /** どのドメインの棚か。ファイル名から取る。 */
  domain: string;
  tier: Tier;
  /** 何を、どうする、の一文。 */
  text: string;
  /** 対応する検査軸。棚では空でもよい。 */
  axis?: string;
  /** どの成果物のどの直しか。無い行は指示文へ入れない。 */
  source?: string;
  /** 元の行。後から突き合わせるために残す。 */
  raw: string;
}

/**
 * 棚に載る 1 行を解く。
 *
 *   - **[規約]** 何を、どうする、を一文で — 検査軸 — 出典: <成果物名> <YYYY-MM-DD>
 *
 * 区切りは全角のダッシュ。半角ハイフンと混ざると割れ方が変わるので、
 * 見本の書式に合わせて全角だけを見る。
 */
export function parseEntry(line: string, domain: string): Norm | null {
  const m = /^\s*-\s*\*\*\[([^\]]+)\]\*\*\s*(.+)$/.exec(line);
  if (!m) return null;
  const tier = m[1]!.trim() as Tier;
  if (!(TIERS as readonly string[]).includes(tier)) return null;

  const rest = m[2]!.trim();
  const parts = rest.split('—').map((s) => s.trim());
  const text = parts[0] ?? '';
  if (text === '') return null;

  let axis: string | undefined;
  let source: string | undefined;
  for (const p of parts.slice(1)) {
    if (p.startsWith('出典:') || p.startsWith('出典：')) {
      source = p.replace(/^出典[:：]\s*/, '').trim() || undefined;
    } else if (p !== '' && axis === undefined) {
      axis = p;
    }
  }
  return { domain, tier, text, axis, source, raw: line.trim() };
}

/**
 * 棚を読む。
 *
 * `root` は kagemusha の根（submodule なら `<repo>/kagemusha`）。
 * 棚が無ければ空を返す。**投げない**——棚は空で出荷されるものであり、
 * 無いことは異常ではない。
 */
export function readNorms(root: string): Norm[] {
  const dir = join(root, 'ssot', 'norms');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const out: Norm[] = [];
  for (const name of names.sort()) {
    // README は器の説明であって棚ではない。
    if (name === 'README.md') continue;
    // 拡張子を緩めない。`.example` が `.md` で終わっておらぬのは意図で、
    // 見本を「あなたの規約」として読み込まぬための造り。
    if (!name.endsWith('.md')) continue;

    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const domain = name.replace(/\.md$/, '');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const e = parseEntry(line, domain);
      if (e) out.push(e);
    }
  }
  return out;
}

export interface Selection {
  /** 初稿の指示文へ入るもの。 */
  chosen: Norm[];
  /** 段が足りず入らなかったもの。 */
  tooYoung: Norm[];
  /** 出典が無くて入れられなかったもの。 */
  unsourced: Norm[];
}

/**
 * 指示文へ入れるものを選ぶ。
 *
 * 段が足りているだけでは入れない。**出典が無い行は入れない**——
 * 後から誰も検算できず、誰かの思いつきが規約の顔をして回り始める。
 */
export function select(all: Norm[], domain?: string): Selection {
  const scoped = domain ? all.filter((n) => n.domain === domain) : all;
  const chosen: Norm[] = [];
  const tooYoung: Norm[] = [];
  const unsourced: Norm[] = [];
  for (const n of scoped) {
    if (!(PROMPT_TIERS as readonly string[]).includes(n.tier)) {
      tooYoung.push(n);
      continue;
    }
    if (!n.source) {
      unsourced.push(n);
      continue;
    }
    chosen.push(n);
  }
  return { chosen, tooYoung, unsourced };
}

/**
 * 仕事へ添える文にする。
 *
 * 空なら空文字を返す。**空の見出しだけを添えない**——
 * 中身の無い節が毎回付くと、読む側がその節ごと読み飛ばすようになる。
 */
export function forTask(sel: Selection): string {
  if (sel.chosen.length === 0) return '';
  const lines = ['【生成側へ還流する規約】この仕事の初稿から効かせよ。'];
  for (const n of sel.chosen) {
    lines.push(`  - [${n.domain}] ${n.text}${n.axis ? `（軸: ${n.axis}）` : ''}`);
  }
  lines.push('  規約は出典のある直しから積み上がったものである。破るなら報告に理由を書け。');
  return lines.join('\n');
}
