#!/usr/bin/env python3
"""Tiny UI driver for emulator/device walkthroughs via adb + uiautomator (no test framework).

    tools/emu/ui.py shot <name>            screenshot to $P3D_SHOTS/<name>.png (+ a 30 % preview)
    tools/emu/ui.py texts                  visible texts / content descriptions with centres
    tools/emu/ui.py tap "<text>" [index]   tap the centre of the first (or index-th) node whose text or
                                           content-desc contains <text> (case-insensitive)
    tools/emu/ui.py wait "<text>" [secs]   wait until such a node exists
    tools/emu/ui.py has "<text>"           exit 0 if present
Uses ANDROID_SERIAL if set.
"""
import os, re, subprocess, sys, time, xml.etree.ElementTree as ET

SHOTS = os.environ.get("P3D_SHOTS", ".work/emu")


def adb(*a, binary=False, timeout=60):
    r = subprocess.run(["adb", *a], capture_output=True, timeout=timeout)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def dump():
    for _ in range(4):
        out = adb("exec-out", "uiautomator", "dump", "/dev/tty")
        i = out.find("<?xml")
        j = out.rfind("</hierarchy>")
        if i >= 0 and j > i:
            try:
                return ET.fromstring(out[i:j + 12])
            except ET.ParseError:
                pass
        time.sleep(0.7)
    raise SystemExit("could not dump UI")


def nodes():
    out = []
    for n in dump().iter("node"):
        t = n.get("text") or ""
        d = n.get("content-desc") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
        if not m or not (t or d):
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        out.append({"text": t, "desc": d, "x": (x1 + x2) // 2, "y": (y1 + y2) // 2, "w": x2 - x1, "h": y2 - y1,
                    "enabled": n.get("enabled") == "true", "cls": (n.get("class") or "").split(".")[-1]})
    return out


def find(text):
    t = text.lower()
    return [n for n in nodes() if t in n["text"].lower() or t in n["desc"].lower()]


def main():
    cmd = sys.argv[1]
    if cmd == "shot":
        os.makedirs(SHOTS, exist_ok=True)
        p = os.path.join(SHOTS, sys.argv[2] + ".png")
        open(p, "wb").write(adb("exec-out", "screencap", "-p", binary=True))
        subprocess.run(["magick", p, "-resize", "30%", os.path.join(SHOTS, sys.argv[2] + "_s.png")])
        print(p)
    elif cmd == "texts":
        for n in nodes():
            label = n["text"] or f"[{n['desc']}]"
            print(f"{n['x']:5d} {n['y']:5d}  {'' if n['enabled'] else '(disabled) '}{label[:110]}")
    elif cmd == "tap":
        idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        f = find(sys.argv[2])
        if len(f) <= idx:
            print("NOT FOUND:", sys.argv[2]); sys.exit(1)
        adb("shell", "input", "tap", str(f[idx]["x"]), str(f[idx]["y"]))
        print("tapped", f[idx]["text"] or f[idx]["desc"], f[idx]["x"], f[idx]["y"])
    elif cmd == "wait":
        secs = float(sys.argv[3]) if len(sys.argv) > 3 else 20
        t0 = time.time()
        while time.time() - t0 < secs:
            if find(sys.argv[2]):
                print("found after %.1fs" % (time.time() - t0)); return
            time.sleep(1.0)
        print("TIMEOUT waiting for:", sys.argv[2]); sys.exit(1)
    elif cmd == "has":
        sys.exit(0 if find(sys.argv[2]) else 1)


if __name__ == "__main__":
    main()
