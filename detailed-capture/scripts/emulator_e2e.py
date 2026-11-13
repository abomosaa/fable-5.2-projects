#!/usr/bin/env python3
"""Drives the real app on an emulator/device through the whole workflow and saves screenshots as evidence.

  ANDROID_SERIAL=emulator-5590 scripts/emulator_e2e.py <set_dir> <evidence_dir> [--apk path] [--steps a,b,c]

Steps (default: all): install, import, register, fuse, viewer, edits, export, restart, camera, permission
The script only uses adb (input taps, uiautomator dumps, screencaps, logcat): it sees what a user would see.
"""
import argparse, glob, json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import adbui
from adbui import adb, tap, wait, find, nodes, shot

PKG = "com.detailedcapture.app"
log = []


def note(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log.append(line)


def text_of(q):
    n = find(q)
    return n["text"] if n else None


def texts():
    return [n["text"] for n in nodes() if n["text"]]


def wait_gone(q, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not find(q):
            return time.time() - t0
        time.sleep(1.5)
    raise SystemExit(f"timeout: {q} still visible")


def allow_notifications():
    """The app asks for the notification permission (progress while in background) the first time a fusion starts."""
    time.sleep(2)
    n = find("id:permission_allow_button")
    if n:
        adb("shell", "input", "tap", str(n["x"]), str(n["y"]))
        note("notification permission prompt shown on first Fuse: allowed")
        time.sleep(1.5)


def launch():
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(4)


def pick_all(skip="\0", want=99):
    subprocess.run([os.path.join(os.path.dirname(__file__), "pick_all.py"), skip, str(want)], check=True)


def app_files():
    return f"/sdcard/Android/data/{PKG}/files"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("set_dir")
    ap.add_argument("evidence")
    ap.add_argument("--apk", default="")
    ap.add_argument("--steps", default="install,import,register,fuse,viewer,edits,export,packages,restart,camera,permission")
    a = ap.parse_args()
    steps = a.steps.split(",")
    ev = a.evidence
    os.makedirs(ev, exist_ok=True)
    S = lambda name: shot(os.path.join(ev, name))
    stamp = time.strftime("%H%M%S")
    timing = {}

    if "install" in steps:
        if a.apk:
            note("install: " + adb("install", "-r", a.apk).strip().splitlines()[-1])
        adb("shell", "pm", "clear", PKG)
        # fresh, uniquely named files every run: replacing a file under an old name leaves a stale MediaStore row
        # (wrong size => the system picker hands out a truncated stream)
        adb("shell", "rm -rf /sdcard/Pictures/dc_* /sdcard/Pictures/dcwave* /sdcard/DCIM/* /sdcard/Pictures/.thumbnails")
        adb("shell", "content", "delete", "--uri", "content://media/external/images/media")
        adb("shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary")
        time.sleep(3)
        left = adb("shell", "content", "query", "--uri", "content://media/external/images/media", "--projection", "_display_name")
        note("gallery before the run: " + left.strip()[:200])
        adb("shell", "mkdir", "-p", f"/sdcard/Pictures/dc_{stamp}")
        # only the overview is in the gallery at first, so that the system picker cannot offer anything else
        ov = sorted(glob.glob(os.path.join(a.set_dir, "overview.*")))[0]
        tmp = "/tmp/dc_overview_" + os.path.basename(ov)
        subprocess.run(["cp", ov, tmp]); os.utime(tmp, None)   # byte-identical copy with a unique file time
        adb("push", tmp, f"/sdcard/Pictures/dc_{stamp}/{stamp}_" + os.path.basename(ov))
        adb("shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary")
        time.sleep(4)
        note("pushed the overview")

    if "import" in steps:
        launch()
        S("01_home_empty.png")
        tap("id:new_project"); time.sleep(1.5)
        S("02_new_project_sheet.png")
        tap("Import overview photo"); time.sleep(4)
        ns = [n for n in nodes() if n["desc"].startswith("Photo taken")]
        ov_desc = ns[0]["desc"]
        adb("shell", "input", "tap", str(ns[0]["x"]), str(ns[0]["y"]))
        wait("id:capture_map", 90); time.sleep(2)
        S("03_project_overview_only.png")
        note("overview imported: " + str(text_of("id:coverage_text")))
        files = sorted(glob.glob(os.path.join(a.set_dir, "closeup_*")) + glob.glob(os.path.join(a.set_dir, "x_*")))
        for f in files:
            adb("push", f, f"/sdcard/Pictures/dc_{stamp}/{stamp}_" + os.path.basename(f))
        adb("shell", "content", "call", "--uri", "content://media", "--method", "scan_volume", "--arg", "external_primary")
        time.sleep(5)
        note(f"pushed {len(files)} close-ups")
        tap("id:btn_import"); time.sleep(4)
        t0 = time.time()
        pick_all(ov_desc, len(files))
        time.sleep(3)
        S("04_importing_closeups.png")

    if "register" in steps:
        t0 = time.time()
        time.sleep(5)
        wait_gone("Cancel", 900)
        timing["import_and_register_s"] = round(time.time() - t0, 1)
        time.sleep(2)
        S("05_capture_map_registered.png")
        note("after registration: " + " | ".join(t for t in texts() if "verified" in t or "rejected" in t or "uncertain" in t))
        # inspect a rejected frame, if any (red-bordered thumbnails are not identifiable via uiautomator: open the first three)
        strip = find("id:filmstrip")
        if strip:
            for i in range(3):
                adb("shell", "input", "tap", str(strip["b"][0] + 90 + i * 185), str(strip["y"]))
                time.sleep(2.5)
                st = text_of("id:frame_status")
                S(f"06_frame_{i}_{(st or 'unknown').lower().replace(' ', '_')}.png")
                note(f"frame {i}: status={st}; " + " / ".join(t[2:90] for t in texts() if t.startswith("• ")))
                adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(1.5)

    if "fuse" in steps:
        tap("id:btn_fuse"); t0 = time.time(); allow_notifications(); time.sleep(4)
        S("07_fusing_progress.png")
        note("fusing: " + " | ".join(t for t in texts() if "%" in t or "tiles" in t.lower() or "/" in t)[:200])
        wait("id:btn_view", 1800)
        timing["fuse_s"] = round(time.time() - t0, 1)
        S("08_fused.png")
        note(f"fused in {timing['fuse_s']} s (includes re-check)")

    if "viewer" in steps:
        tap("id:btn_view"); time.sleep(5)
        S("09_viewer_fit.png")
        note("viewer: " + str(text_of("id:viewer_dims")))
        v = find("id:viewer")
        cx, cy = v["x"] - 60, v["y"] - 120   # a detailed part of the picture
        for _ in range(3):   # double-tap zoom x3
            adb("shell", "input", "tap", str(cx), str(cy)); time.sleep(0.12); adb("shell", "input", "tap", str(cx), str(cy)); time.sleep(2.0)
        time.sleep(3)
        S("10_viewer_zoomed.png")
        note("zoom label: " + " | ".join(t for t in texts() if "output pixels" in t))
        tap("id:mode_Compare"); time.sleep(5)
        S("11_compare_split.png")
        tap("id:mode_Sources"); time.sleep(3)
        S("12_sources_overlay.png")
        adb("shell", "input", "tap", str(cx), str(cy)); time.sleep(3)
        S("13_source_inspect_sheet.png")
        note("inspect: " + " | ".join(t for t in texts() if t.startswith("From ") or t.startswith("Overview only") or t.startswith("Sampled")))
        if find("View the original pixels"):
            tap("View the original pixels"); time.sleep(5)
            S("14_original_pixels_100pct.png")
            note("source view: " + " | ".join(t for t in texts() if "source pixels" in t or "Original pixels" in t))
            adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(2)
        else:
            adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(1)
        tap("id:mode_Detail"); time.sleep(3)
        S("15_detail_map.png")
        tap("id:btn_info"); time.sleep(2)
        S("16_result_details.png")
        note("details: " + " | ".join(texts())[:400])
        tap("Close"); time.sleep(1)

    if "edits" in steps:
        adb("shell", "input", "swipe", "900", str(find("id:mode_View")["y"]), "200", str(find("id:mode_View")["y"]), "300"); time.sleep(1.5)
        tap("id:mode_Rotate"); time.sleep(2)
        tap("id:btn_rot90"); time.sleep(4)
        d1 = text_of("id:viewer_dims")
        S("17_rotated_90.png")
        tap("id:btn_undo"); time.sleep(3)
        d2 = text_of("id:viewer_dims")
        tap("id:btn_redo"); time.sleep(3)
        d3 = text_of("id:viewer_dims")
        tap("id:btn_undo"); time.sleep(3)
        note(f"rotate/undo/redo dims: {d1} -> {d2} -> {d3}")
        tap("id:mode_Crop"); time.sleep(3)
        v = find("id:viewer")
        # the image is shown at 80 % of the fit size in crop mode: its top-left corner handle is 10 % in from the left
        vw = v["b"][2] - v["b"][0]
        if text_of("id:viewer_dims") != d2:   # start from an un-cropped, un-rotated image
            tap("Reset"); time.sleep(2)
        dims = re.findall(r"\d+", text_of("id:viewer_dims") or "4 3")
        img_h = vw * 0.8 * int(dims[1]) / max(1, int(dims[0]))
        hx, hy = v["b"][0] + vw * 0.1, v["y"] - img_h / 2
        adb("shell", "input", "swipe", str(int(hx)), str(int(hy)), str(int(hx + 260)), str(int(hy + 180)), "700"); time.sleep(3)
        d_tl = text_of("id:viewer_dims")
        # second corner: bottom-right handle, dragged inwards; the first adjustment must be kept
        bx, by = v["b"][0] + vw * 0.9, v["y"] + img_h / 2
        adb("shell", "input", "swipe", str(int(bx)), str(int(by)), str(int(bx - 220)), str(int(by - 150)), "700"); time.sleep(3)
        d_br = text_of("id:viewer_dims")
        # third: move the whole rectangle
        adb("shell", "input", "swipe", str(int(v["x"])), str(int(v["y"])), str(int(v["x"] - 60)), str(int(v["y"] - 40)), "600"); time.sleep(3)
        S("18_crop.png")
        note(f"crop: top-left drag -> {d_tl}; then bottom-right drag -> {d_br}; after moving the rectangle -> {text_of('id:viewer_dims')}")
        tap("id:btn_undo"); time.sleep(2); tap("id:btn_undo"); time.sleep(2)
        note("after two undos (bottom-right + move): " + str(text_of("id:viewer_dims")))
        tap("id:mode_ColorM"); time.sleep(2)
        S("19_colour_controls.png")
        tap("id:btn_undo"); time.sleep(2)
        note("after undo of crop dims: " + str(text_of("id:viewer_dims")))

    if "export" in steps:
        tap("id:btn_export"); time.sleep(2)
        S("20_export_sheet.png")
        tap("PNG — lossless"); t0 = time.time(); time.sleep(3)
        wait("Export ready", 900)
        timing["export_png_s"] = round(time.time() - t0, 1)
        S("21_export_ready.png")
        note("export: " + " | ".join(t for t in texts() if "px" in t or ".png" in t))
        tap("Share"); time.sleep(4)
        S("22_native_share_sheet.png")
        note("share sheet: " + " | ".join(texts())[:200])
        adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(2)
        if find("Close"):
            tap("Close")
        out = adb("shell", "ls", "-la", app_files() + "/exports/")
        note("exports dir:\n" + out)
        pngs = re.findall(r"(\S+\.png)", out)
        if pngs:
            local = os.path.join(ev, "exported_from_device.png")
            adb("pull", app_files() + "/exports/" + pngs[-1], local)
            note("pulled " + pngs[-1] + f" ({os.path.getsize(local)} bytes)")

    if "packages" in steps:
        # tile package (Deep Zoom + offline viewer) and portable project archive, checked on the host afterwards
        if not find("id:btn_export"):
            tap("id:btn_view"); time.sleep(4)
        tap("id:btn_export"); time.sleep(2)
        tap("Tile package (.zip)"); t0 = time.time(); time.sleep(3)
        wait("Export ready", 1800)
        timing["tile_package_s"] = round(time.time() - t0, 1)
        S("50_tile_package_ready.png")
        note("tile package: " + " | ".join(t for t in texts() if "pyramid" in t or ".zip" in t))
        tap("Close"); time.sleep(1)
        adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(2)
        tap("desc:More"); time.sleep(1.5)
        tap("Export project archive"); t0 = time.time(); time.sleep(3)
        wait("Export ready", 1800)
        timing["project_archive_s"] = round(time.time() - t0, 1)
        S("51_project_archive_ready.png")
        note("project archive: " + " | ".join(t for t in texts() if "archive" in t.lower() or ".zip" in t))
        tap("Close"); time.sleep(1)
        out = adb("shell", "ls", "-la", app_files() + "/exports/")
        note("exports dir:\n" + out)
        for name in re.findall(r"(\S+\.zip)", out):
            adb("pull", app_files() + "/exports/" + name, os.path.join(ev, "tiles_package.zip" if "-tiles-" in name else "project_archive.dcap.zip"))

    if "restart" in steps:
        # start a fusion, kill the process mid-way, relaunch, resume
        if not find("id:btn_fuse"):
            # already fused: make the result stale by excluding the first close-up
            if not find("id:capture_map"):
                adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(2)
            strip = find("id:filmstrip")
            adb("shell", "input", "tap", str(strip["b"][0] + 90), str(strip["y"])); time.sleep(3)
            if find("id:btn_exclude"):
                tap("id:btn_exclude"); time.sleep(2)
            adb("shell", "input", "keyevent", "KEYCODE_BACK"); time.sleep(3)
            wait_gone("Cancel", 600); time.sleep(2)
            S("23_stale_after_exclude.png")
            note("stale: " + " | ".join(t for t in texts() if "out of date" in t or "excluded" in t)[:200])
        tap("id:btn_fuse"); allow_notifications()
        t0 = time.time()
        seen = ""
        while time.time() - t0 < 1500:
            tt = " | ".join(texts())
            m = re.search(r"(\d+) / (\d+)", tt)
            if "Rendering detail tiles" in tt and m and int(m.group(1)) >= max(4, int(m.group(2)) // 6):
                seen = m.group(0)
                break
            if find("id:btn_view"):
                break
            time.sleep(0.5)
        S("24_before_kill.png")
        note(f"killing the process while rendering (progress {seen or 'not caught: fusion finished first'})")
        adb("shell", "am", "force-stop", PKG); time.sleep(2)
        launch(); time.sleep(3)
        S("25_relaunched_home.png")
        first = [n for n in nodes() if n["text"].startswith("Capture ")]
        adb("shell", "input", "tap", str(first[0]["x"]), str(first[0]["y"])); time.sleep(6)
        S("26_interrupted_banner.png")
        note("after restart: " + " | ".join(t for t in texts() if "interrupted" in t.lower() or "Resume" in t or "out of date" in t or "verified" in t)[:300])
        if find("Resume"):
            tap("Resume"); t0 = time.time(); time.sleep(5)
            S("27_resuming.png")
            note("resuming: " + " | ".join(t for t in texts() if "/" in t or "Rendering" in t)[:120])
            wait("id:btn_view", 3000)
            timing["resume_s"] = round(time.time() - t0, 1)
            S("28_resumed_done.png")
            note(f"resumed and finished in {timing['resume_s']} s")
        else:
            note("no Resume banner (nothing was interrupted)")

    if "camera" in steps:
        adb("shell", "pm", "grant", PKG, "android.permission.CAMERA")
        tap("id:btn_capture"); time.sleep(7)
        S("30_camera_closeup.png")
        note("camera guidance: " + str(text_of("id:guidance")))
        tap("id:shutter"); time.sleep(8)
        S("31_camera_after_shot.png")
        note("camera flash text: " + str(text_of("id:camera_flash")))
        tap("Done"); time.sleep(3)
        wait_gone("Cancel", 600); time.sleep(2)
        S("32_project_after_camera_shot.png")
        note("after camera shot: " + " | ".join(t for t in texts() if "verified" in t or "rejected" in t or "uncertain" in t))

    if "permission" in steps:
        adb("shell", "pm", "revoke", PKG, "android.permission.CAMERA"); time.sleep(1)
        launch(); time.sleep(2)
        first = [n for n in nodes() if n["text"].startswith("Capture ")]
        if first:
            adb("shell", "input", "tap", str(first[0]["x"]), str(first[0]["y"])); time.sleep(4)
        tap("id:btn_capture"); time.sleep(3)
        S("40_permission_dialog.png")
        deny = find("Don") or find("Deny")
        if deny:
            adb("shell", "input", "tap", str(deny["x"]), str(deny["y"])); time.sleep(2)
        S("41_permission_denied_screen.png")
        note("denied screen: " + " | ".join(texts())[:300])
        adb("shell", "input", "keyevent", "KEYCODE_BACK")

    json.dump({"timing": timing, "log": log}, open(os.path.join(ev, "e2e_log.json"), "w"), indent=1)
    note("timing: " + json.dumps(timing))


if __name__ == "__main__":
    main()
