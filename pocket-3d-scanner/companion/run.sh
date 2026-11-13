#!/usr/bin/env bash
# Start the Pocket 3D Scanner companion container and show its pairing QR code.
#
#   ./run.sh                     start (Ctrl-C stops it; running jobs can be retried afterwards)
#   ./run.sh pair [--rotate]     show the pairing details of the running companion again
#   ./run.sh devices [...]       list / revoke paired phones   (see `devices --help`)
#
# Settings (environment variables):
#   POCKET3D_IMAGE       container image                 (default: pocket3d-companion)
#   POCKET3D_PORT        port on this computer           (default: 8443)
#   POCKET3D_DATA_DIR    where photos and results live   (default: ./companion-data;
#                        set POCKET3D_VOLUME=<name> to use a named volume instead)
#   POCKET3D_CPUS        CPU limit                       (default: half of the cores)
#   POCKET3D_MEMORY      memory limit                    (default: 10g)
#   POCKET3D_ADVERTISE   this computer's LAN address(es), comma separated
#                        (default: all non-loopback IPv4 addresses found; 10.0.2.2 — the
#                        Android emulator's alias for this computer — is always appended)
#   POCKET3D_LIMIT_ARGS  replaces the "--cpus N --memory M" container flags, e.g.
#                        "--cgroups=disabled" when this shell already runs inside a
#                        memory-limited service the container must not leave. The companion
#                        still bounds each reconstruction to POCKET3D_CPUS threads and
#                        POCKET3D_MEMORY minus 1.5 GB (it watches the job's memory itself).
set -euo pipefail

IMAGE="${POCKET3D_IMAGE:-pocket3d-companion}"
NAME="${POCKET3D_CONTAINER_NAME:-pocket3d-companion}"
PORT="${POCKET3D_PORT:-8443}"
MEMORY="${POCKET3D_MEMORY:-10g}"

if command -v podman >/dev/null 2>&1; then
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  echo "error: neither podman nor docker was found" >&2
  exit 1
fi

TTY_FLAGS=(-i)
if [ -t 0 ] && [ -t 1 ]; then
  TTY_FLAGS=(-it)
fi

# `./run.sh pair` / `./run.sh devices …` talk to the running container.
if [ "${1:-}" = "pair" ] || [ "${1:-}" = "devices" ]; then
  exec "$ENGINE" exec "${TTY_FLAGS[@]}" "$NAME" python3 -m pocket3d_companion "$@"
fi

# --- resources: half of the cores unless told otherwise -------------------------------------
cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
half=$(( cores / 2 ))
if [ "$half" -lt 1 ]; then
  half=1
fi
CPUS="${POCKET3D_CPUS:-$half}"

# --- LAN addresses for the pairing QR (the container cannot see the host's interfaces) -------
detect_ips() {
  if command -v ip >/dev/null 2>&1; then
    # Global IPv4 addresses, skipping loopback and container/VM bridges.
    ip -4 -o addr show scope global up 2>/dev/null \
      | awk '$2 !~ /^(lo|docker|podman|veth|br-|virbr|cni|flannel|lxc)/ { split($4, a, "/"); print a[1] }'
  elif command -v ifconfig >/dev/null 2>&1; then          # macOS / BSD
    ifconfig 2>/dev/null | awk '$1 == "inet" && $2 !~ /^127\./ { print $2 }'
  fi
}
ADVERTISE="${POCKET3D_ADVERTISE:-$(detect_ips | paste -sd, -)}"
if [ -z "$ADVERTISE" ]; then
  echo "warning: no LAN IPv4 address found; set POCKET3D_ADVERTISE=<this computer's address>." >&2
  echo "         Using 127.0.0.1 (only the Android emulator can connect, via 10.0.2.2)." >&2
  ADVERTISE=127.0.0.1
fi

# --- data: bind mount by default, named volume on request -------------------------------------
if [ -n "${POCKET3D_VOLUME:-}" ]; then
  DATA_MOUNT="${POCKET3D_VOLUME}:/data"
else
  DATA_DIR="${POCKET3D_DATA_DIR:-$PWD/companion-data}"
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  DATA_MOUNT="$(cd "$DATA_DIR" && pwd):/data"
  # SELinux hosts need a private label on bind mounts; harmless elsewhere with podman.
  if [ "$ENGINE" = podman ]; then
    DATA_MOUNT="${DATA_MOUNT}:Z"
  fi
fi

case ",$ADVERTISE," in
  *,10.0.2.2,*) ;;
  *) ADVERTISE="${ADVERTISE},10.0.2.2" ;;
esac

# --- per-job limits handed to the companion: the container limit minus headroom for the server ----
mem_mb() {
  case "$1" in
    *[gG]) echo $(( ${1%[gG]} * 1024 )) ;;
    *[mM]) echo "${1%[mM]}" ;;
    *) echo $(( $1 / 1048576 )) ;;
  esac
}
JOB_MEMORY_MB=$(( $(mem_mb "$MEMORY") - 1536 ))
if [ "$JOB_MEMORY_MB" -lt 2048 ]; then
  echo "error: POCKET3D_MEMORY=$MEMORY is too small (need at least 3.5g)" >&2
  exit 1
fi
JOB_THREADS="${CPUS%.*}"
read -r -a LIMIT_ARGS <<< "${POCKET3D_LIMIT_ARGS:---cpus $CPUS --memory $MEMORY}"

echo "Starting $IMAGE with $ENGINE: ${CPUS} CPUs, ${MEMORY} memory (${JOB_MEMORY_MB} MB per reconstruction), port ${PORT}, addresses ${ADVERTISE}" >&2

# --init: a minimal init reaps stray processes of cancelled reconstructions.
# The companion listens on 8443 inside the container; --advertise-port tells phones the host port.
# Hardening: no Linux capabilities, no privilege escalation, read-only root filesystem (only
# the data directory and a small /tmp are writable).
exec "$ENGINE" run --rm --init "${TTY_FLAGS[@]}" \
  --name "$NAME" \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs /tmp:rw,size=256m \
  -p "${PORT}:8443" \
  -v "$DATA_MOUNT" \
  "${LIMIT_ARGS[@]}" \
  -e POCKET3D_QR="${POCKET3D_QR:-dark}" \
  "$IMAGE" \
  serve --host 0.0.0.0 --port 8443 --advertise "$ADVERTISE" --advertise-port "$PORT" \
        --job-threads "$JOB_THREADS" --job-memory-mb "$JOB_MEMORY_MB" "$@"
