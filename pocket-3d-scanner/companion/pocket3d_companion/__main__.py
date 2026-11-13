"""Command line of the Pocket 3D Scanner companion.

    python -m pocket3d_companion serve            run the companion (prints the pairing QR)
    python -m pocket3d_companion pair [--rotate]  show the pairing details again / replace the code
    python -m pocket3d_companion devices          list paired phones
    python -m pocket3d_companion devices revoke <device_id> [--purge]
    python -m pocket3d_companion version
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from pathlib import Path

from . import __version__
from .config import load_config, parse_address_list


def _data_dir(args: argparse.Namespace) -> Path:
    return Path(args.data or os.environ.get("POCKET3D_DATA") or "./companion-data").expanduser().resolve()


def _running_server_pid(data_dir: Path) -> int | None:
    from .storage import read_json
    try:
        pid = int(read_json(data_dir / "server.pid")["pid"])
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError, KeyError, TypeError):
        return None


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import serve
    advertise = None
    if args.advertise:
        advertise = [a for item in args.advertise for a in parse_address_list(item)]
    try:
        cfg = load_config({
            "data_dir": args.data, "host": args.host, "port": args.port, "advertise": advertise,
            "advertise_port": args.advertise_port, "server_name": args.name, "qr": args.qr,
            "max_parallel_jobs": args.max_parallel_jobs, "job_threads": args.job_threads,
            "job_memory_mb": args.job_memory_mb})
    except (ValueError, OSError) as e:
        print(f"configuration error: {e}", file=sys.stderr)
        return 2
    logging.basicConfig(level=getattr(logging, args.log_level.upper()), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    os.umask(0o077)   # photographs, keys and job data are private to this user
    try:
        asyncio.run(serve(cfg))
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:      # e.g. a damaged server.json / devices.json
        print(f"error: cannot read the companion's state in {cfg.data_dir}: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"error: cannot start the server: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_pair(args: argparse.Namespace) -> int:
    from .security import pairing_banner
    data_dir = _data_dir(args)
    path = data_dir / "pairing.txt"
    pid = _running_server_pid(data_dir)
    if pid is None:
        print("The companion is not running for this data directory; start it with "
              "`python -m pocket3d_companion serve` — it prints the pairing code.", file=sys.stderr)
        return 1
    if args.rotate:
        before = path.read_text() if path.exists() else ""
        os.kill(pid, signal.SIGUSR1)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            time.sleep(0.1)
            if path.exists() and path.read_text() != before:
                break
        else:
            print("The companion did not confirm a new pairing code.", file=sys.stderr)
            return 1
    try:
        uri = path.read_text().strip()
    except OSError:
        print("No pairing information found.", file=sys.stderr)
        return 1
    print(pairing_banner(uri, qr_mode=args.qr or os.environ.get("POCKET3D_QR") or "dark"))
    return 0


def cmd_devices(args: argparse.Namespace) -> int:
    from .security import DeviceStore
    from .storage import UUID_RE
    data_dir = _data_dir(args)
    if not data_dir.is_dir():
        print(f"no companion data directory at {data_dir}", file=sys.stderr)
        return 1
    store = DeviceStore(data_dir)
    if args.action == "revoke":
        if not args.device_id or not UUID_RE.match(args.device_id):
            print("usage: devices revoke <device_id> [--purge]", file=sys.stderr)
            return 2
        existed = store.revoke(args.device_id, purge=args.purge)
        if not existed and not args.purge:
            print("no such device", file=sys.stderr)
            return 1
        print(f"revoked {args.device_id}" if existed else f"{args.device_id} was not paired")
        if args.purge:
            print("its sessions and jobs are removed by the running companion (or at its next start)")
        return 0
    if not store.devices:
        print("no paired devices")
        return 0
    for d in sorted(store.devices.values(), key=lambda d: d["created_at"]):
        fmt = lambda t: time.strftime("%Y-%m-%d %H:%M", time.localtime(t)) if t else "-"   # noqa: E731
        print(f"{d['device_id']}  {d['name'] or '(unnamed)':<24}  paired {fmt(d['created_at'])}  "
              f"last seen {fmt(d['last_seen_at'])}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pocket3d_companion", description="Pocket 3D Scanner — local reconstruction companion")
    sub = p.add_subparsers(dest="command")

    def add_data(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--data", metavar="DIR", help="data directory (env POCKET3D_DATA, default ./companion-data)")

    s = sub.add_parser("serve", help="run the companion")
    add_data(s)
    s.add_argument("--host", help="address to bind (default 0.0.0.0)")
    s.add_argument("--port", type=int, help="port to bind (default 8443)")
    s.add_argument("--advertise", action="append", metavar="IP[,IP…]",
                   help="address(es) of this computer to put into the pairing QR "
                        "(default: all non-loopback IPv4 addresses)")
    s.add_argument("--advertise-port", type=int, help="port to put into the pairing QR (default: the bound port)")
    s.add_argument("--name", help="name shown to phones (default: host name)")
    s.add_argument("--qr", choices=["dark", "light", "off"],
                   help="terminal background for the QR code, or off (default dark)")
    s.add_argument("--max-parallel-jobs", type=int, help="reconstructions running at once (default 1)")
    s.add_argument("--job-threads", type=int, help="CPU threads per reconstruction (default: half the cores)")
    s.add_argument("--job-memory-mb", type=int, help="memory limit per reconstruction in MB (default up to 10240)")
    s.add_argument("--log-level", default=os.environ.get("POCKET3D_LOG_LEVEL", "info"),
                   choices=["debug", "info", "warning", "error"])
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("pair", help="print the pairing details of the running companion again")
    add_data(s)
    s.add_argument("--rotate", action="store_true", help="replace the pairing code first")
    s.add_argument("--qr", choices=["dark", "light", "off"])
    s.set_defaults(func=cmd_pair)

    s = sub.add_parser("devices", help="list or revoke paired phones")
    add_data(s)
    s.add_argument("action", nargs="?", default="list", choices=["list", "revoke"])
    s.add_argument("device_id", nargs="?")
    s.add_argument("--purge", action="store_true", help="also delete the device's sessions and jobs")
    s.set_defaults(func=cmd_devices)

    s = sub.add_parser("version", help="print the version")
    s.set_defaults(func=lambda a: (print(__version__), 0)[1])
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
