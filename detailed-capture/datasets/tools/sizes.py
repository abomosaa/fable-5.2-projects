"""sizes.py <Category> <regex> -> title, WxH, MB, license, author for matching files"""
import sys, re
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import commons
rx = re.compile(sys.argv[2])
titles = [t for t in commons.category_titles(sys.argv[1], "file") if rx.search(t)]
info = commons.imageinfo(titles)
tot = 0
for t in titles:
    s = commons.summarize(t, info[t]); tot += s["bytes"]
    print("%-70s %5dx%-5d %5.1fMB %s | %s | %s" % (t[-70:], s["width"], s["height"], s["bytes"]/1e6, s["license"], s["author"][:40], s["date_original"][:19]))
print("total %.1f MB" % (tot/1e6))
