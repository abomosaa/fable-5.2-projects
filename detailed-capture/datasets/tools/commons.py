"""Polite Wikimedia Commons helper (stdlib only).

  commons.py list   <Category:Name>                      -> title | WxH | uploader | license | date
  commons.py thumbs <outdir> <Category:Name> [regex] [w] -> NNN.jpg thumbnails + index.txt
  commons.py tthumbs <outdir> <w> <title> [<title>...]   -> thumbnails for explicit titles
  commons.py info   <title> [<title>...]                 -> JSON metadata (license, author, urls, size)
  commons.py get    <title> <outpath> [maxwidth]         -> download original (or rendition <= maxwidth)

All requests are sequential, throttled, and honour HTTP 429 Retry-After.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UA = "DetailedCaptureEval/0.2 (one-off research dataset collection for an image registration benchmark; sequential, low volume)"
# Per-host minimum gap between requests (seconds). upload.wikimedia.org (originals) is strictly
# rate limited for scripted clients (HTTP 429, Retry-After 600 after a handful of quick requests).
GAPS = {"upload.wikimedia.org": 30.0, "thumb.wikimedia.org": 3.0, "commons.wikimedia.org": 3.0}
_last = {}


def fetch(url, binary=False, tries=6):
    host = urllib.parse.urlsplit(url).netloc
    min_gap = GAPS.get(host, 3.0)
    for attempt in range(tries):
        gap = time.time() - _last.get(host, 0.0)
        if gap < min_gap:
            time.sleep(min_gap - gap)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            _last[host] = time.time()
            return data if binary else data.decode("utf-8")
        except urllib.error.HTTPError as e:
            _last[host] = time.time()
            if e.code in (429, 503):
                wait = int(e.headers.get("Retry-After") or 30) + 2
                sys.stderr.write("HTTP %d from %s, sleeping %ds\n" % (e.code, host, wait))
                sys.stderr.flush()
                time.sleep(min(wait, 700))
                continue
            raise
    raise RuntimeError("giving up on " + url)


def api(params):
    params = dict(params, format="json", formatversion="2")
    return json.loads(fetch(API + "?" + urllib.parse.urlencode(params)))


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", s or "")).strip()


def category_titles(cat, kinds="file|subcat"):
    out, cont = [], {}
    while True:
        r = api(dict({"action": "query", "list": "categorymembers", "cmtitle": cat,
                      "cmtype": kinds, "cmlimit": "500"}, **cont))
        out += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" not in r:
            return sorted(out)
        cont = r["continue"]


def imageinfo(titles, width=None):
    """Return {title: info-dict} for the given file titles (batched 40 per request)."""
    res = {}
    for i in range(0, len(titles), 40):
        chunk = titles[i:i + 40]
        p = {"action": "query", "titles": "|".join(chunk), "prop": "imageinfo",
             "iiprop": "url|size|user|mime|sha1|extmetadata"}
        if width:
            p["iiurlwidth"] = str(width)
        cont = {}
        while True:
            r = api(dict(p, **cont))
            for pg in r["query"]["pages"]:
                if "imageinfo" in pg:
                    res[pg["title"]] = pg["imageinfo"][0]
            if "continue" not in r:
                break
            cont = r["continue"]
    return res


def summarize(title, ii):
    em = ii.get("extmetadata", {})
    g = lambda k: strip_html(em.get(k, {}).get("value", ""))
    return {
        "title": title,
        "width": ii.get("width"), "height": ii.get("height"), "bytes": ii.get("size"),
        "mime": ii.get("mime"), "sha1": ii.get("sha1"),
        "uploader": ii.get("user"),
        "author": g("Artist"), "credit": g("Credit"),
        "license": g("LicenseShortName"), "license_url": g("LicenseUrl"),
        "usage_terms": g("UsageTerms"),
        "date_original": g("DateTimeOriginal"),
        "description": g("ImageDescription")[:300],
        "url": ii.get("url", "").split("?")[0],
        "page": ii.get("descriptionurl"),
        "thumburl": ii.get("thumburl"),
    }


def main():
    cmd = sys.argv[1]
    if cmd == "list":
        titles = category_titles(sys.argv[2])
        files = [t for t in titles if t.startswith("File:")]
        info = imageinfo(files)
        for t in titles:
            if t in info:
                s = summarize(t, info[t])
                print(" | ".join([t, "%sx%s" % (s["width"], s["height"]), s["uploader"] or "",
                                  s["license"], s["date_original"][:22]]))
            else:
                print(t)
    elif cmd in ("thumbs", "tthumbs"):
        if cmd == "thumbs":
            out, cat = sys.argv[2], sys.argv[3]
            rx = re.compile(sys.argv[4] if len(sys.argv) > 4 else ".")
            w = int(sys.argv[5]) if len(sys.argv) > 5 else 500
            titles = [t for t in category_titles(cat, "file") if rx.search(t)]
        else:
            out, w, titles = sys.argv[2], int(sys.argv[3]), sys.argv[4:]
        os.makedirs(out, exist_ok=True)
        info = imageinfo(titles, w)
        with open(os.path.join(out, "index.txt"), "w") as idx:
            for n, t in enumerate(titles, 1):
                if t not in info or not info[t].get("thumburl"):
                    print("no thumb:", t)
                    continue
                dst = os.path.join(out, "%03d.jpg" % n)
                with open(dst, "wb") as f:
                    f.write(fetch(info[t]["thumburl"], binary=True))
                line = "%03d %s | %sx%s | %s" % (n, t, info[t]["width"], info[t]["height"], info[t].get("user"))
                idx.write(line + "\n")
                print(line)
    elif cmd == "info":
        info = imageinfo(sys.argv[2:])
        print(json.dumps([summarize(t, info[t]) for t in sys.argv[2:] if t in info], indent=1, ensure_ascii=False))
    elif cmd == "get":
        title, dst = sys.argv[2], sys.argv[3]
        maxw = int(sys.argv[4]) if len(sys.argv) > 4 else None
        ii = imageinfo([title], maxw)[title]
        url = ii["thumburl"] if (maxw and ii["width"] > maxw) else ii["url"]
        data = fetch(url, binary=True)
        with open(dst, "wb") as f:
            f.write(data)
        print(dst, len(data), "bytes", "rendition<=%d" % maxw if (maxw and ii["width"] > maxw) else "original", url.split("?")[0])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
