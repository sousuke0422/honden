/**
 * 本体を新しくする。**降ってきた物を、確かめてから置く。**
 *
 * # なぜ要るか
 *
 * 建てるには Bun と Rust が要る。使うだけの者にそれを課すのは重い——
 * 仕度で二つの道具を入れさせるより、出来上がった物を配るほうが早い。
 * 出す側（GitHub Actions）が建て、ここが取りに行く。
 *
 * # 降ってきた物を信じぬ
 *
 * 取ってきた binary は**外から来た実行可能な物**である。honden 自身の
 * 禁じ手（D008・D011-AT）が戒めておるのは、まさにこの形——「遠くから
 * 取った物を走らせる」。ゆえに three つ課す。
 *
 *   一、**出所を固定する。** `REPO` 以外からは取らぬ。人が道を渡せる
 *       口を作らぬ——作れば、いつか誰かがそこへ別の道を書く。
 *   二、**署名を検める。** `SHA256SUMS` は cosign keyless で署名してある
 *       （`sign.ts`）。縛るのは「誰が署名したか」——札から走った我らの
 *       release.yml だけを認める。
 *   三、**数を照らす。** 署名の通った `SHA256SUMS` と照らし、違えば置かぬ。
 *   四、**置く前に全部揃える。** 一つでも欠けたり違ったりすれば**一つも
 *       置かぬ**。半分だけ新しい `bin/` は、どちらの版とも違う物になる。
 *
 * 鎖はこの順で繋がる: 署名 → SHA256SUMS → 各 binary。
 * 紙を縛れば、紙が縛る全部が縛られる。
 *
 * # 置き換えであって、上書きではない
 *
 * 陣が立っておる間、芯は己の binary を掴んでおる。`cp` は `Text file busy`
 * で倒れる（建て方で実測 2026-08-30）。`mv` は名札を差し替えるだけゆえ、
 * 走っておる側は古い実体を持ったまま生き、次に立つ時から新しくなる。
 */
import { REPO, VERSION, isNewer } from './version';

/** 配る binary の名。`bin/` に置かれる名でもある。 */
export const BINARIES = ['honden', 'honden-bot', 'honden-watch', 'honden-parse'] as const;
export type BinaryName = (typeof BINARIES)[number];

/** 数を並べた紙の名。 */
export const SUMS = 'SHA256SUMS';

/**
 * 配っておる土地。
 *
 * **macOS は無い。** 芯（honden-watch）は inotify 一本で建ててあり、
 * Linux にしか実装を持たぬ。kqueue は別の普請である——「配っておらぬ」と
 * 正直に言うほうが、404 を掴ませるより親切である。
 */
export interface Platform {
  os: 'linux';
  arch: 'x64' | 'arm64';
}

/**
 * いま走っておる土地。**知らぬ土地なら `null`。**
 *
 * 当て推量で近い物を渡さぬ。違う土地の binary は動かぬか、悪くすれば
 * 中途半端に動く。「配っておらぬ」と言うほうが親切である。
 */
export function platformOf(p: { platform: string; arch: string }): Platform | null {
  if (p.platform !== 'linux') return null;
  const arch = p.arch === 'x64' ? 'x64' : p.arch === 'arm64' ? 'arm64' : null;
  if (!arch) return null;
  return { os: 'linux', arch };
}

/** 配り物の名。`honden-linux-x64` の形。 */
export function assetName(bin: BinaryName, p: Platform): string {
  return `${bin}-${p.os}-${p.arch}`;
}

/**
 * `SHA256SUMS` を解く。`<64 桁>␣␣<名>` の並び。
 *
 * 解けぬ行は**黙って捨てぬ**——捨てれば、後の照らしで「そんな名は無い」と
 * なり、なぜ無いのか辿れなくなる。数の形をしておらぬ行は形が違うと言う。
 */
export function parseSums(text: string): { ok: true; sums: Map<string, string> } | { ok: false; message: string } {
  const sums = new Map<string, string>();
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    n++;
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line);
    if (!m) return { ok: false, message: `${SUMS} の ${n} 行目が数の形をしておらぬ: ${line.slice(0, 60)}` };
    sums.set(m[2]!, m[1]!.toLowerCase());
  }
  if (sums.size === 0) return { ok: false, message: `${SUMS} が空である` };
  return { ok: true, sums };
}

/** 取りに行く先。**この二つ以外は組み立てぬ。** */
export function releaseApiUrl(): string {
  return `https://api.github.com/repos/${REPO}/releases/latest`;
}
export function assetUrl(tag: string, name: string): string {
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export interface Plan {
  /** 降りてくる版 */
  tag: string;
  /** いまの版 */
  current: string;
  /** 取る物。名と行き先 */
  items: { name: string; asset: string; url: string }[];
  sumsUrl: string;
}

/** 何を取るかを組む。純関数ゆえ試験できる。 */
export function planFor(tag: string, p: Platform): Plan {
  return {
    tag,
    current: VERSION,
    items: BINARIES.map((b) => {
      const asset = assetName(b, p);
      return { name: b, asset, url: assetUrl(tag, asset) };
    }),
    sumsUrl: assetUrl(tag, SUMS),
  };
}

export type Decision =
  | { kind: 'current' }
  | { kind: 'ahead'; latest: string }
  | { kind: 'update'; tag: string }
  | { kind: 'unknown'; message: string };

/**
 * 降りるべきか。
 *
 * **「己のほうが新しい」を別に扱う。** 手元で建てて先へ進んでおる時に
 * 黙って古い物を被せれば、直したばかりの物が消える。
 */
export function decide(latestTag: string | null): Decision {
  if (!latestTag) return { kind: 'unknown', message: '出し物が見当たらぬ（まだ一つも出しておらぬか、届かなんだ）' };
  if (isNewer(latestTag, VERSION)) return { kind: 'update', tag: latestTag };
  if (isNewer(VERSION, latestTag)) return { kind: 'ahead', latest: latestTag };
  return { kind: 'current' };
}

/** 出し物の応えから札を拾う。形が違えば `null`。 */
export function tagFrom(json: unknown): string | null {
  const t = (json as { tag_name?: unknown })?.tag_name;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

/** 降ろした物の検め。**一つでも違えば全部やめる。** */
export function verify(
  got: { asset: string; sha256: string }[],
  sums: Map<string, string>,
): { ok: true } | { ok: false; message: string } {
  const bad: string[] = [];
  for (const g of got) {
    const want = sums.get(g.asset);
    if (!want) {
      bad.push(`${g.asset}: ${SUMS} に載っておらぬ`);
      continue;
    }
    if (want !== g.sha256.toLowerCase()) bad.push(`${g.asset}: 数が違う（${want.slice(0, 12)}… ≠ ${g.sha256.slice(0, 12)}…）`);
  }
  if (bad.length === 0) return { ok: true };
  return {
    ok: false,
    message: `降ろした物が検めを通らなんだ。**一つも置かぬ**:\n${bad.map((b) => `    ${b}`).join('\n')}`,
  };
}
