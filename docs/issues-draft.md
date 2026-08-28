# Issue 草稿 — 殿が起票する分（WSL の gh は RO ゆえ将軍は起こせぬ）

総点検（docs/decisions.md 四十五前後）で「今はやらぬ」と分けた分。
一件一 Issue の草稿である。起票の際は本文をそのまま写してよい。

---

## 一、本番切り替えの裁定と手順書

**Title**: 本番切り替え — 併走か一気か、手順と戻り道を定める

**本文**:

honden は一巡・規模・門・再装填まで実測済み（docs/decisions.md 四十〜四十五）。
残る問いは技術でなく移り方である。

判断事項:
- 併走か一気か。将軍の見立ては一気（書き戻しは「書き手が二人」の禍根。
  戻り道は `honden export` の綱と凍った旧環境で軽い）
- 移行日の手順: 旧陣を畳む → `scripts/shutsujin.sh up` → `guard selftest` →
  codex の hook 信頼（対話で一度）→ 無害な一巡で検分
- 戻り道の手順: `honden export --out` → 旧 queue/ を退避 → 写す → 旧 shutsujin

前提の確認:
- [ ] 本番の名簿（config/settings.yaml）が実態と合っておるか
- [ ] 全 CLI の hook 信頼が済んでおるか（`honden guard selftest` で緑）
- [ ] 正本の写しが焼けておるか（`honden backup`）

---

## 二、saytask / ntfy を移すか、捨てるか

**Title**: saytask（VF タスク・streak）と ntfy の扱いを決める

**本文**:

honden に器が無い（意図的に未着手・docs/decisions.md 二十）。
旧環境では: saytask = 殿ご自身の用を将軍が直に控える器（F001 の唯一の例外）、
ntfy = スマホとの往復。

選択肢:
1. honden へ器を建てる（`saytask` 表 + 副命令。ntfy は scripts/ の薄い皮）
2. 旧環境の器をそのまま使い続ける（saytask だけ旧で回す・凍結に注意）
3. 捨てる（別の仕組みへ移った等、実態が変わっておるなら）

判断材料: 直近で saytask / ntfy を実際に使うておられるか。

---

## 三、家老（cursor）が L1/L2 の合図で動かなんだ理由

**Title**: cursor が素の nudge に 8 分無反応だった件の究明

**本文**:

一巡試験（docs/decisions.md 三十五）で、家老の cursor が L1×2・L2×2 に
反応せず、L3 の文脈消しでようやく動いた。以後の合図には正常に反応している。

仮説:
- 立ち上げ直後の cursor は入力を取りこぼす（初期化中の send-keys が消える）
- 極小 pane（当時 5 枚並べで表示が縦割れ）が入力に影響した
- Enter が別扱いで確定しなかった

再現の手がかり: cursor を respawn した直後 30 秒以内に nudge を撃ち、
拾うかを測る。拾わねば「立ち上げ直後」説が濃い——その場合、
配置換え（switch_cli.sh）の直後は合図を一拍待つ手当てが要る。

---

## 四、大きく育った会話での圧縮生存

**Title**: cursor / claude の注入が、大きな会話の圧縮でも残るかを運用で見る

**本文**:

小さい会話での /compact 生存は両 CLI とも実測済み（docs/decisions.md
四十三・四十五近辺）。大きく育った会話では要約器が何を落とすか未知。
本番運用の初週、圧縮を跨いだエージェントに名乗りと作法を訊いて記録する。

---

## 六、Stop hook の「error occurred」表示

**Title**: Stop hook の BLOCK 後に「Stop hook error occurred」が出る件

**本文**:

実機の BLOCK 後に「Stop hook error occurred」の表示が出た（2026-08-29）。
動作は正しい（block → 拾い直し → ack → 通過）が、表示の因は未詳。
単体では valid JSON + exit 0。疑いは hook 内で honden を二度叩く分の遅さが
timeout（15 秒）に触れた線。timeout を延ばすか honden 呼びを一度に畳むかで
消えるはずだが、実測で切り分けてから直す。

---

## 五、構文解析の門（Rust）

**Title**: 継ぎの数えが三枚に達したら、解けぬ形を止める門を建てる

**本文**:

docs/decisions.md 十八に建てる合図と設計方針を記録済み。現在二枚
（env 前置・経路の概念が型に無い）。三枚目が出た時が建て時。
場所は芯の外の別 crate。既存 POSIX shell parser を借りる。

