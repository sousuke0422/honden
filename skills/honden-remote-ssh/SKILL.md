---
name: honden-remote-ssh
user-invocable: true
description: |
  任意の SSH 先（Linux サーバー、PVE の VM など）で命を走らせ、長く生きる process を
  tmux で持ち、SSHFS で file を手元の道として扱う。
  「リモートで実行」「PVE で」「SSH 先で」「リモートで開発」と言われた時、
  または任（task）の本文に `ssh_host` が書いてある時に使う。
  Do NOT use for: 手元で走らせる命（通常の Bash tool を使え）。
  Coder のワークスペース（honden-coder を使え）。
argument-hint: "[host] [exec|mount|server start|server log|server stop] ..."
allowed-tools: Bash, Read
---

# /honden-remote-ssh — 汎用 SSH の遠方作業

旧 `shogun-remote-ssh` を honden の棚へ移した（2026-09-02）。手順は変えていない。
変えたのは三つ——例から私事を抜いた、道具の導入を禁じ手の作法に揃えた、
ControlMaster の socket を `/tmp` から `~/.ssh/` へ移した（下に理由）。

## 芯

SSH 先で命を走らせ、長く生きる process を持ち、file を手元の道として扱う。
手元と遠方の差を意識せずに働けるようにする。

## 任の欄

| 欄 | 要る | 何か |
|---|---|---|
| `ssh_host` | 要る | `~/.ssh/config` の名、または `user@host` |
| `ssh_workdir` | 要る | 遠方の作業 dir（絶対の道） |
| `ssh_mount_path` | — | 手元の SSHFS 先。省けば `~/remote/<host>` |
| `server_required` | — | `true` なら B の手順を見る |

## 初回だけ

```bash
# ~/.ssh/config に名を置く（例）
# Host myhost
#   HostName <address>
#   User <user>
#   IdentityFile ~/.ssh/id_ed25519

ssh myhost echo ok                              # 疎通
ssh -fNM -S ~/.ssh/ctl-myhost myhost            # ControlMaster を張る（以後使い回す）
```

**socket は `~/.ssh/ctl-<host>`。** 旧は `/tmp/ssh-ctl-<host>` だったが、`/tmp` は
誰でも覗ける dir で、名も読める。同じ機に他の利用者が居れば socket へ繋がれうる。
`~/.ssh` は持ち主だけが読める。

## A. 命を一つ走らせる（exec）

```bash
ssh -S ~/.ssh/ctl-<host> <host> 'cd <workdir> && <cmd>'

# 例
ssh -S ~/.ssh/ctl-myhost myhost 'pgrep -a myserver'
ssh -S ~/.ssh/ctl-myhost myhost 'cd ~/repo && source .venv/bin/activate && python scripts/report.py'
```

**shell の状態（cwd、環境変数）は毎回消える。** 必ず `cd <workdir> &&` を頭に付ける。

**遠方に道具を入れるのは STOP して報告する。** `sudo apt-get install …` を足軽が
黙って打ってはならぬ（`CLAUDE.md` の D005 と D011-AT）。何を、なぜ、どの版を、
どこから——を報告に書き、裁可を待つ。

## B. 長く生きる process（server）

遠方の tmux session `remote-servers` に窓を一つずつ作って持つ。

### B-1 起こす

```bash
ssh -S ~/.ssh/ctl-<host> <host> bash -c '
  tmux has-session -t remote-servers 2>/dev/null \
    || tmux new-session -d -s remote-servers
  tmux new-window -t remote-servers -n <name> "cd <workdir> && <cmd>"
'
```

### B-2 log を見る

```bash
ssh -S ~/.ssh/ctl-<host> <host> -- tmux capture-pane -t remote-servers:<name> -p
```

### B-3 応えるまで待つ（最大 30 秒）

```bash
ssh -S ~/.ssh/ctl-<host> <host> bash -c '
  for i in $(seq 1 10); do
    curl -sf http://localhost:<port>/health && break
    sleep 3
  done
'
```

### B-4 止める

```bash
ssh -S ~/.ssh/ctl-<host> <host> -- tmux kill-window -t remote-servers:<name>
```

これは**遠方の tmux** の窓を閉じる命である。手元の陣（honden / honden-agents）には触れない。
手元の陣を畳むのは `shutsujin_departure.sh down` の役目で、この skill から打たない。

## C. SSHFS（file の読み書き）

```bash
MOUNT=~/remote/<host>
mkdir -p "$MOUNT"
sshfs -o ControlPath=~/.ssh/ctl-<host> <host>:<workdir> "$MOUNT"

findmnt "$MOUNT"                 # 確かめ
fusermount -u "$MOUNT"           # 外す
```

ControlMaster が張ってあれば SSHFS も同じ接続を使う。無ければ毎回認証が走る。先に張る。

## ControlMaster

```bash
ssh -fNM -S ~/.ssh/ctl-<host> <host>        # 張る
ssh -S ~/.ssh/ctl-<host> -O check <host>    # 生きておるか
ssh -S ~/.ssh/ctl-<host> -O exit <host>     # 畳む
```

## 困った時

| 症状 | 原因 | 手当て |
|---|---|---|
| `ControlSocket … no such file` | 張っていない | `ssh -fNM -S ~/.ssh/ctl-<host> <host>` |
| `Connection refused` | 先が止まっている、sshd が居ない | 先の状態を確かめる（VM なら console） |
| `sshfs: command not found` | 手元に sshfs が無い | 導入は STOP して報告（D011-AT） |
| `Transport endpoint is not connected` | mount が切れた | `fusermount -u` してから張り直す |
| GUI の AppImage が `xcb` で落ちる | 先に X の lib が無い | 要る lib を列挙して報告。入れるのは裁可の後 |
