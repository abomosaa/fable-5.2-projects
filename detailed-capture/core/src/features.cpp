#include "dc/features.h"
#include <opencv2/calib3d.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <cstdio>
#include <map>
#include <numeric>
#include <unordered_map>

namespace dc {

// =============================================================================================== quality
double sharpFactor(double sigma) {
    if (sigma <= 0) return 1.0;
    return std::min(1.0, kSigmaRef / sigma);
}

double detailGain(double s, double sigmaC, double sigmaO) {
    double c = std::max(sigmaC > 0 ? sigmaC : kSigmaRef, kSigmaRef), o = std::max(sigmaO > 0 ? sigmaO : kSigmaRef, kSigmaRef);
    return s * std::min(1.0, o / c);
}

json FrameQuality::toJson() const {
    json m = json::array();
    for (float v : sigmaMap) m.push_back(std::round(v * 100) / 100.0);
    return json{{"gw", gw},           {"gh", gh},       {"sigmaMap", m},   {"sharpSigma", sharpSigma}, {"bestSigma", bestSigma},
                {"texturedFrac", texturedFrac}, {"clipHi", clipHi}, {"clipLo", clipLo}, {"meanLuma", meanLuma},   {"glareFrac", glareFrac},
                {"noise", noise}};
}
FrameQuality FrameQuality::fromJson(const json& j) {
    FrameQuality q;
    q.gw = j.value("gw", 0);
    q.gh = j.value("gh", 0);
    if (j.contains("sigmaMap"))
        for (auto& v : j["sigmaMap"]) q.sigmaMap.push_back(v.get<float>());
    q.sharpSigma = j.value("sharpSigma", -1.0);
    q.bestSigma = j.value("bestSigma", -1.0);
    q.texturedFrac = j.value("texturedFrac", 0.0);
    q.clipHi = j.value("clipHi", 0.0);
    q.clipLo = j.value("clipLo", 0.0);
    q.meanLuma = j.value("meanLuma", 0.0);
    q.glareFrac = j.value("glareFrac", 0.0);
    q.noise = j.value("noise", 0.0);
    return q;
}
double FrameQuality::sigmaAt(double x, double y, int w, int h) const {
    // bilinear interpolation between cell centres (cells without measurable texture use the frame median)
    double fallback = sharpSigma > 0 ? sharpSigma : kSigmaRef;
    if (gw <= 0 || gh <= 0 || (int)sigmaMap.size() != gw * gh) return fallback;
    double gx = clampd(x / w * gw - 0.5, 0.0, gw - 1.0), gy = clampd(y / h * gh - 0.5, 0.0, gh - 1.0);
    int x0 = (int)gx, y0 = (int)gy, x1 = std::min(gw - 1, x0 + 1), y1 = std::min(gh - 1, y0 + 1);
    double fx = gx - x0, fy = gy - y0;
    auto v = [&](int cx, int cy) {
        float s = sigmaMap[cy * gw + cx];
        return s > 0 ? (double)s : fallback;
    };
    return (v(x0, y0) * (1 - fx) + v(x1, y0) * fx) * (1 - fy) + (v(x0, y1) * (1 - fx) + v(x1, y1) * fx) * fy;
}

// Blur sigma per cell of one pyramid level (in that level's pixels); <0 where not measurable.
static std::vector<float> sigmaCells(const cv::Mat& gray, int gw, int gh, double noise) {
    const int W = gray.cols, H = gray.rows;
    const double sp = 0.7, s1 = 1.5;
    // gradient magnitude that noise alone produces at the 99.5th percentile (calibrated for sp / s1)
    const double ng0 = 0.72 * noise, ng1 = 0.21 * noise;
    std::vector<float> out(gw * gh, -1.f);
    for (int cy = 0; cy < gh; cy++)
        for (int cx = 0; cx < gw; cx++) {
            int x0 = cx * W / gw, x1 = (cx + 1) * W / gw, y0 = cy * H / gh, y1 = (cy + 1) * H / gh;
            const int mg = 8;
            cv::Rect ext(std::max(0, x0 - mg), std::max(0, y0 - mg), 0, 0);
            ext.width = std::min(W, x1 + mg) - ext.x;
            ext.height = std::min(H, y1 + mg) - ext.y;
            if (x1 - x0 < 12 || y1 - y0 < 12) continue;
            cv::Mat c, a, b, gxa, gya, gxb, gyb, ma, mb;
            gray(ext).convertTo(c, CV_32F);
            cv::GaussianBlur(c, a, cv::Size(0, 0), sp);
            cv::GaussianBlur(a, b, cv::Size(0, 0), s1);
            cv::Sobel(a, gxa, CV_32F, 1, 0, 3, 1.0 / 8);
            cv::Sobel(a, gya, CV_32F, 0, 1, 3, 1.0 / 8);
            cv::Sobel(b, gxb, CV_32F, 1, 0, 3, 1.0 / 8);
            cv::Sobel(b, gyb, CV_32F, 0, 1, 3, 1.0 / 8);
            cv::magnitude(gxa, gya, ma);
            cv::magnitude(gxb, gyb, mb);
            cv::Rect inner(x0 - ext.x, y0 - ext.y, x1 - x0, y1 - y0);
            cv::Mat va = ma(inner).clone().reshape(1, 1), vb = mb(inner).clone().reshape(1, 1);
            int n = va.cols, k = std::max(0, (int)(n * 0.995) - 1);
            float* pa = va.ptr<float>();
            float* pb = vb.ptr<float>();
            std::nth_element(pa, pa + k, pa + n);
            std::nth_element(pb, pb + k, pb + n);
            // remove the noise contribution in quadrature; require real structure well above the noise
            double g0 = std::sqrt(std::max(0.0, double(pa[k]) * pa[k] - ng0 * ng0)), g1 = std::sqrt(std::max(0.0, double(pb[k]) * pb[k] - ng1 * ng1));
            if (g0 < std::max(2.0, 2.5 * ng0)) continue;
            double r = clampd(g1 / g0, 0.05, 0.995);
            double se = s1 * r / std::sqrt(1 - r * r);
            out[cy * gw + cx] = (float)std::sqrt(std::max(0.04, se * se - sp * sp));
        }
    return out;
}

FrameQuality analyzeQuality(const cv::Mat& bgr) {
    FrameQuality q;
    cv::Mat gray;
    cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
    const int W = gray.cols, H = gray.rows;
    q.gw = 16;
    q.gh = std::max(4, std::min(32, (int)std::lround(16.0 * H / W)));
    // sensor-noise level from the flattest cells (Immerkaer estimate; texture only ever inflates it)
    static const cv::Mat kern = (cv::Mat_<float>(3, 3) << 1, -2, 1, -2, 4, -2, 1, -2, 1);
    std::vector<double> cellNoise;
    for (int cy = 0; cy < q.gh; cy++)
        for (int cx = 0; cx < q.gw; cx++) {
            cv::Rect r(cx * W / q.gw, cy * H / q.gh, (cx + 1) * W / q.gw - cx * W / q.gw, (cy + 1) * H / q.gh - cy * H / q.gh);
            if (r.width < 24 || r.height < 24) continue;
            cv::Mat c, lap;
            gray(r).convertTo(c, CV_32F);
            cv::filter2D(c, lap, CV_32F, kern);
            cellNoise.push_back(std::sqrt(CV_PI / 2) / 6.0 * cv::mean(cv::abs(lap))[0]);
        }
    std::sort(cellNoise.begin(), cellNoise.end());
    q.noise = cellNoise.empty() ? 0 : cellNoise[cellNoise.size() / 10];
    // The edge model only measures blur up to a few pixels. Strong blur is measured on 2x / 4x reduced copies
    // (where it becomes a small blur again) and reported in native pixels.
    q.sigmaMap = sigmaCells(gray, q.gw, q.gh, q.noise);
    {
        cv::Mat g2, g4;
        cv::resize(gray, g2, cv::Size(std::max(1, W / 2), std::max(1, H / 2)), 0, 0, cv::INTER_AREA);
        cv::resize(g2, g4, cv::Size(std::max(1, W / 4), std::max(1, H / 4)), 0, 0, cv::INTER_AREA);
        std::vector<float> s2 = sigmaCells(g2, q.gw, q.gh, q.noise / 2), s4 = sigmaCells(g4, q.gw, q.gh, q.noise / 4);
        for (size_t i = 0; i < q.sigmaMap.size(); i++) {
            float v = q.sigmaMap[i];
            if (s2[i] > 0.95f) v = std::max(v, 2 * s2[i]);
            if (s4[i] > 0.95f) v = std::max(v, 4 * s4[i]);
            q.sigmaMap[i] = v;
        }
    }
    std::vector<float> ok;
    for (float v : q.sigmaMap)
        if (v > 0) ok.push_back(v);
    q.texturedFrac = double(ok.size()) / (q.gw * q.gh);
    if (!ok.empty()) {
        std::sort(ok.begin(), ok.end());
        q.sharpSigma = ok[ok.size() / 2];
        q.bestSigma = ok[ok.size() / 10];
    }
    // exposure statistics on a reduced copy
    cv::Mat small;
    double f = std::min(1.0, 1024.0 / std::max(W, H));
    cv::resize(bgr, small, cv::Size(), f, f, cv::INTER_AREA);
    cv::Mat ch[3], mx, mn;
    cv::split(small, ch);
    cv::max(ch[0], ch[1], mx);
    cv::max(mx, ch[2], mx);
    cv::Mat hi = mx >= 250, lo = mx <= 5;
    double total = (double)small.total();
    q.clipHi = cv::countNonZero(hi) / total;
    q.clipLo = cv::countNonZero(lo) / total;
    cv::Mat g2;
    cv::cvtColor(small, g2, cv::COLOR_BGR2GRAY);
    q.meanLuma = cv::mean(g2)[0] / 255.0;
    // glare: largest connected blown-out blob
    cv::Mat labels, stats, cent;
    int nl = cv::connectedComponentsWithStats(hi, labels, stats, cent, 8, CV_32S);
    int best = 0;
    for (int i = 1; i < nl; i++) best = std::max(best, stats.at<int>(i, cv::CC_STAT_AREA));
    q.glareFrac = best / total;
    return q;
}

// =============================================================================================== features
void Features::save(const std::string& path) const {
    FILE* f = fopen((path + ".tmp").c_str(), "wb");
    if (!f) return;
    uint32_t magic = 0x44434631, n = (uint32_t)pts.size();
    fwrite(&magic, 4, 1, f);
    fwrite(&imgW, 4, 1, f);
    fwrite(&imgH, 4, 1, f);
    fwrite(&workScale, 8, 1, f);
    fwrite(&n, 4, 1, f);
    if (n) {
        fwrite(pts.data(), sizeof(cv::Point2f), n, f);
        fwrite(size.data(), 4, n, f);
        fwrite(angle.data(), 4, n, f);
        fwrite(desc.data, 4, (size_t)n * 128, f);
    }
    fclose(f);
    rename((path + ".tmp").c_str(), path.c_str());
}
bool Features::load(const std::string& path, Features& F) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return false;
    uint32_t magic = 0, n = 0;
    bool ok = fread(&magic, 4, 1, f) == 1 && magic == 0x44434631 && fread(&F.imgW, 4, 1, f) == 1 && fread(&F.imgH, 4, 1, f) == 1 &&
              fread(&F.workScale, 8, 1, f) == 1 && fread(&n, 4, 1, f) == 1 && n < 10000000;
    if (ok) {
        F.pts.resize(n);
        F.size.resize(n);
        F.angle.resize(n);
        F.desc = cv::Mat((int)n, 128, CV_32F);
        if (n)
            ok = fread(F.pts.data(), sizeof(cv::Point2f), n, f) == n && fread(F.size.data(), 4, n, f) == n && fread(F.angle.data(), 4, n, f) == n &&
                 fread(F.desc.data, 4, (size_t)n * 128, f) == (size_t)n * 128;
    }
    fclose(f);
    return ok;
}

