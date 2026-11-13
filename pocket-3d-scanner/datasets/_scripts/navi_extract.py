#!/usr/bin/env python3
"""Extract selected members from the NAVI release tarball (a ~17 GB .tar.gz)
without unpacking the whole archive, and stop reading as soon as every wanted
member has been written.

The tarball is untrusted data: this script never calls extract()/extractall().
It only copies the bytes of *regular file* members whose exact names appear in
a members list, to output paths taken from that same list (validated to stay
inside the output directory). Run with `python3 -I`.

usage:
  curl -sL <url> | python3 -I navi_extract.py --map <members.tsv> <out_dir> [--map ...]
  python3 -I navi_extract.py --src navi_v1.0.tar.gz --map <members.tsv> <out_dir> [--map ...]

members.tsv format (tab separated, '#' comments allowed):
  <tar member name>\t<path relative to out_dir>
"""
import argparse
import os
import sys
import tarfile


def load_map(tsv, out_dir, wanted):
    out_dir = os.path.abspath(out_dir)
    with open(tsv, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip() or line.startswith("#"):
                continue
            member, rel = line.split("\t")
            if os.path.isabs(rel) or ".." in rel.split("/"):
                raise SystemExit(f"refusing suspicious output path: {rel!r}")
            dest = os.path.abspath(os.path.join(out_dir, rel))
            if not dest.startswith(out_dir + os.sep):
                raise SystemExit(f"output path escapes out_dir: {rel!r}")
            wanted.setdefault(member, []).append(dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="-", help="tar.gz path, or '-' for stdin (default)")
    ap.add_argument("--map", nargs=2, action="append", required=True,
                    metavar=("MEMBERS_TSV", "OUT_DIR"))
    args = ap.parse_args()

    wanted = {}
    for tsv, out_dir in args.map:
        load_map(tsv, out_dir, wanted)
    remaining = set(wanted)
    total = len(remaining)

    fileobj = sys.stdin.buffer if args.src == "-" else open(args.src, "rb")
    done = 0
    with tarfile.open(fileobj=fileobj, mode="r|gz") as tar:
        for member in tar:
            if member.name not in remaining:
                continue
            if not member.isreg():
                raise SystemExit(f"wanted member is not a regular file: {member.name}")
            src = tar.extractfile(member)
            dests = wanted[member.name]
            first = dests[0]
            os.makedirs(os.path.dirname(first), exist_ok=True)
            tmp = first + ".part"
            with open(tmp, "wb") as out:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            os.chmod(tmp, 0o644)
            os.replace(tmp, first)
            for extra in dests[1:]:
                os.makedirs(os.path.dirname(extra), exist_ok=True)
                with open(first, "rb") as a, open(extra, "wb") as b:
                    b.write(a.read())
            remaining.discard(member.name)
            done += 1
            if done % 50 == 0 or not remaining:
                print(f"navi_extract: {done}/{total} members written", file=sys.stderr)
            if not remaining:
                break
    if remaining:
        print(f"navi_extract: {len(remaining)} wanted members NOT found, e.g. "
              f"{sorted(remaining)[:3]}", file=sys.stderr)
        return 1
    # Finished early on purpose; the upstream `curl` will get SIGPIPE, which is fine.
    return 0


if __name__ == "__main__":
    sys.exit(main())
