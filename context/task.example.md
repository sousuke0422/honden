# task（koyori-app/task）— 実例
最終更新: 2026-09-02

> これは実在の案件で使っている覚書の公開版である（workspace の実名だけ伏せた）。
> 雛形（README.md）が抽象で分かりにくければ、こちらを形の見本にせよ。
> 使う時は `task.md` のように **`.example` 無しの名**で置く——そちらは git に載らない。

## 何か

チームのタスク管理アプリ。frontend（Vue）と backend（Rust）の monorepo。
GitHub 上の旧名 TeamBlackCrystal/task は koyori-app/task へ転送される。

## 場所 — **Coder が実体。WSL で push するな**

- 実体: Coder workspace `<workspace>` の `/home/coder/task`
- git はすべて Coder の中で打つ（`/honden-coder` の exec 経由）。
  worktree も `/home/coder/` 配下に作る
- WSL の `/mnt/c/Users/example/work/task` は **grep・参照専用**。deploy key が無く
  push は 403。ここで commit するな（足軽が二度踏んだ: cmd_266, cmd_273）
- SSHFS mount（`~/coder/<workspace>/task`）は**編集・閲覧のみ、git 厳禁**

## 使う技術

- frontend: **Vike**（vike-vue。Nuxt ではない）+ shadcn-vue（new-york / Tailwind v4 / phosphor）
- ページは `src/pages/{route}/+Page.vue`。layout の上書きは `+config.ts` に `Layout: false`
- API は `src/lib/api.ts` の `createApi()`（OpenAPI 生成済み）を使う
- 検証は **arktype / arkenv**（既に依存にある。新規に add するな。既存の schema に倣う）
- 本文の Markdown 方言は **KFM**（GFM ∪ MFM ＋ Koyori 拡張。remark 束ね）
- backend: Rust の Cargo workspace。型は `payload` crate が正

## 決めたこと

- commit は **Conventional Commits**（`type(scope): 要約`）＋ 末尾に
  `Assisted-by: multi-agent-shogun-aki-tweak` trailer。両方必須
- branch は local `wt/<name>`、push 先は `feat|fix/<name>`
- UI 部品が要るなら **shadcn-vue CLI**（`npx shadcn-vue@latest add <c>`・既定 registry のみ）。
  `reka-ui` を直接 import して手組みするな。既に `@/components/ui/<x>` が在ればそれを使う
- PR のレビュー依頼は reviewRequests（Reviewers 欄）。assignee にレビュアーを入れない。
  依頼の操作は将軍が行う（配下の gh は読み取り専用）

## 罠

- `vp check` は Coder 環境でハングする → **`pnpm run verify`** を使う（vue-tsc + vp lint + vp fmt）
- 実レビューは Discord で回る。GitHub の reviews を「レビュー状況の真実源」にしない
- MFM 由来の部分（アニメ CSS 等）は Misskey（AGPL-3.0）由来。SPDX ヘッダを消すな