Features extractFeatures(const cv::Mat& gray, int maxWorkDim, int maxFeatures, const Ctx* ctx) {
    CV_Assert(gray.type() == CV_8UC1);
    Features F;
    F.imgW = gray.cols;
    F.imgH = gray.rows;
    double ws = std::min(1.0, double(maxWorkDim) / std::max(gray.cols, gray.rows));
    cv::Mat work;
    if (ws < 1) cv::resize(gray, work, cv::Size(std::max(1, (int)std::lround(gray.cols * ws)), std::max(1, (int)std::lround(gray.rows * ws))), 0, 0, cv::INTER_AREA);
    else work = gray;
    F.workScale = double(work.cols) / gray.cols;

    auto sift = cv::SIFT::create(0, 3, 0.03, 10, 1.6);
    struct Raw {
        cv::Point2f pt;
        float size, angle, response;
        int row;
    };
    std::vector<Raw> raws;
    std::vector<cv::Mat> descs;
    const int T = 640, MG = 64;
    // Level k keeps keypoints with size in [lo, hi) level pixels; coarser structure is taken from the next level.
    int nLevels = 1;
    while ((std::max(work.cols, work.rows) >> (nLevels - 1)) > 800) nLevels++;
    cv::Mat level = work;
    for (int k = 0; k < nLevels; k++) {
        if (k > 0) {
            cv::Mat next;
            cv::resize(level, next, cv::Size((level.cols + 1) / 2, (level.rows + 1) / 2), 0, 0, cv::INTER_AREA);
            level = next;
        }
        const bool last = (k == nLevels - 1);
        const double lo = k > 0 ? 4.0 : 0.0, hi = last ? 1e9 : 8.0;
        const double fx = double(gray.cols) / level.cols, fy = double(gray.rows) / level.rows;
        const bool whole = std::max(level.cols, level.rows) <= 800;
        int tx = whole ? 1 : (level.cols + T - 1) / T, ty = whole ? 1 : (level.rows + T - 1) / T;
        for (int j = 0; j < ty; j++)
            for (int i = 0; i < tx; i++) {
                if (ctx) ctx->check();
                cv::Rect core = whole ? cv::Rect(0, 0, level.cols, level.rows)
                                      : cv::Rect(i * T, j * T, std::min(T, level.cols - i * T), std::min(T, level.rows - j * T));
                cv::Rect ext = whole ? core : (cv::Rect(core.x - MG, core.y - MG, core.width + 2 * MG, core.height + 2 * MG) & cv::Rect(0, 0, level.cols, level.rows));
                std::vector<cv::KeyPoint> kps;
                cv::Mat d;
                sift->detectAndCompute(level(ext), cv::noArray(), kps, d);
                cv::Mat keep(0, 128, CV_32F);
                keep.reserve(kps.size());
                for (size_t n = 0; n < kps.size(); n++) {
                    const auto& kp = kps[n];
                    double px = kp.pt.x + ext.x, py = kp.pt.y + ext.y;  // index coords in the level
                    if (px + 0.5 < core.x || px + 0.5 >= core.x + core.width || py + 0.5 < core.y || py + 0.5 >= core.y + core.height) continue;
                    if (kp.size < lo || kp.size >= hi) continue;
                    Raw r;
                    r.pt = cv::Point2f((float)((px + 0.5) * fx), (float)((py + 0.5) * fy));
                    r.size = (float)(kp.size * 0.5 * (fx + fy));
                    r.angle = kp.angle;
                    r.response = kp.response;
                    r.row = keep.rows;
                    r.row |= (int)descs.size() << 20;  // (tile index, row) packed below
                    raws.push_back(r);
                    keep.push_back(d.row((int)n));
                }
                descs.push_back(keep);
                if (keep.rows >= (1 << 20)) throw std::runtime_error("too many features in a tile");
            }
    }
    // spatially balanced selection
    std::vector<int> order(raws.size());
    std::iota(order.begin(), order.end(), 0);
    if ((int)raws.size() > maxFeatures) {
        const int G = 16;
        int quota = std::max(4, (int)std::ceil(2.5 * maxFeatures / double(G * G)));
        std::sort(order.begin(), order.end(), [&](int a, int b) {
            if (raws[a].response != raws[b].response) return raws[a].response > raws[b].response;
            return a < b;
        });
        std::vector<int> cnt(G * G, 0), sel, rest;
        for (int id : order) {
            int cx = std::min(G - 1, (int)(raws[id].pt.x / gray.cols * G)), cy = std::min(G - 1, (int)(raws[id].pt.y / gray.rows * G));
            if (cnt[cy * G + cx] < quota) {
                cnt[cy * G + cx]++;
                sel.push_back(id);
            } else rest.push_back(id);
        }
        if ((int)sel.size() > maxFeatures) sel.resize(maxFeatures);
        for (size_t i = 0; i < rest.size() && (int)sel.size() < maxFeatures; i++) sel.push_back(rest[i]);
        std::sort(sel.begin(), sel.end());
        order = sel;
    }
    int N = (int)order.size();
    F.pts.resize(N);
    F.size.resize(N);
    F.angle.resize(N);
    F.desc = cv::Mat(N, 128, CV_32F);
    for (int i = 0; i < N; i++) {
        const Raw& r = raws[order[i]];
        F.pts[i] = r.pt;
        F.size[i] = r.size;
        F.angle[i] = r.angle;
        const float* s = descs[r.row >> 20].ptr<float>(r.row & ((1 << 20) - 1));
        float* d = F.desc.ptr<float>(i);
        float l1 = 1e-7f;
        for (int k = 0; k < 128; k++) l1 += std::abs(s[k]);
        for (int k = 0; k < 128; k++) d[k] = std::sqrt(std::abs(s[k]) / l1);  // RootSIFT (unit L2 norm)
    }
    return F;
}

