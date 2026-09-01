#!/bin/bash
# Coder ワークスペースを SSHFS でローカルマウント/アンマウントする
#
# 前提: coder config-ssh 実行済み、sshfs インストール済み
#
# Usage:
#   bash scripts/coder_mount.sh mount   <workspace> [mount_path] [remote_path]
#   bash scripts/coder_mount.sh unmount <workspace> [mount_path]
#   bash scripts/coder_mount.sh exec    <workspace> <cmd>
#   bash scripts/coder_mount.sh status
#
# remote_path: マウントするリモートの絶対パス（省略時はホームディレクトリ）
#   例: bash scripts/coder_mount.sh mount yellow-louse-10 ~/coder/task /home/coder/task

set -euo pipefail

ACTION=${1:-status}
WORKSPACE=${2:-}
MOUNT_PATH=${3:-${HOME}/coder/${WORKSPACE}}
REMOTE_PATH=${4:-}

case "$ACTION" in
  mount)
    if [ -z "$WORKSPACE" ]; then
      echo "Error: workspace name required" >&2
      echo "Usage: $0 mount <workspace> [mount_path]" >&2
      exit 1
    fi
    if ! command -v sshfs &>/dev/null; then
      echo "Error: sshfs not installed. Run: sudo apt install sshfs" >&2
      exit 1
    fi
    if [ -z "$REMOTE_PATH" ]; then
      REMOTE_PATH=$(coder ssh "$WORKSPACE" -- 'echo $HOME' 2>/dev/null | tail -1 | tr -d '\r') || {
        echo "Error: coder ssh $WORKSPACE failed. Is the workspace running?" >&2
        exit 1
      }
    fi
    CTRL_SOCK="${HOME}/.ssh/coder-${WORKSPACE}.sock"
    # すでにマウント済みならスキップ
    if findmnt "$MOUNT_PATH" &>/dev/null; then
      echo "Already mounted: ${MOUNT_PATH}"
      exit 0
    fi
    # ControlMaster 起動（既存ソケットが生きていれば再利用、腐っていれば作り直す）
    if [ -S "$CTRL_SOCK" ] && ! ssh -S "$CTRL_SOCK" -O check "${WORKSPACE}.coder" &>/dev/null; then
      echo "[coder-mount] ControlMaster socket stale, recreating..." >&2
      rm -f "$CTRL_SOCK"
    fi
    if [ ! -S "$CTRL_SOCK" ]; then
      ssh -M -S "$CTRL_SOCK" -fNT "${WORKSPACE}.coder"
      # ソケット確立を待つ
      for i in $(seq 1 10); do
        [ -S "$CTRL_SOCK" ] && break
        sleep 0.3
      done
      if [ ! -S "$CTRL_SOCK" ]; then
        echo "[coder-mount] Error: ControlMaster socket not created after 3s" >&2
        exit 1
      fi
    fi
    # ControlMaster が channel を受け付けるまで待つ（socket 出現直後は auth 未完了のことがある）
    READY=0
    for i in $(seq 1 10); do
      if ssh -S "$CTRL_SOCK" "${WORKSPACE}.coder" true &>/dev/null; then
        READY=1; break
      fi
      sleep 0.3
    done
    if [ "$READY" -eq 0 ]; then
      echo "[coder-mount] Error: ControlMaster did not become ready after 3s" >&2
      exit 1
    fi
    mkdir -p "$MOUNT_PATH"
    # ssh_command で ControlMaster ソケット経由の接続を明示（ProxyCommand を経由しない）
    SSHFS_ERR=$(sshfs \
      -o "ssh_command=ssh -S ${CTRL_SOCK} -o ControlMaster=no" \
      "${WORKSPACE}.coder:${REMOTE_PATH}" "$MOUNT_PATH" 2>&1) || true
    # マウント確認で成否を判定
    if findmnt "$MOUNT_PATH" &>/dev/null; then
      echo "Mounted ${WORKSPACE}.coder:${REMOTE_PATH} → ${MOUNT_PATH}"
    else
      echo "[coder-mount] Error: mount failed for ${WORKSPACE}.coder:${REMOTE_PATH}" >&2
      [ -n "$SSHFS_ERR" ] && echo "[coder-mount] sshfs: ${SSHFS_ERR}" >&2
      exit 1
    fi
    ;;

  unmount)
    if [ -z "$WORKSPACE" ]; then
      echo "Error: workspace name required" >&2
      echo "Usage: $0 unmount <workspace> [mount_path]" >&2
      exit 1
    fi
    CTRL_SOCK="${HOME}/.ssh/coder-${WORKSPACE}.sock"
    if fusermount -u "$MOUNT_PATH" 2>/dev/null; then
      ssh -S "$CTRL_SOCK" -O exit "${WORKSPACE}.coder" 2>/dev/null || true
      echo "Unmounted ${MOUNT_PATH}"
    else
      echo "Error: failed to unmount ${MOUNT_PATH} (already unmounted?)" >&2
      exit 1
    fi
    ;;

  exec)
    if [ -z "$WORKSPACE" ]; then
      echo "Error: workspace name required" >&2
      echo "Usage: $0 exec <workspace> <cmd>" >&2
      exit 1
    fi
    CMD=${3:-}
    if [ -z "$CMD" ]; then
      echo "Error: command required" >&2
      echo "Usage: $0 exec <workspace> <cmd>" >&2
      exit 1
    fi
    CTRL_SOCK="${HOME}/.ssh/coder-${WORKSPACE}.sock"
    if [ ! -S "$CTRL_SOCK" ]; then
      echo "Error: no ControlMaster socket for ${WORKSPACE}. Run: $0 mount ${WORKSPACE}" >&2
      exit 1
    fi
    ssh -S "$CTRL_SOCK" "${WORKSPACE}.coder" "$CMD"
    ;;

  status)
    echo "=== Mounted Coder workspaces ==="
    findmnt -t fuse.sshfs --output TARGET,SOURCE 2>/dev/null | grep coder || echo "(none)"
    ;;

  *)
    echo "Usage: $0 <mount|unmount|status> [workspace] [mount_path]" >&2
    exit 1
    ;;
esac
