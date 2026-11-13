#!/usr/bin/env python3
"""Selects every photo in the open Android photo picker except those whose description contains SKIP, then taps Done."""
import re, sys, time
sys.path.insert(0, __file__.rsplit("/", 1)[0]); import adbui
skip = sys.argv[1] if len(sys.argv) > 1 else "\0"
want = int(sys.argv[2]) if len(sys.argv) > 2 else 99
def count(ns):
    for n in ns:
        m = re.match(r"(\d+) photos? or videos? selected", n["desc"])
        if m: return int(m.group(1))
    return 0
adbui.adb("shell", "input", "swipe", "540", "620", "540", "200", "300"); time.sleep(1.2)   # expand the sheet
stale = 0
while stale < 2:
    ns = adbui.nodes(); c0 = count(ns); progressed = False
    for n in [n for n in ns if n["desc"].startswith("Photo taken") and skip not in n["desc"] and 330 < n["y"] < 1980]:
        if count(adbui.nodes()) >= want: break
        before = count(adbui.nodes())
        adbui.adb("shell", "input", "tap", str(n["x"]), str(n["y"])); time.sleep(0.5)
        after = count(adbui.nodes())
        if after < before:  # was already selected: undo the deselect
            adbui.adb("shell", "input", "tap", str(n["x"]), str(n["y"])); time.sleep(0.5)
        elif after > before: progressed = True
    if count(adbui.nodes()) >= want: break
    stale = 0 if progressed else stale + 1
    adbui.adb("shell", "input", "swipe", "540", "1700", "540", "700", "700"); time.sleep(1.5)
print("selected", count(adbui.nodes()))
adbui.tap("Done")
