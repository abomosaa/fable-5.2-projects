#include "dc/imageio.h"
#include "dc/geom.h"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <zlib.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;

namespace dc {

// ------------------------------------------------------------------------------------------------ files
bool fileExists(const std::string& path) {
    std::error_code ec;
    return fs::exists(path, ec);
}
std::string readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read " + path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}
void atomicWriteFile(const std::string& path, const std::string& data) {
    std::string tmp = path + ".tmp";
    FILE* f = fopen(tmp.c_str(), "wb");
    if (!f) throw UserError("io", "Could not write project data (storage unavailable?).");
    size_t n = fwrite(data.data(), 1, data.size(), f);
    bool ok = n == data.size() && fflush(f) == 0;
#ifndef _WIN32
    if (ok) ok = fsync(fileno(f)) == 0;
#endif
    fclose(f);
    if (!ok) {
        remove(tmp.c_str());
        throw UserError("storage_full", "Could not save: the device is out of storage space.");
    }
    if (rename(tmp.c_str(), path.c_str()) != 0) {
        remove(tmp.c_str());
        throw UserError("io", "Could not save project data.");
    }
}
uint64_t fnv1a(const void* data, size_t n, uint64_t h) {
    const uint8_t* p = (const uint8_t*)data;
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

// ------------------------------------------------------------------------------------------------ colour
namespace {
struct SpaceDef {
    const char* name;
    double toXYZ[9];  // columns = colourants (D50 adapted)
    double gamma;     // 0 => sRGB piecewise TRC
};
const SpaceDef kSpaces[] = {
    {"sRGB", {0.4361, 0.3851, 0.1431, 0.2225, 0.7169, 0.0606, 0.0139, 0.0971, 0.7141}, 0},
    {"Display P3", {0.5151, 0.2920, 0.1571, 0.2412, 0.6922, 0.0666, -0.0011, 0.0419, 0.7841}, 0},
    {"Adobe RGB", {0.6097, 0.2053, 0.1492, 0.3111, 0.6257, 0.0632, 0.0195, 0.0609, 0.7446}, 2.19921875},
};
const SpaceDef* findSpace(const std::string& n) {
    for (auto& s : kSpaces)
        if (n == s.name) return &s;
    return nullptr;
}
double decodeTrc(double v, double g) {
    if (g > 0) return std::pow(v, g);
    return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4);
}
double encodeTrc(double v, double g) {
    v = clampd(v, 0, 1);
    if (g > 0) return std::pow(v, 1.0 / g);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * std::pow(v, 1 / 2.4) - 0.055;
}
}  // namespace

bool convertColorSpace(cv::Mat& bgr, const std::string& from, const std::string& to) {
    if (from == to) return true;
    const SpaceDef* a = findSpace(from);
    const SpaceDef* b = findSpace(to);
    if (!a || !b) return false;
    cv::Matx33d A(a->toXYZ), B(b->toXYZ);
    cv::Matx33d M = B.inv() * A;  // linear RGB(from) -> linear RGB(to)
    float dec[256];
    for (int i = 0; i < 256; i++) dec[i] = (float)decodeTrc(i / 255.0, a->gamma);
    const int N = 16384;
    std::vector<uint8_t> enc(N + 1);
    for (int i = 0; i <= N; i++) enc[i] = (uint8_t)std::lround(encodeTrc(double(i) / N, b->gamma) * 255.0);
    float m[9];
    for (int i = 0; i < 9; i++) m[i] = (float)M.val[i];
    cv::parallel_for_(cv::Range(0, bgr.rows), [&](const cv::Range& r) {
        for (int y = r.start; y < r.end; y++) {
            uint8_t* p = bgr.ptr<uint8_t>(y);
            for (int x = 0; x < bgr.cols; x++, p += 3) {
                float R = dec[p[2]], G = dec[p[1]], Bl = dec[p[0]];
                float r2 = m[0] * R + m[1] * G + m[2] * Bl, g2 = m[3] * R + m[4] * G + m[5] * Bl, b2 = m[6] * R + m[7] * G + m[8] * Bl;
                auto q = [&](float v) { return enc[(int)(std::min(1.f, std::max(0.f, v)) * N + 0.5f)]; };
                p[2] = q(r2);
                p[1] = q(g2);
                p[0] = q(b2);
            }
        }
    });
    return true;
}

// ------------------------------------------------------------------------------------------------ decode
static cv::Mat reduceExact(const cv::Mat& img, int r) {
    if (r <= 1) return img;
    int pw = (img.cols + r - 1) / r * r, ph = (img.rows + r - 1) / r * r;
    cv::Mat padded;
    if (pw != img.cols || ph != img.rows) cv::copyMakeBorder(img, padded, 0, ph - img.rows, 0, pw - img.cols, cv::BORDER_REPLICATE);
    else padded = img;
    cv::Mat out;
    cv::resize(padded, out, cv::Size(pw / r, ph / r), 0, 0, cv::INTER_AREA);
    return out;
}

static cv::Mat decodeStored(const std::string& path, const ImageMeta& meta, int reduce, bool gray) {
    int flags = cv::IMREAD_IGNORE_ORIENTATION | (gray ? cv::IMREAD_GRAYSCALE : cv::IMREAD_COLOR);
    cv::Mat img;
    if (meta.format == "jpeg" && reduce > 1) {
        int rf = gray ? (reduce == 2 ? cv::IMREAD_REDUCED_GRAYSCALE_2 : reduce == 4 ? cv::IMREAD_REDUCED_GRAYSCALE_4 : cv::IMREAD_REDUCED_GRAYSCALE_8)
                      : (reduce == 2 ? cv::IMREAD_REDUCED_COLOR_2 : reduce == 4 ? cv::IMREAD_REDUCED_COLOR_4 : cv::IMREAD_REDUCED_COLOR_8);
        img = cv::imread(path, cv::IMREAD_IGNORE_ORIENTATION | rf);
        // libjpeg DCT scaling yields ceil(W/reduce); fall back to exact reduction if the decoder disagreed
        if (!img.empty() && (img.cols != (meta.storedW + reduce - 1) / reduce || img.rows != (meta.storedH + reduce - 1) / reduce)) img.release();
        if (!img.empty()) return img;
    }
    img = cv::imread(path, flags);
    if (img.empty()) throw UserError("unreadable", "This image could not be decoded. Supported: JPEG, PNG, WebP, TIFF, BMP.");
    return reduceExact(img, reduce);
}

cv::Mat loadOriented(const std::string& path, const ImageMeta& meta, int reduce, const std::string& workingSpace) {
    cv::Mat stored = decodeStored(path, meta, reduce, false), out;
    applyOrientation(stored, out, meta.orientation);
    if (!workingSpace.empty() && workingSpace != meta.colorSpace) convertColorSpace(out, meta.colorSpace, workingSpace);
    return out;
}
cv::Mat loadOrientedGray(const std::string& path, const ImageMeta& meta, int reduce) {
    cv::Mat stored = decodeStored(path, meta, reduce, true), out;
    applyOrientation(stored, out, meta.orientation);
    return out;
}

// ------------------------------------------------------------------------------------------------ PNG
namespace {
void put32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back(x >> 24);
    v.push_back(x >> 16);
    v.push_back(x >> 8);
    v.push_back(x);
}
struct FileOut {
    FILE* f = nullptr;
    std::string path;
    uint64_t pos = 0;
    explicit FileOut(const std::string& p) : path(p) {
        f = fopen(p.c_str(), "wb");
        if (!f) throw UserError("io", "Could not create the export file.");
    }
    ~FileOut() {
        if (f) fclose(f);
    }
    void write(const void* d, size_t n) {
        if (n && fwrite(d, 1, n, f) != n) throw UserError("storage_full", "Export failed: not enough free storage.");
        pos += n;
    }
    void seek(uint64_t p) {
        fflush(f);
        fseeko(f, (off_t)p, SEEK_SET);
    }
    void close() {
        if (f) {
            bool ok = fflush(f) == 0;
            fclose(f);
            f = nullptr;
            if (!ok) throw UserError("storage_full", "Export failed: not enough free storage.");
        }
    }
};

class PngWriter : public RowWriter {
    FileOut out;
    int w, h, rowsDone = 0;
    z_stream zs{};
    std::vector<uint8_t> prev, cur, filt[5], zbuf;
    void chunk(const char* type, const uint8_t* data, size_t len) {
        std::vector<uint8_t> hdr;
        put32(hdr, (uint32_t)len);
        hdr.insert(hdr.end(), type, type + 4);
        out.write(hdr.data(), 8);
        out.write(data, len);
        uint32_t crc = crc32(0, (const Bytef*)type, 4);
        if (len) crc = crc32(crc, data, (uInt)len);
        std::vector<uint8_t> c;
        put32(c, crc);
        out.write(c.data(), 4);
    }
    void pump(int flush) {
        do {
            zs.next_out = zbuf.data();
            zs.avail_out = (uInt)zbuf.size();
            deflate(&zs, flush);
            size_t n = zbuf.size() - zs.avail_out;
            if (n) chunk("IDAT", zbuf.data(), n);
        } while (zs.avail_out == 0);
    }

