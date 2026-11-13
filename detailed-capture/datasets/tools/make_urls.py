"""make_urls.py <sets.json> <out.tsv>  -> lines: set<TAB>local<TAB>bytes<TAB>original_url  (one batched API query per set)"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import commons
man = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as out:
    for name, s in man.items():
        info = commons.imageinfo([t for _, t in s["files"]])
        for local, title in s["files"]:
            out.write("%s\t%s\t%d\t%s\n" % (name, local, info[title]["size"], info[title]["url"].split("?")[0]))
print("ok")