// =============================================================================================== pair
json PairResult::toJson() const {
    json a = json::array(), b = json::array(), off = json::array();
    for (size_t i = 0; i < inA.size(); i++) {
        a.push_back({std::round(inA[i].x * 100) / 100, std::round(inA[i].y * 100) / 100});
        b.push_back({std::round(inB[i].x * 100) / 100, std::round(inB[i].y * 100) / 100});
    }
    for (size_t i = 0; i < offPlaneA.size() && i < offPlaneB.size(); i++)
        off.push_back({std::round(offPlaneA[i].x * 10) / 10, std::round(offPlaneA[i].y * 10) / 10, std::round(offPlaneB[i].x * 10) / 10, std::round(offPlaneB[i].y * 10) / 10});
    return json{{"ok", ok},           {"fail", fail},       {"H", H.toJson()},   {"nPutative", nPutative}, {"nInliers", nInliers},
                {"rms", rms},         {"thr", thr},         {"hullFrac", hullFrac}, {"scale", scale},      {"inA", a},
                {"inB", b},           {"ambiguous", ambiguous}, {"Halt", Halt.toJson()}, {"nAlt", nAlt},     {"nEpipolar", nEpipolar},
                {"planarRatio", planarRatio}, {"offPlaneA", off}};
}
PairResult PairResult::fromJson(const json& j) {
    PairResult r;
    r.ok = j.value("ok", false);
    r.fail = j.value("fail", "");
    r.H = H3::fromJson(j.at("H"));
    r.nPutative = j.value("nPutative", 0);
    r.nInliers = j.value("nInliers", 0);
    r.rms = j.value("rms", 0.0);
    r.thr = j.value("thr", 0.0);
    r.hullFrac = j.value("hullFrac", 0.0);
    r.scale = j.value("scale", 0.0);
    for (auto& p : j.at("inA")) r.inA.push_back({p[0].get<double>(), p[1].get<double>()});
    for (auto& p : j.at("inB")) r.inB.push_back({p[0].get<double>(), p[1].get<double>()});
    r.ambiguous = j.value("ambiguous", false);
    r.Halt = H3::fromJson(j.at("Halt"));
    r.nAlt = j.value("nAlt", 0);
    r.nEpipolar = j.value("nEpipolar", 0);
    r.planarRatio = j.value("planarRatio", 1.0);
    if (j.contains("offPlaneA"))
        for (auto& p : j["offPlaneA"])
            if (p.size() >= 4) {
                r.offPlaneA.push_back({p[0].get<double>(), p[1].get<double>()});
                r.offPlaneB.push_back({p[2].get<double>(), p[3].get<double>()});
            }
    return r;
}