   public:
    PngWriter(const std::string& path, int w_, int h_, const std::vector<uint8_t>& icc, int zlevel) : out(path), w(w_), h(h_) {
        static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
        out.write(sig, 8);
        std::vector<uint8_t> ihdr;
        put32(ihdr, w);
        put32(ihdr, h);
        ihdr.insert(ihdr.end(), {8, 2, 0, 0, 0});
        chunk("IHDR", ihdr.data(), ihdr.size());
        if (!icc.empty()) {
            std::vector<uint8_t> c = {'I', 'C', 'C', 0, 0};
            uLongf bound = compressBound((uLong)icc.size());
            std::vector<uint8_t> z(bound);
            compress2(z.data(), &bound, icc.data(), (uLong)icc.size(), 9);
            c.insert(c.end(), z.begin(), z.begin() + bound);
            chunk("iCCP", c.data(), c.size());
        } else {
            uint8_t intent = 0;
            chunk("sRGB", &intent, 1);
        }
        deflateInit(&zs, zlevel);
        prev.assign((size_t)w * 3, 0);
        cur.resize((size_t)w * 3);
        for (auto& f : filt) f.resize((size_t)w * 3 + 1);
        zbuf.resize(1 << 18);
    }
    ~PngWriter() override { deflateEnd(&zs); }
    void writeRows(const cv::Mat& rows) override {
        CV_Assert(rows.type() == CV_8UC3 && rows.cols == w);
        const size_t n = (size_t)w * 3;
        for (int y = 0; y < rows.rows; y++) {
            const uint8_t* s = rows.ptr<uint8_t>(y);
            for (int x = 0; x < w; x++) {
                cur[x * 3] = s[x * 3 + 2];
                cur[x * 3 + 1] = s[x * 3 + 1];
                cur[x * 3 + 2] = s[x * 3];
            }
            // adaptive filter selection: minimum sum of absolute differences
            long best = -1;
            int bi = 0;
            for (int t = 0; t < 5; t++) {
                uint8_t* o = filt[t].data();
                o[0] = (uint8_t)t;
                long sum = 0;
                for (size_t i = 0; i < n; i++) {
                    int a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0, v = cur[i], pr;
                    switch (t) {
                        case 0: pr = 0; break;
                        case 1: pr = a; break;
                        case 2: pr = b; break;
                        case 3: pr = (a + b) >> 1; break;
                        default: {
                            int p = a + b - c, pa = std::abs(p - a), pb = std::abs(p - b), pc = std::abs(p - c);
                            pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                        }
                    }
                    uint8_t d = (uint8_t)(v - pr);
                    o[i + 1] = d;
                    sum += d < 128 ? d : 256 - d;
                }
                if (best < 0 || sum < best) {
                    best = sum;
                    bi = t;
                }
            }
            zs.next_in = filt[bi].data();
            zs.avail_in = (uInt)(n + 1);
            while (zs.avail_in) pump(Z_NO_FLUSH);
            prev.swap(cur);
            rowsDone++;
        }
    }
    void finish() override {
        if (rowsDone != h) throw std::runtime_error("png: wrong row count");
        zs.avail_in = 0;
        pump(Z_FINISH);
        chunk("IEND", nullptr, 0);
        out.close();
    }
};

// ------------------------------------------------------------------------------------------------ TIFF
class TiffWriter : public RowWriter {
    FileOut out;
    int w, h, rowsDone = 0, rps;
    bool big;
    std::vector<uint8_t> icc, strip;
    std::vector<uint64_t> offs, counts;
    int stripRows = 0;
    void le(std::vector<uint8_t>& v, uint64_t x, int n) {
        for (int i = 0; i < n; i++) v.push_back((uint8_t)(x >> (8 * i)));
    }
    void flushStrip() {
        if (!stripRows) return;
        uLongf bound = compressBound((uLong)strip.size());
        std::vector<uint8_t> z(bound);
        compress2(z.data(), &bound, strip.data(), (uLong)strip.size(), 6);
        if (!big && out.pos + bound > 0xFFF00000ULL) throw UserError("too_large", "The image is too large for a classic TIFF file.");
        offs.push_back(out.pos);
        counts.push_back(bound);
        out.write(z.data(), bound);
        strip.clear();
        stripRows = 0;
    }

