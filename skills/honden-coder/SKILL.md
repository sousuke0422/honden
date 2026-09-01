---
name: honden-coder
user-invocable: true
description: |
  Coder のワークスペース上で命を走らせる。
  「Coder で実行」「ワークスペース上でビルド／テスト」「API サーバーを起動」
  と言われた時、または任（task）の本文に `coder_workspace` が書いてある時に使う。
  Do NOT use for: 手元で走らせる命（通常の Bash tool を使え）。
  汎用の SSH 先や PVE の VM（shogun-remote-ssh を使え）。
argument-hint: "[exec|server start|server log|server stop|mount|status] ..."
allowed-tools: Bash, Read
---

# /honden-coder — Coder ワークスペース操作

旧 `shogun-coder` を honden の棚へ移した（2026-09-02）。手順は変えていない。
変えたのは script の置き場だけで、この skill の隣（`scripts/coder_mount.sh`）に住む。
以下の `$SKILL` はこの SKILL.md が在る dir を指す。

## 芯

足軽が手元と Coder の違いを意識せずに働けるようにする。
file の読み書きは SSHFS で手元の道として扱い、**命の実行だけ**を Coder へ飛ばす。
長く生きる process（API サーバー、dev サーバー）は Coder 側の tmux で持つ。

## 任の欄

この skill を使う任には次の欄が付く。先に Read で確かめること。

| 欄 | 要る | 何か |
|---|---|---|
| `coder_workspace` | 要る | ワークスペース名（`coder ls` に出る名） |
| `coder_workdir` | 要る | ワークスペース内の作業 dir（絶対の道） |
| `server_required` | — | `true` なら B の手順を見る |
| `mount_path` | — | 手元での mount 先。省けば `~/coder/<workspace>` |

## 初回だけ

```bash
coder config-ssh                      # ~/.ssh/config に <workspace>.coder が足される
coder ssh <workspace> -- echo ok      # 疎通
```

## A. 命を一つ走らせる（exec）

ビルド、試験、git、lint など、終わる命はこれ。
SSHFS の ControlMaster socket を使い回すので、起動 log が混じらず stderr が素直に読める。

```bash
bash $SKILL/scripts/coder_mount.sh exec <workspace> 'cd <workdir> && <cmd>'

# 例
bash $SKILL/scripts/coder_mount.sh exec myproject 'cd /home/coder/repo && cargo test'
bash $SKILL/scripts/coder_mount.sh exec myproject 'cd /home/coder/repo && git status'
```

**shell の状態（cwd、環境変数）は毎回消える。** 必ず `cd <workdir> &&` を頭に付け、命を自己完結にする。
mount していなければ拒まれる（先に `mount`）。

## B. 長く生きる process（server）

Coder 側の tmux session `coder-servers` に窓を一つずつ作って持つ。

### B-1 起こす

```bash
coder ssh <workspace> -- bash -c '
  tmux has-session -t coder-servers 2>/dev/null \
    || tmux new-session -d -s coder-servers
  tmux new-window -t coder-servers -n <name> "cd <workdir> && <cmd>"
'
```

### B-2 log を見る

```bash
coder ssh <workspace> -- tmux capture-pane -t coder-servers:<name> -p
```

### B-3 応えるまで待つ（最大 30 秒）

```bash
coder ssh <workspace> -- bash -c '
  for i in $(seq 1 10); do
    curl -sf http://localhost:<port>/health && break
    sleep 3
  done
'
```

### B-4 止める

```bash
coder ssh <workspace> -- tmux kill-window -t coder-servers:<name>
```

これは **Coder 側の tmux** の窓を閉じる命である。手元の陣（honden / honden-agents）には触れない。
手元の陣を畳むのは `shutsujin_departure.sh down` の役目で、この skill から打たない。

## SSHFS（file の読み書き）

mount と unmount は足軽ではなく、家老か人が行う。

```bash
bash $SKILL/scripts/coder_mount.sh mount <workspace>       # 既定の先: ~/coder/<workspace>
bash $SKILL/scripts/coder_mount.sh status
bash $SKILL/scripts/coder_mount.sh unmount <workspace>
```

足軽は mount 済みの道を手元の道として使う。任に `mount_path` が書いてあればそれに従う。

**ControlMaster を経る理由**：Coder の SSH proxy は接続のたびに起動 log を stdout へ吐き、SFTP の約束を壊す。
一度張った接続を使い回すことでこれを避けている。

## 困った時

| 症状 | 原因 | 手当て |
|---|---|---|
| `no ControlMaster socket for <ws>` | mount していない | `coder_mount.sh mount <ws>` |
| `ssh: Could not resolve hostname <ws>.coder` | `coder config-ssh` を打っていない | 打つ |
| `tmux: can't find window: coder-servers:<name>` | 窓が無い | B-1 |
| `command not found` | ワークスペース側に道具が無い | ワークスペース側で入れる |
| mount が切れた | 網の断 | `coder_mount.sh mount <ws>` で張り直す |
| サーバーが起きない | — | B-2 で log を読み、報告に写す |