bool homographyFromPoints(const std::vector<Pt>& a, const std::vector<Pt>& b, H3& H, double& rms) {
    if (a.size() < 4 || a.size() != b.size()) return false;
    std::vector<cv::Point2d> pa, pb;
    for (size_t i = 0; i < a.size(); i++) {
        pa.emplace_back(a[i].x, a[i].y);
        pb.emplace_back(b[i].x, b[i].y);
    }
    cv::Mat M = cv::findHomography(pa, pb, 0);
    if (M.empty()) return false;
    H = H3::fromCv(M).normalized();
    double s = 0;
    for (size_t i = 0; i < a.size(); i++) {
        Pt q = H.apply(a[i]);
        s += (q.x - b[i].x) * (q.x - b[i].x) + (q.y - b[i].y) * (q.y - b[i].y);
    }
    rms = std::sqrt(s / a.size());
    return std::isfinite(rms);
}

namespace {
struct Cand {
    int a, b;
    float d;
};

// uniform grid over B features for radius queries
struct GridIndex {
    double cell;
    int gw, gh;
    std::vector<std::vector<int>> cells;
    GridIndex(const Features& B, const std::vector<int>& idx, double cellSize) : cell(cellSize) {
        gw = std::max(1, (int)std::ceil(B.imgW / cell));
        gh = std::max(1, (int)std::ceil(B.imgH / cell));
        cells.resize((size_t)gw * gh);
        for (int i : idx) {
            int cx = std::min(gw - 1, std::max(0, (int)(B.pts[i].x / cell))), cy = std::min(gh - 1, std::max(0, (int)(B.pts[i].y / cell)));
            cells[(size_t)cy * gw + cx].push_back(i);
        }
    }
    template <class Fn>
    void query(double x, double y, double r, Fn fn) const {
        int x0 = std::max(0, (int)((x - r) / cell)), x1 = std::min(gw - 1, (int)((x + r) / cell));
        int y0 = std::max(0, (int)((y - r) / cell)), y1 = std::min(gh - 1, (int)((y + r) / cell));
        for (int cy = y0; cy <= y1; cy++)
            for (int cx = x0; cx <= x1; cx++)
                for (int i : cells[(size_t)cy * gw + cx]) fn(i);
    }
};

double descDist(const Features& A, int a, const Features& B, int b) {
    const float* p = A.desc.ptr<float>(a);
    const float* q = B.desc.ptr<float>(b);
    float s = 0;
    for (int k = 0; k < 128; k++) {
        float d = p[k] - q[k];
        s += d * d;
    }
    return std::sqrt(s);
}

// Lowe-style pose clustering on (scale ratio, rotation): keeps the dominant similarity cluster.
std::vector<Cand> houghFilter(const Features& A, const Features& B, const std::vector<Cand>& m) {
    if (m.size() < 20) return m;
    const int SB = 24, AB = 12;
    std::vector<float> hist(SB * AB, 0.f);
    auto bins = [&](const Cand& c, double& s, double& a) {
        s = std::log2(std::max(1e-3f, B.size[c.b]) / std::max(1e-3f, A.size[c.a]));
        a = B.angle[c.b] - A.angle[c.a];
        while (a < 0) a += 360;
        while (a >= 360) a -= 360;
    };
    for (auto& c : m) {
        double s, a;
        bins(c, s, a);
        int sb = (int)std::floor((s + 6) * 2), ab = (int)(a / 30) % AB;
        if (sb < 0 || sb >= SB) continue;
        hist[sb * AB + ab] += 1;
    }
    // smooth over neighbours to avoid bin-edge splits
    int bs = 0, ba = 0;
    float best = -1;
    for (int sb = 0; sb < SB; sb++)
        for (int ab = 0; ab < AB; ab++) {
            float v = 0;
            for (int ds = -1; ds <= 1; ds++)
                for (int da = -1; da <= 1; da++) {
                    int s2 = sb + ds, a2 = (ab + da + AB) % AB;
                    if (s2 < 0 || s2 >= SB) continue;
                    v += hist[s2 * AB + a2] * ((ds == 0 && da == 0) ? 2.f : 1.f);
                }
            if (v > best) {
                best = v;
                bs = sb;
                ba = ab;
            }
        }
    double sc = (bs + 0.5) / 2.0 - 6, ac = (ba + 0.5) * 30;
    std::vector<Cand> out;
    for (auto& c : m) {
        double s, a;
        bins(c, s, a);
        double da = std::abs(a - ac);
        da = std::min(da, 360 - da);
        if (std::abs(s - sc) <= 1.0 && da <= 50) out.push_back(c);
    }
    if (out.size() < 8 || out.size() < m.size() / 10) return m;
    return out;
}

struct Model {
    bool found = false;
    H3 H;
    std::vector<int> inl;  // indices into the candidate list
};
Model ransacH(const Features& A, const Features& B, const std::vector<Cand>& m, double thr) {
    Model r;
    if (m.size() < 6) return r;
    std::vector<cv::Point2f> pa, pb;
    for (auto& c : m) {
        pa.push_back(A.pts[c.a]);
        pb.push_back(B.pts[c.b]);
    }
    cv::Mat mask, M;
    try {
        M = cv::findHomography(pa, pb, cv::USAC_MAGSAC, thr, mask, 5000, 0.9995);
    } catch (const cv::Exception&) {
        return r;
    }
    if (M.empty()) return r;
    r.H = H3::fromCv(M).normalized();
    for (size_t i = 0; i < m.size(); i++) {
        Pt q = r.H.apply(pa[i].x, pa[i].y);
        double dx = q.x - pb[i].x, dy = q.y - pb[i].y;
        if (dx * dx + dy * dy <= thr * thr) r.inl.push_back((int)i);
    }
    r.found = r.inl.size() >= 6;
    return r;
}
// least-squares refit on inliers + inlier recount, two rounds
void polish(const Features& A, const Features& B, const std::vector<Cand>& m, double thr, Model& mod) {
    for (int it = 0; it < 2 && mod.inl.size() >= 8; it++) {
        std::vector<cv::Point2f> pa, pb;
        for (int i : mod.inl) {
            pa.push_back(A.pts[m[i].a]);
            pb.push_back(B.pts[m[i].b]);
        }
        cv::Mat M = cv::findHomography(pa, pb, 0);
        if (M.empty()) return;
        H3 H = H3::fromCv(M).normalized();
        std::vector<int> inl;
        for (size_t i = 0; i < m.size(); i++) {
            Pt q = H.apply(A.pts[m[i].a].x, A.pts[m[i].a].y);
            double dx = q.x - B.pts[m[i].b].x, dy = q.y - B.pts[m[i].b].y;
            if (dx * dx + dy * dy <= thr * thr) inl.push_back((int)i);
        }
        if (inl.size() < mod.inl.size()) return;
        mod.H = H;
        mod.inl = inl;
    }
}
// one match per A feature and per B feature (best distance wins)
std::vector<Cand> uniqueMatches(std::vector<Cand> m) {
    std::sort(m.begin(), m.end(), [](const Cand& x, const Cand& y) { return x.d != y.d ? x.d < y.d : (x.a != y.a ? x.a < y.a : x.b < y.b); });
    std::unordered_map<int, char> ua, ub;
    std::vector<Cand> out;
    for (auto& c : m) {
        if (ua.count(c.a) || ub.count(c.b)) continue;
        ua[c.a] = 1;
        ub[c.b] = 1;
        out.push_back(c);
    }
    std::sort(out.begin(), out.end(), [](const Cand& x, const Cand& y) { return x.a != y.a ? x.a < y.a : x.b < y.b; });
    return out;
}

std::vector<Cand> guidedMatches(const Features& A, const Features& B, const GridIndex& grid, const H3& H, double radius, double maxDist) {
    std::vector<Cand> out;
    for (int a = 0; a < (int)A.count(); a++) {
        double x = A.pts[a].x, y = A.pts[a].y;
        if (H.w(x, y) <= 1e-9) continue;
        Pt p = H.apply(x, y);
        if (p.x < -radius || p.y < -radius || p.x > B.imgW + radius || p.y > B.imgH + radius) continue;
        auto J = jacobian(H, x, y);
        double ls = std::sqrt(std::abs(J[0] * J[3] - J[1] * J[2]));
        double predSize = A.size[a] * ls;
        int bestI = -1;
        double best = 1e9, second = 1e9;
        grid.query(p.x, p.y, radius, [&](int b) {
            double dx = B.pts[b].x - p.x, dy = B.pts[b].y - p.y;
            if (dx * dx + dy * dy > radius * radius) return;
            double sr = B.size[b] / std::max(1e-3, predSize);
            if (sr < 0.6 || sr > 1.67) return;
            double d = descDist(A, a, B, b);
            if (d < best) {
                second = best;
                best = d;
                bestI = b;
            } else if (d < second) second = d;
        });
        if (bestI >= 0 && best < maxDist && best < 0.93 * second) out.push_back({a, bestI, (float)best});
    }
    return uniqueMatches(out);
}
}  // namespace