   public:
    TiffWriter(const std::string& path, int w_, int h_, const std::vector<uint8_t>& icc_, bool forceBig) : out(path), w(w_), h(h_), icc(icc_) {
        big = forceBig || (double)w * h * 3 > 3.2e9;
        rps = std::max(1, std::min(h, (1 << 20) / std::max(1, w * 3) + 1));
        std::vector<uint8_t> hd;
        if (big) {
            hd = {'I', 'I', 43, 0, 8, 0, 0, 0};
            le(hd, 0, 8);
        } else {
            hd = {'I', 'I', 42, 0};
            le(hd, 0, 4);
        }
        out.write(hd.data(), hd.size());
    }
    void writeRows(const cv::Mat& rows) override {
        CV_Assert(rows.type() == CV_8UC3 && rows.cols == w);
        for (int y = 0; y < rows.rows; y++) {
            const uint8_t* s = rows.ptr<uint8_t>(y);
            size_t base = strip.size();
            strip.resize(base + (size_t)w * 3);
            uint8_t* d = &strip[base];
            for (int x = 0; x < w; x++) {
                d[x * 3] = s[x * 3 + 2];
                d[x * 3 + 1] = s[x * 3 + 1];
                d[x * 3 + 2] = s[x * 3];
            }
            for (size_t i = (size_t)w * 3 - 1; i >= 3; i--) d[i] = (uint8_t)(d[i] - d[i - 3]);  // predictor 2
            rowsDone++;
            if (++stripRows == rps) flushStrip();
        }
    }
    void finish() override {
        if (rowsDone != h) throw std::runtime_error("tiff: wrong row count");
        flushStrip();
        const int osz = big ? 8 : 4;
        auto align = [&] {
            if (out.pos & 1) {
                uint8_t z = 0;
                out.write(&z, 1);
            }
        };
        align();
        uint64_t bpsOff = out.pos;
        {
            std::vector<uint8_t> v;
            le(v, 8, 2);
            le(v, 8, 2);
            le(v, 8, 2);
            out.write(v.data(), v.size());
        }
        align();
        uint64_t offOff = out.pos;
        {
            std::vector<uint8_t> v;
            for (auto o : offs) le(v, o, osz);
            out.write(v.data(), v.size());
        }
        align();
        uint64_t cntOff = out.pos;
        {
            std::vector<uint8_t> v;
            for (auto c : counts) le(v, c, osz);
            out.write(v.data(), v.size());
        }
        align();
        uint64_t iccOff = out.pos;
        if (!icc.empty()) out.write(icc.data(), icc.size());
        align();
        uint64_t ifdOff = out.pos;
        struct E {
            uint16_t tag, type;
            uint64_t count, value;
        };
        const uint16_t LONGT = big ? 16 : 4;
        size_t ns = offs.size();
        std::vector<E> es = {
            {256, 4, 1, (uint64_t)w},
            {257, 4, 1, (uint64_t)h},
            {258, 3, 3, big ? (8ULL | (8ULL << 16) | (8ULL << 32)) : bpsOff},
            {259, 3, 1, 8},
            {262, 3, 1, 2},
            {273, LONGT, ns, ns == 1 ? offs[0] : offOff},
            {277, 3, 1, 3},
            {278, 4, 1, (uint64_t)rps},
            {279, LONGT, ns, ns == 1 ? counts[0] : cntOff},
            {284, 3, 1, 1},
            {317, 3, 1, 2},
        };
        if (!icc.empty()) es.push_back({34675, 7, icc.size(), iccOff});
        std::vector<uint8_t> v;
        le(v, es.size(), big ? 8 : 2);
        for (auto& e : es) {
            le(v, e.tag, 2);
            le(v, e.type, 2);
            le(v, e.count, big ? 8 : 4);
            le(v, e.value, big ? 8 : 4);
        }
        le(v, 0, big ? 8 : 4);
        out.write(v.data(), v.size());
        out.seek(big ? 8 : 4);
        std::vector<uint8_t> o;
        le(o, ifdOff, big ? 8 : 4);
        fwrite(o.data(), 1, o.size(), out.f);
        out.close();
    }
};

// ------------------------------------------------------------------------------------------------ JPEG
// Baseline sequential JPEG, YCbCr 4:4:4, standard Annex-K Huffman tables, IJG quality scaling. Streaming.
const uint8_t kZig[64] = {0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,  12, 19, 26, 33, 40, 48,
                          41, 34, 27, 20, 13, 6,  7,  14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23,
                          30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63};
const uint8_t kQL[64] = {16, 11, 10, 16, 24,  40,  51,  61,  12, 12, 14, 19, 26,  58,  60,  55,  14, 13, 16, 24, 40,  57,
                         69, 56, 14, 17, 22,  29,  51,  87,  80, 62, 18, 22, 37,  56,  68,  109, 103, 77, 24, 35, 55,  64,
                         81, 104, 113, 92, 49, 64,  78,  87,  103, 121, 120, 101, 72, 92,  95,  98,  112, 100, 103, 99};
const uint8_t kQC[64] = {17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99,
                         99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
                         99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};
const uint8_t kDcLBits[16] = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
const uint8_t kDcCBits[16] = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
const uint8_t kDcVals[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
const uint8_t kAcLBits[16] = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
const uint8_t kAcLVals[162] = {
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
    0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
    0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
    0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
    0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
    0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
    0xfa};
const uint8_t kAcCBits[16] = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
const uint8_t kAcCVals[162] = {
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42,
    0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19,
    0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83,
    0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
    0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
    0xfa};

struct HuffTab {
    uint16_t code[256];
    uint8_t len[256];
    void build(const uint8_t* bits, const uint8_t* vals) {
        memset(len, 0, sizeof(len));
        int code_ = 0, k = 0;
        for (int l = 1; l <= 16; l++) {
            for (int i = 0; i < bits[l - 1]; i++) {
                code[vals[k]] = (uint16_t)code_++;
                len[vals[k]] = (uint8_t)l;
                k++;
            }
            code_ <<= 1;
        }
    }
};

class JpegWriter : public RowWriter {
    FileOut out;
    int w, h, rowsDone = 0;
    uint8_t ql[64], qc[64];
    float fq[2][64];
    HuffTab dcL, dcC, acL, acC;
    std::vector<uint8_t> buf;
    uint32_t bitBuf = 0;
    int bitCnt = 0;
    int lastDc[3] = {0, 0, 0};
    cv::Mat pending;  // up to 8 rows (BGR)
    int pendingRows = 0;
    float cosT[8][8];

    void emit(const void* d, size_t n) { out.write(d, n); }
    void marker(uint8_t m, const std::vector<uint8_t>& payload) {
        uint8_t h4[4] = {0xFF, m, (uint8_t)((payload.size() + 2) >> 8), (uint8_t)((payload.size() + 2) & 0xFF)};
        emit(h4, 4);
        emit(payload.data(), payload.size());
    }
    inline void putBits(uint32_t code, int n) {
        bitBuf = (bitBuf << n) | (code & ((1u << n) - 1));
        bitCnt += n;
        while (bitCnt >= 8) {
            uint8_t b = (uint8_t)(bitBuf >> (bitCnt - 8));
            buf.push_back(b);
            if (b == 0xFF) buf.push_back(0);
            bitCnt -= 8;
        }
    }
    void block(const float* px, int comp) {
        // separable DCT-II (orthonormal, identical to the JPEG FDCT scaling)
        float tmp[64], co[64];
        for (int y = 0; y < 8; y++)
            for (int u = 0; u < 8; u++) {
                float s = 0;
                for (int x = 0; x < 8; x++) s += px[y * 8 + x] * cosT[u][x];
                tmp[y * 8 + u] = s;
            }
        for (int u = 0; u < 8; u++)
            for (int v = 0; v < 8; v++) {
                float s = 0;
                for (int y = 0; y < 8; y++) s += tmp[y * 8 + u] * cosT[v][y];
                co[v * 8 + u] = s;
            }
        const float* q = fq[comp ? 1 : 0];
        int z[64];
        for (int i = 0; i < 64; i++) z[i] = (int)std::lround(co[kZig[i]] * q[kZig[i]]);
        const HuffTab& dc = comp ? dcC : dcL;
        const HuffTab& ac = comp ? acC : acL;
        int diff = z[0] - lastDc[comp];
        lastDc[comp] = z[0];
        auto cat = [](int v) {
            int a = v < 0 ? -v : v, n = 0;
            while (a) {
                n++;
                a >>= 1;
            }
            return n;
        };
        int n = cat(diff);
        putBits(dc.code[n], dc.len[n]);
        if (n) putBits((uint32_t)(diff < 0 ? diff - 1 : diff), n);
        int run = 0;
        for (int i = 1; i < 64; i++) {
            if (z[i] == 0) {
                run++;
                continue;
            }
            while (run > 15) {
                putBits(ac.code[0xF0], ac.len[0xF0]);
                run -= 16;
            }
            int s = cat(z[i]), sym = (run << 4) | s;
            putBits(ac.code[sym], ac.len[sym]);
            putBits((uint32_t)(z[i] < 0 ? z[i] - 1 : z[i]), s);
            run = 0;
        }
        if (run) putBits(ac.code[0], ac.len[0]);
    }
    void encodeMcuRow(const cv::Mat& rows8) {  // exactly 8 rows
        float Y[64], Cb[64], Cr[64];
        for (int bx = 0; bx < w; bx += 8) {
            for (int y = 0; y < 8; y++) {
                const uint8_t* s = rows8.ptr<uint8_t>(y);
                for (int x = 0; x < 8; x++) {
                    int xx = std::min(w - 1, bx + x);
                    float b = s[xx * 3], g = s[xx * 3 + 1], r = s[xx * 3 + 2];
                    Y[y * 8 + x] = 0.299f * r + 0.587f * g + 0.114f * b - 128.f;
                    Cb[y * 8 + x] = -0.168736f * r - 0.331264f * g + 0.5f * b;
                    Cr[y * 8 + x] = 0.5f * r - 0.418688f * g - 0.081312f * b;
                }
            }
            block(Y, 0);
            block(Cb, 1);
            block(Cr, 2);
        }
        if (buf.size() > (1 << 16)) {
            emit(buf.data(), buf.size());
            buf.clear();
        }
    }

   public:
    JpegWriter(const std::string& path, int w_, int h_, int quality, const std::vector<uint8_t>& icc) : out(path), w(w_), h(h_) {
        if (w > 65535 || h > 65535) throw UserError("too_large", "JPEG cannot store images larger than 65535 pixels per side.");
        quality = std::max(1, std::min(100, quality));
        int s = quality < 50 ? 5000 / quality : 200 - quality * 2;
        for (int i = 0; i < 64; i++) {
            ql[i] = (uint8_t)std::max(1, std::min(255, (kQL[i] * s + 50) / 100));
            qc[i] = (uint8_t)std::max(1, std::min(255, (kQC[i] * s + 50) / 100));
            fq[0][i] = 1.f / ql[i];
            fq[1][i] = 1.f / qc[i];
        }
        for (int u = 0; u < 8; u++)
            for (int x = 0; x < 8; x++) cosT[u][x] = (float)((u == 0 ? std::sqrt(1.0 / 8) : std::sqrt(2.0 / 8)) * std::cos((2 * x + 1) * u * CV_PI / 16));
        dcL.build(kDcLBits, kDcVals);
        dcC.build(kDcCBits, kDcVals);
        acL.build(kAcLBits, kAcLVals);
        acC.build(kAcCBits, kAcCVals);
        const uint8_t soi[2] = {0xFF, 0xD8};
        emit(soi, 2);
        marker(0xE0, {'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0});
        if (!icc.empty()) {
            const size_t maxChunk = 65519;
            int total = (int)((icc.size() + maxChunk - 1) / maxChunk);
            for (int i = 0; i < total; i++) {
                std::vector<uint8_t> p = {'I', 'C', 'C', '_', 'P', 'R', 'O', 'F', 'I', 'L', 'E', 0, (uint8_t)(i + 1), (uint8_t)total};
                size_t a = i * maxChunk, b = std::min(icc.size(), a + maxChunk);
                p.insert(p.end(), icc.begin() + a, icc.begin() + b);
                marker(0xE2, p);
            }
        }
        for (int t = 0; t < 2; t++) {
            std::vector<uint8_t> p = {(uint8_t)t};
            for (int i = 0; i < 64; i++) p.push_back((t ? qc : ql)[kZig[i]]);
            marker(0xDB, p);
        }
        marker(0xC0, {8, (uint8_t)(h >> 8), (uint8_t)(h & 255), (uint8_t)(w >> 8), (uint8_t)(w & 255), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1});
        auto dht = [&](uint8_t id, const uint8_t* bits, const uint8_t* vals, int nv) {
            std::vector<uint8_t> p = {id};
            p.insert(p.end(), bits, bits + 16);
            p.insert(p.end(), vals, vals + nv);
            marker(0xC4, p);
        };
        dht(0x00, kDcLBits, kDcVals, 12);
        dht(0x10, kAcLBits, kAcLVals, 162);
        dht(0x01, kDcCBits, kDcVals, 12);
        dht(0x11, kAcCBits, kAcCVals, 162);
        marker(0xDA, {3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0});
        pending = cv::Mat(8, w, CV_8UC3);
    }
    void writeRows(const cv::Mat& rows) override {
        CV_Assert(rows.type() == CV_8UC3 && rows.cols == w);
        for (int y = 0; y < rows.rows; y++) {
            rows.row(y).copyTo(pending.row(pendingRows++));
            rowsDone++;
            if (pendingRows == 8) {
                encodeMcuRow(pending);
                pendingRows = 0;
            }
        }
    }
    void finish() override {
        if (rowsDone != h) throw std::runtime_error("jpeg: wrong row count");
        if (pendingRows) {
            for (int y = pendingRows; y < 8; y++) pending.row(pendingRows - 1).copyTo(pending.row(y));
            encodeMcuRow(pending);
        }
        if (bitCnt) putBits(0x7F, 8 - bitCnt);
        emit(buf.data(), buf.size());
        const uint8_t eoi[2] = {0xFF, 0xD9};
        emit(eoi, 2);
        out.close();
    }
};
}  // namespace

std::unique_ptr<RowWriter> makePngWriter(const std::string& path, int w, int h, const std::vector<uint8_t>& icc, int zlevel) {
    return std::make_unique<PngWriter>(path, w, h, icc, zlevel);
}
std::unique_ptr<RowWriter> makeTiffWriter(const std::string& path, int w, int h, const std::vector<uint8_t>& icc, bool forceBig) {
    return std::make_unique<TiffWriter>(path, w, h, icc, forceBig);
}
std::unique_ptr<RowWriter> makeJpegWriter(const std::string& path, int w, int h, int quality, const std::vector<uint8_t>& icc) {
    return std::make_unique<JpegWriter>(path, w, h, quality, icc);
}

}  // namespace dc
