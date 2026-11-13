// EXIF / ICC / container parsing for JPEG and PNG (no pixel decoding).
#include "dc/imageio.h"
#include <zlib.h>
#include <cstring>
#include <fstream>
#include <map>

namespace dc {

namespace {
struct Reader {
    const uint8_t* p;
    size_t n;
    bool le;
    uint16_t u16(size_t o) const {
        if (o + 2 > n) return 0;
        return le ? (p[o] | (p[o + 1] << 8)) : ((p[o] << 8) | p[o + 1]);
    }
    uint32_t u32(size_t o) const {
        if (o + 4 > n) return 0;
        return le ? (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | ((uint32_t)p[o + 3] << 24))
                  : (((uint32_t)p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]);
    }
};
uint32_t be32(const uint8_t* p) { return ((uint32_t)p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]; }

struct IfdEntry {
    uint16_t type;
    uint32_t count;
    size_t valueOff;  // absolute offset of the value bytes in the TIFF block
};
bool readIfd(const Reader& r, size_t off, std::map<uint16_t, IfdEntry>& out) {
    if (off + 2 > r.n) return false;
    int cnt = r.u16(off);
    static const int tsz[] = {0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8};
    for (int i = 0; i < cnt; i++) {
        size_t e = off + 2 + i * 12;
        if (e + 12 > r.n) return false;
        IfdEntry ent;
        uint16_t tag = r.u16(e);
        ent.type = r.u16(e + 2);
        ent.count = r.u32(e + 4);
        size_t sz = (ent.type < 13 ? tsz[ent.type] : 1) * (size_t)ent.count;
        ent.valueOff = sz <= 4 ? e + 8 : r.u32(e + 8);
        if (ent.valueOff + sz > r.n) continue;
        out[tag] = ent;
    }
    return true;
}
double rational(const Reader& r, const IfdEntry& e) {
    if (e.type == 5) {
        double a = r.u32(e.valueOff), b = r.u32(e.valueOff + 4);
        return b != 0 ? a / b : 0;
    }
    if (e.type == 10) {
        double a = (int32_t)r.u32(e.valueOff), b = (int32_t)r.u32(e.valueOff + 4);
        return b != 0 ? a / b : 0;
    }
    if (e.type == 3) return r.u16(e.valueOff);
    if (e.type == 4) return r.u32(e.valueOff);
    return 0;
}
std::string ascii(const Reader& r, const IfdEntry& e) {
    std::string s((const char*)r.p + e.valueOff, e.count);
    while (!s.empty() && (s.back() == 0 || s.back() == ' ')) s.pop_back();
    // keep it printable / valid for JSON
    for (auto& c : s)
        if ((unsigned char)c < 32 || (unsigned char)c > 126) c = '?';
    return s;
}

void parseExifTiff(const uint8_t* p, size_t n, ImageMeta& m) {
    if (n < 8) return;
    Reader r{p, n, false};
    if (p[0] == 'I' && p[1] == 'I') r.le = true;
    else if (p[0] == 'M' && p[1] == 'M') r.le = false;
    else return;
    if (r.u16(2) != 42) return;
    std::map<uint16_t, IfdEntry> ifd0, exif;
    if (!readIfd(r, r.u32(4), ifd0)) return;
    if (ifd0.count(0x0112)) {
        int o = ifd0[0x0112].type == 3 ? r.u16(ifd0[0x0112].valueOff) : (int)r.u32(ifd0[0x0112].valueOff);
        if (o >= 1 && o <= 8) m.orientation = o;
    }
    if (ifd0.count(0x010F)) m.exif["make"] = ascii(r, ifd0[0x010F]);
    if (ifd0.count(0x0110)) m.exif["model"] = ascii(r, ifd0[0x0110]);
    if (ifd0.count(0x0132)) m.exif["dateTime"] = ascii(r, ifd0[0x0132]);
    if (ifd0.count(0x8769)) {
        readIfd(r, r.u32(ifd0[0x8769].valueOff), exif);
        if (exif.count(0x829A)) m.exif["exposureTime"] = rational(r, exif[0x829A]);
        if (exif.count(0x829D)) m.exif["fNumber"] = rational(r, exif[0x829D]);
        if (exif.count(0x8827)) m.exif["iso"] = rational(r, exif[0x8827]);
        if (exif.count(0x920A)) m.exif["focalLength"] = rational(r, exif[0x920A]);
        if (exif.count(0xA405)) m.exif["focalLength35"] = rational(r, exif[0xA405]);
        if (exif.count(0xA434)) m.exif["lens"] = ascii(r, exif[0xA434]);
        if (exif.count(0x9003)) m.exif["dateTime"] = ascii(r, exif[0x9003]);
        if (exif.count(0xA001)) m.exif["colorSpaceTag"] = (int)rational(r, exif[0xA001]);
        if (exif.count(0xA404)) m.exif["digitalZoom"] = rational(r, exif[0xA404]);
    }
}

double s15f16(const uint8_t* p) { return (int32_t)be32(p) / 65536.0; }

// Identify the RGB space from the colourant tags of a matrix/TRC ICC profile.
std::string classifyIcc(const std::vector<uint8_t>& icc) {
    if (icc.size() < 132) return "unknown";
    if (memcmp(&icc[16], "RGB ", 4) != 0) return "unknown";
    uint32_t cnt = be32(&icc[128]);
    double col[3][3];
    bool have[3] = {false, false, false};
    for (uint32_t i = 0; i < cnt && 132 + (i + 1) * 12 <= icc.size(); i++) {
        const uint8_t* e = &icc[132 + i * 12];
        uint32_t off = be32(e + 4), sz = be32(e + 8);
        int k = !memcmp(e, "rXYZ", 4) ? 0 : !memcmp(e, "gXYZ", 4) ? 1 : !memcmp(e, "bXYZ", 4) ? 2 : -1;
        if (k < 0 || sz < 20 || (size_t)off + 20 > icc.size()) continue;
        for (int c = 0; c < 3; c++) col[k][c] = s15f16(&icc[off + 8 + c * 4]);
        have[k] = true;
    }
    if (!(have[0] && have[1] && have[2])) return "unknown";
    struct Known {
        const char* name;
        double c[3][3];
    };
    static const Known known[] = {
        {"sRGB", {{0.4361, 0.2225, 0.0139}, {0.3851, 0.7169, 0.0971}, {0.1431, 0.0606, 0.7141}}},
        {"Display P3", {{0.5151, 0.2412, -0.0011}, {0.2920, 0.6922, 0.0419}, {0.1571, 0.0666, 0.7841}}},
        {"Adobe RGB", {{0.6097, 0.3111, 0.0195}, {0.2053, 0.6257, 0.0609}, {0.1492, 0.0632, 0.7446}}},
    };
    for (auto& k : known) {
        double d = 0;
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++) d = std::max(d, std::abs(k.c[i][j] - col[i][j]));
        if (d < 0.012) return k.name;
    }
    return "unknown";
}

void parseJpeg(const std::vector<uint8_t>& d, ImageMeta& m) {
    m.format = "jpeg";
    size_t i = 2;
    std::map<int, std::vector<uint8_t>> iccChunks;
    while (i + 4 <= d.size()) {
        if (d[i] != 0xFF) {
            i++;
            continue;
        }
        uint8_t mk = d[i + 1];
        if (mk == 0xFF) {
            i++;
            continue;
        }
        if (mk == 0xD8 || (mk >= 0xD0 && mk <= 0xD7) || mk == 0x01) {
            i += 2;
            continue;
        }
        if (mk == 0xD9) break;
        size_t len = (d[i + 2] << 8) | d[i + 3];
        if (len < 2 || i + 2 + len > d.size()) break;
        const uint8_t* seg = &d[i + 4];
        size_t sl = len - 2;
        if (mk == 0xE1 && sl > 6 && !memcmp(seg, "Exif\0\0", 6)) parseExifTiff(seg + 6, sl - 6, m);
        else if (mk == 0xE2 && sl > 14 && !memcmp(seg, "ICC_PROFILE\0", 12)) iccChunks[seg[12]] = std::vector<uint8_t>(seg + 14, seg + sl);
        else if ((mk >= 0xC0 && mk <= 0xCF) && mk != 0xC4 && mk != 0xC8 && mk != 0xCC && sl >= 5) {
            m.bitDepth = seg[0];
            m.storedH = (seg[1] << 8) | seg[2];
            m.storedW = (seg[3] << 8) | seg[4];
        }
        if (mk == 0xDA) break;  // start of scan: metadata is over
        i += 2 + len;
    }
    for (auto& kv : iccChunks) m.icc.insert(m.icc.end(), kv.second.begin(), kv.second.end());
}

void parsePng(const std::vector<uint8_t>& d, ImageMeta& m) {
    m.format = "png";
    size_t i = 8;
    bool srgbChunk = false;
    while (i + 12 <= d.size()) {
        uint32_t len = be32(&d[i]);
        const uint8_t* type = &d[i + 4];
        const uint8_t* data = &d[i + 8];
        if (i + 12 + (size_t)len > d.size()) break;
        if (!memcmp(type, "IHDR", 4) && len >= 13) {
            m.storedW = be32(data);
            m.storedH = be32(data + 4);
            m.bitDepth = data[8];
        } else if (!memcmp(type, "iCCP", 4)) {
            size_t k = 0;
            while (k < len && data[k]) k++;
            if (k + 2 < len) {
                std::vector<uint8_t> out(4 << 20);
                uLongf outLen = out.size();
                if (uncompress(out.data(), &outLen, data + k + 2, len - k - 2) == Z_OK) {
                    out.resize(outLen);
                    m.icc = out;
                }
            }
        } else if (!memcmp(type, "sRGB", 4)) {
            srgbChunk = true;
        } else if (!memcmp(type, "eXIf", 4)) {
            parseExifTiff(data, len, m);
        } else if (!memcmp(type, "IDAT", 4)) {
            break;
        }
        i += 12 + len;
    }
    (void)srgbChunk;
}
}  // namespace

