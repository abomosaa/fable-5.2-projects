#!/usr/bin/env python3
"""Tiny adb UI driver used for emulator verification (no extra dependencies).

  adbui.py shot <out.png>
  adbui.py dump                       # list visible texts / ids / descriptions with centres
  adbui.py tap <text|id:tag|desc:...> # tap first matching node
  adbui.py wait <text|id:tag> [secs]
  adbui.py xy <x> <y>
"""
import os, re, subprocess, sys, time
import xml.etree.ElementTree as ET

SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5590")


def adb(*a, binary=False):
    r = subprocess.run(["adb", "-s", SERIAL, *a], capture_output=True)
    return r.stdout if binary else r.stdout.decode(errors="replace")


def nodes():
    for _ in range(4):
        adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
        xml = adb("exec-out", "cat", "/sdcard/ui.xml")
        try:
            root = ET.fromstring(xml)
            break
        except ET.ParseError:
            time.sleep(0.5)
    else:
        return []
    out = []
    for n in root.iter("node"):
        b = re.findall(r"\d+", n.get("bounds", ""))
        if len(b) != 4:
            continue
        x0, y0, x1, y1 = map(int, b)
        out.append({"text": n.get("text", ""), "id": n.get("resource-id", ""), "desc": n.get("content-desc", ""), "cls": n.get("class", ""),
                    "x": (x0 + x1) // 2, "y": (y0 + y1) // 2, "b": (x0, y0, x1, y1), "enabled": n.get("enabled") == "true", "clickable": n.get("clickable") == "true"})
    return out


def find(q, ns=None):
    ns = ns if ns is not None else nodes()
    if not q.startswith("id:") and not q.startswith("desc:"):
        for n in ns:  # exact text match wins over substring match
            if n["text"].strip().lower() == q.lower():
                return n
    for n in ns:
        if q.startswith("id:"):
            if n["id"] == q[3:] or n["id"].endswith("/" + q[3:]):
                return n
        elif q.startswith("desc:"):
            if q[5:].lower() in n["desc"].lower():
                return n
        elif q.lower() in n["text"].lower() and n["text"]:
            return n
    return None


def tap(q, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        n = find(q)
        if n:
            adb("shell", "input", "tap", str(n["x"]), str(n["y"]))
            return n
        time.sleep(0.6)
    raise SystemExit(f"not found: {q}")


def wait(q, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        n = find(q)
        if n:
            return n
        time.sleep(1.0)
    raise SystemExit(f"timeout waiting for: {q}")


def shot(path):
    open(path, "wb").write(adb("exec-out", "screencap", "-p", binary=True))


if __name__ == "__main__":
    c = sys.argv[1]
    if c == "shot":
        shot(sys.argv[2])
    elif c == "dump":
        for n in nodes():
            if n["text"] or n["desc"] or (n["id"] and "android:id" not in n["id"]):
                print(f'{n["x"]:5d},{n["y"]:5d}  text={n["text"][:70]!r} id={n["id"]!r} desc={n["desc"]!r} en={n["enabled"]}')
    elif c == "tap":
        print(tap(sys.argv[2]))
    elif c == "wait":
        print(wait(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 30))
    elif c == "xy":
        adb("shell", "input", "tap", sys.argv[2], sys.argv[3])