PairResult estimatePair(const Features& A, const Features& B, const PairOptions& opt) {
    PairResult R;
    const double thr = 2.5 / std::min(1.0, B.workScale);
    R.thr = thr;
    if (A.count() < 8 || B.count() < 8) {
        R.fail = "few_matches";
        return R;
    }
    std::vector<int> idxB;
    idxB.reserve(B.count());
    for (int i = 0; i < (int)B.count(); i++) {
        if (opt.restrict) {
            const auto& p = B.pts[i];
            if (p.x < opt.restrictB.x || p.y < opt.restrictB.y || p.x > opt.restrictB.x + opt.restrictB.width || p.y > opt.restrictB.y + opt.restrictB.height) continue;
        }
        idxB.push_back(i);
    }
    if (idxB.size() < 8) {
        R.fail = "few_matches";
        return R;
    }
    GridIndex grid(B, idxB, std::max(8.0, 4 * thr));

    std::vector<Cand> cands;  // final candidate list the model is expressed over
    Model mod;
    std::vector<Cand> nearTies;  // (a, b) alternatives that are almost as good as the best match
    std::vector<Cand> putH;      // pose-clustered ratio-test matches (for parallax diagnostics)

    if (opt.havePrior) {
        cands = guidedMatches(A, B, grid, opt.prior, opt.priorRadius, 0.80);
        R.nPutative = (int)cands.size();
        mod = ransacH(A, B, cands, thr);
        if (mod.found) polish(A, B, cands, thr, mod);
    } else {
        cv::Mat dB((int)idxB.size(), 128, CV_32F);
        for (size_t i = 0; i < idxB.size(); i++) B.desc.row(idxB[i]).copyTo(dB.row((int)i));
        cv::BFMatcher bf(cv::NORM_L2);
        std::vector<std::vector<cv::DMatch>> knn;
        bf.knnMatch(A.desc, dB, knn, 3);
        std::vector<Cand> put;
        for (auto& k : knn) {
            if (k.size() < 2) continue;
            if (k[0].distance < opt.ratio * k[1].distance) put.push_back({k[0].queryIdx, idxB[k[0].trainIdx], k[0].distance});
            for (auto& mm : k)
                if (mm.distance <= 1.2f * k[0].distance && mm.distance < 0.85f) nearTies.push_back({mm.queryIdx, idxB[mm.trainIdx], mm.distance});
        }
        put = uniqueMatches(put);
        R.nPutative = (int)put.size();
        putH = houghFilter(A, B, put);
        mod = ransacH(A, B, putH, thr);
        cands = putH;
        bool fromTies = false;
        if ((!mod.found || (int)mod.inl.size() < opt.minInliers) && opt.checkAmbiguity && nearTies.size() >= 30) {
            // The ratio test removes everything on repeating structure. Try the near-tie candidates to find
            // out whether the content is repetitive (several placements fit) or genuinely unmatched.
            std::vector<Cand> nt = houghFilter(A, B, nearTies);
            Model m2 = ransacH(A, B, nt, thr);
            if (m2.found && m2.inl.size() > mod.inl.size()) {
                mod = m2;
                cands = nt;
                fromTies = true;
            }
        }
        if (mod.found) {
            polish(A, B, cands, thr, mod);
            // guided matching: recover matches the ratio test rejected, then refit on the union
            std::vector<Cand> g = guidedMatches(A, B, grid, mod.H, std::max(1.5 * thr, 4.0), 0.75);
            if (g.size() > mod.inl.size()) {
                Model m3 = ransacH(A, B, g, thr);
                if (m3.found && m3.inl.size() >= mod.inl.size()) {
                    polish(A, B, g, thr, m3);
                    mod = m3;
                    cands = g;
                }
            }
        }
        (void)fromTies;
    }

    if (!mod.found) {
        R.fail = R.nPutative < 8 ? "few_matches" : "no_model";
        return R;
    }
    R.H = mod.H;
    R.nInliers = (int)mod.inl.size();
    // inlier statistics
    std::vector<Pt> ia, ib;
    double ss = 0;
    for (int i : mod.inl) {
        Pt a{A.pts[cands[i].a].x, A.pts[cands[i].a].y}, b{B.pts[cands[i].b].x, B.pts[cands[i].b].y};
        Pt q = R.H.apply(a);
        ss += (q.x - b.x) * (q.x - b.x) + (q.y - b.y) * (q.y - b.y);
        ia.push_back(a);
        ib.push_back(b);
    }
    R.rms = std::sqrt(ss / std::max<size_t>(1, ia.size()));
    R.hullFrac = hullArea(ia) / (double(A.imgW) * A.imgH);
    // keep a spatially spread subset of inliers (<= 240) for global refinement
    {
        const int G = 12, per = 2;
        std::map<int, int> cnt;
        std::vector<int> rest;
        for (size_t i = 0; i < ia.size(); i++) {
            int cx = std::min(G - 1, std::max(0, (int)(ia[i].x / A.imgW * G))), cy = std::min(G - 1, std::max(0, (int)(ia[i].y / A.imgH * G)));
            if (cnt[cy * G + cx] < per) {
                cnt[cy * G + cx]++;
                R.inA.push_back(ia[i]);
                R.inB.push_back(ib[i]);
            } else rest.push_back((int)i);
        }
        for (size_t k = 0; k < rest.size() && R.inA.size() < 240; k++) {
            R.inA.push_back(ia[rest[k]]);
            R.inB.push_back(ib[rest[k]]);
        }
    }
    HCheck hc = validateHomography(R.H, A.imgW, A.imgH);
    R.scale = hc.scale;
    if (!hc.ok) {
        R.fail = hc.reason;
        return R;
    }
    if (R.nInliers < opt.minInliers) {
        R.fail = "few_matches";
        return R;
    }
    if (R.hullFrac < (opt.requireAinsideB ? 0.06 : 0.01)) {
        R.fail = "low_spread";
        return R;
    }
    if (R.rms > 0.8 * thr) {
        R.fail = "high_residual";
        return R;
    }

    // ---- ambiguity: is there a second, distinct placement with comparable support? ----------------------
    // Candidates come from (1) a second model among near-tie matches and (2) the translational self-similarity
    // of B under A's footprint (periodic patterns). Each candidate is scored exactly like the primary placement:
    // by guided matching. Comparable support => the placement is not unique.
    if (opt.checkAmbiguity && !opt.havePrior) {
        const double gr = std::max(1.5 * thr, 4.0);
        // support of a candidate placement: guided matching, refit, and once more with the refined transform
        auto support = [&](const H3& Hc, H3& refined, double firstRadius) {
            H3 Hcur = Hc;
            int n = 0;
            for (int pass = 0; pass < 2; pass++) {
                std::vector<Cand> g = guidedMatches(A, B, grid, Hcur, pass == 0 ? firstRadius : gr, 0.75);
                Model m = ransacH(A, B, g, thr);
                if (!m.found) return pass == 0 ? 0 : n;
                polish(A, B, g, thr, m);
                Hcur = m.H;
                n = (int)m.inl.size();
            }
            refined = Hcur;
            return n;
        };
        H3 tmp;
        const int n1 = std::max(R.nInliers, support(R.H, tmp, gr));
        const Pt c1 = R.H.apply(A.imgW * 0.5, A.imgH * 0.5);
        const double foot = std::sqrt(double(A.imgW) * A.imgH) / std::max(1e-6, hc.scale);  // footprint size in B px
        std::vector<H3> alts;
        if (nearTies.size() >= 12) {
            std::vector<Cand> rem;
            for (auto& c : nearTies) {
                Pt q = R.H.apply(A.pts[c.a].x, A.pts[c.a].y);
                double dx = q.x - B.pts[c.b].x, dy = q.y - B.pts[c.b].y;
                if (dx * dx + dy * dy > 9 * thr * thr) rem.push_back(c);
            }
            if (rem.size() >= 12) {
                Model alt = ransacH(A, B, houghFilter(A, B, rem), thr);
                if (alt.found) alts.push_back(alt.H);
            }
        }
        {
            // self-similarity of B inside the footprint
            std::array<Pt, 4> quad = {R.H.apply(0, 0), R.H.apply(A.imgW, 0), R.H.apply(A.imgW, A.imgH), R.H.apply(0, A.imgH)};
            std::vector<int> sub;
            for (int i : idxB)
                if (pointInQuad(quad, {B.pts[i].x, B.pts[i].y})) sub.push_back(i);
            if (sub.size() > 3000) {
                std::vector<int> t;
                for (size_t i = 0; i < sub.size(); i += (sub.size() + 2999) / 3000) t.push_back(sub[i]);
                sub = t;
            }
            if (sub.size() >= 40) {
                cv::Mat d((int)sub.size(), 128, CV_32F);
                for (size_t i = 0; i < sub.size(); i++) B.desc.row(sub[i]).copyTo(d.row((int)i));
                std::vector<std::vector<cv::DMatch>> knn;
                cv::BFMatcher(cv::NORM_L2).knnMatch(d, d, knn, 4);
                const double bin = std::max(24.0, 6 * thr);  // coarse: perspective makes the lattice vector vary across the frame
                std::map<std::pair<int, int>, std::pair<int, Pt>> votes;
                for (auto& k : knn)
                    for (auto& m : k) {
                        if (m.queryIdx == m.trainIdx || m.distance > 0.6f) continue;
                        double dx = B.pts[sub[m.trainIdx]].x - B.pts[sub[m.queryIdx]].x, dy = B.pts[sub[m.trainIdx]].y - B.pts[sub[m.queryIdx]].y;
                        if (dx * dx + dy * dy < 16 * thr * thr) continue;
                        auto& v = votes[{(int)std::lround(dx / bin), (int)std::lround(dy / bin)}];
                        v.first++;
                        v.second.x += dx;
                        v.second.y += dy;
                    }
                std::vector<std::pair<int, Pt>> peaks;
                for (auto& kv : votes)
                    if (kv.second.first >= std::max(10, (int)(0.03 * sub.size()))) peaks.push_back({kv.second.first, {kv.second.second.x / kv.second.first, kv.second.second.y / kv.second.first}});
                std::sort(peaks.begin(), peaks.end(), [](auto& x, auto& y) { return x.first > y.first; });
                logf("self-similarity: %d features under footprint, %d displacement peaks (top %d votes)", (int)sub.size(), (int)peaks.size(), peaks.empty() ? 0 : peaks[0].first);
                for (size_t i = 0; i < peaks.size() && i < 6; i++) alts.push_back(H3::translate(peaks[i].second.x, peaks[i].second.y) * R.H);
            }
        }
        for (const H3& Ha : alts) {
            H3 ref = Ha;
            int n2 = support(Ha, ref, std::max(gr, 0.75 * std::max(24.0, 6 * thr)));
            HCheck h2 = validateHomography(ref, A.imgW, A.imgH);
            if (!h2.ok) continue;
            Pt c2 = ref.apply(A.imgW * 0.5, A.imgH * 0.5);
            logf("alt placement: support %d vs %d, shift %.1f px (footprint %.0f)", n2, n1, std::hypot(c1.x - c2.x, c1.y - c2.y), foot);
            if (std::hypot(c1.x - c2.x, c1.y - c2.y) < 0.08 * foot) continue;
            if (h2.scale / hc.scale > 1.5 || hc.scale / h2.scale > 1.5) continue;
            if (n2 >= std::max(10, (int)(0.5 * n1)) && n2 > R.nAlt) {
                R.ambiguous = true;
                R.Halt = ref;
                R.nAlt = n2;
            }
        }
    }

    // ---- parallax diagnostics: matches that satisfy an epipolar geometry but not the plane -------------
    if (!opt.havePrior && putH.size() >= 30) {
        std::vector<cv::Point2f> pa, pb;
        for (auto& c : putH) {
            pa.push_back(A.pts[c.a]);
            pb.push_back(B.pts[c.b]);
        }
        cv::Mat fmask, Fm;
        try {
            Fm = cv::findFundamentalMat(pa, pb, cv::USAC_MAGSAC, std::max(1.0, 0.6 * thr), 0.999, 2000, fmask);
        } catch (const cv::Exception&) {
        }
        if (!Fm.empty() && Fm.rows == 3 && !fmask.empty()) {
            int nF = 0, nBoth = 0;
            for (size_t i = 0; i < pa.size(); i++) {
                if (!fmask.at<uchar>((int)i)) continue;
                nF++;
                Pt q = R.H.apply(pa[i].x, pa[i].y);
                double dx = q.x - pb[i].x, dy = q.y - pb[i].y;
                if (dx * dx + dy * dy <= thr * thr) nBoth++;
                else if (dx * dx + dy * dy > 4 * thr * thr) {
                    R.offPlaneA.push_back({pa[i].x, pa[i].y});
                    R.offPlaneB.push_back({pb[i].x, pb[i].y});
                }
            }
            R.nEpipolar = nF;
            R.planarRatio = nF > 0 ? double(nBoth) / nF : 1.0;
        }
    }
    R.ok = true;
    return R;
}

}  // namespace dc