json ImageMeta::toJson() const {
    return json{{"format", format},       {"storedW", storedW},     {"storedH", storedH}, {"bitDepth", bitDepth},
                {"orientation", orientation}, {"colorSpace", colorSpace}, {"hasIcc", hasIcc},   {"exif", exif},
                {"width", width()},       {"height", height()}};
}

bool fileLooksComplete(const std::string& path, const ImageMeta& meta) {
    if (meta.format != "jpeg" && meta.format != "png") return true;
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) return false;
    const std::streamoff size = f.tellg();
    // look at the tail (appended data such as motion-photo video may follow the image, so search, don't compare)
    const std::streamoff tail = std::min<std::streamoff>(size, 4 << 20);
    std::vector<uint8_t> d((size_t)tail);
    f.seekg(size - tail);
    f.read((char*)d.data(), tail);
    if (meta.format == "jpeg") {
        for (size_t i = d.size(); i >= 2; i--)
            if (d[i - 2] == 0xFF && d[i - 1] == 0xD9) return true;
        return false;
    }
    static const uint8_t iend[8] = {'I', 'E', 'N', 'D', 0xAE, 0x42, 0x60, 0x82};
    for (size_t i = d.size(); i >= 8; i--)
        if (!memcmp(&d[i - 8], iend, 8)) return true;
    return false;
}

ImageMeta readMeta(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw UserError("unreadable", "The image file could not be opened.");
    // metadata lives in the head of the file; read up to 8 MB of it
    std::vector<uint8_t> d(8 << 20);
    f.read((char*)d.data(), d.size());
    d.resize((size_t)f.gcount());
    ImageMeta m;
    if (d.size() > 3 && d[0] == 0xFF && d[1] == 0xD8) parseJpeg(d, m);
    else if (d.size() > 8 && !memcmp(d.data(), "\x89PNG\r\n\x1a\n", 8)) parsePng(d, m);
    else m.format = "other";
    if (!m.icc.empty()) {
        m.hasIcc = true;
        m.colorSpace = classifyIcc(m.icc);
    } else if (m.exif.contains("colorSpaceTag") && m.exif["colorSpaceTag"].get<int>() == 65535) {
        // "uncalibrated" without a profile: conventionally Adobe RGB for DCF cameras, but that is a guess.
        m.colorSpace = "unknown";
    } else {
        m.colorSpace = "sRGB";
    }
    return m;
}

}  // namespace dc
