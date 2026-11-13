// Composition: output grid selection, exposure/colour matching, MRF seam selection, tiled multi-band
// blending with provenance, pyramid construction, resumable + atomic result commit.
#include "dc/compose.h"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/imgproc/detail/gcgraph.hpp>
#include <filesystem>
#include <fstream>
#include <set>
#include <thread>

namespace fs = std::filesystem;

namespace dc {

std::recursive_mutex& projectMutex();

// =============================================================================================== cache
std::shared_ptr<cv::Mat> ImageCache::get(const std::string& key, const std::function<cv::Mat()>& loader) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto it = lru_.begin(); it != lru_.end(); ++it)
        if (it->key == key) {
            lru_.splice(lru_.begin(), lru_, it);
            return lru_.front().img;
        }
    auto img = std::make_shared<cv::Mat>(loader());
    size_t bytes = img->total() * img->elemSize();
    // evict least-recently-used entries nobody is holding
    for (auto it = lru_.end(); used_ + bytes > budget_ && it != lru_.begin();) {
        --it;
        if (it->img.use_count() == 1) {
            used_ -= it->bytes;
            it = lru_.erase(it);
        }
    }
    lru_.push_front({key, img, bytes});
    used_ += bytes;
    return img;
}
void ImageCache::clear() {
    std::lock_guard<std::mutex> lk(mu_);
    lru_.clear();
    used_ = 0;
}

// =============================================================================================== pyramid
std::string tilePath(const std::string& root, int level, int col, int row, const std::string& ext) {
    return root + "/" + std::to_string(level) + "/" + std::to_string(col) + "_" + std::to_string(row) + "." + ext;
}
static void writeTile(const std::string& path, const cv::Mat& img, const std::string& ext) {
    std::string tmp = path + ".part." + ext;
    std::vector<int> params;
    if (ext == "png") params = {cv::IMWRITE_PNG_COMPRESSION, 1};
    else params = {cv::IMWRITE_JPEG_QUALITY, 92};
    if (!cv::imwrite(tmp, img, params)) throw UserError("storage_full", "Could not write image tiles (storage full?).");
    std::error_code ec;
    fs::rename(tmp, path, ec);
    if (ec) throw UserError("io", "Could not write image tiles.");
}
void writeDzi(const std::string& path, const Pyramid& pyr, const std::string& ext) {
    char buf[512];
    snprintf(buf, sizeof(buf),
             "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Image xmlns=\"http://schemas.microsoft.com/deepzoom/2008\" Format=\"%s\" Overlap=\"0\" "
             "TileSize=\"%d\">\n  <Size Width=\"%d\" Height=\"%d\"/>\n</Image>\n",
             ext.c_str(), pyr.tile, pyr.w, pyr.h);
    atomicWriteFile(path, buf);
}
void buildLowerLevels(const std::string& root, const Pyramid& pyr, const std::string& ext, const Ctx& ctx, const std::string& stage, double p0, double p1) {
    long total = 0, done = 0;
    for (int L = pyr.maxLevel - 1; L >= 0; L--) total += (long)pyr.cols(L) * pyr.rows(L);
    for (int L = pyr.maxLevel - 1; L >= 0; L--) {
        fs::create_directories(root + "/" + std::to_string(L));
        for (int r = 0; r < pyr.rows(L); r++)
            for (int c = 0; c < pyr.cols(L); c++) {
                ctx.check();
                done++;
                std::string out = tilePath(root, L, c, r, ext);
                if (fileExists(out)) continue;
                int tw = std::min(pyr.tile, pyr.levelW(L) - c * pyr.tile), th = std::min(pyr.tile, pyr.levelH(L) - r * pyr.tile);
                int cw = std::min(2 * pyr.tile, pyr.levelW(L + 1) - 2 * c * pyr.tile), ch = std::min(2 * pyr.tile, pyr.levelH(L + 1) - 2 * r * pyr.tile);
                cv::Mat mosaic(ch, cw, CV_8UC3, cv::Scalar(0, 0, 0));
                for (int dy = 0; dy < 2; dy++)
                    for (int dx = 0; dx < 2; dx++) {
                        int cc = 2 * c + dx, rr = 2 * r + dy;
                        if (cc >= pyr.cols(L + 1) || rr >= pyr.rows(L + 1)) continue;
                        cv::Mat t = cv::imread(tilePath(root, L + 1, cc, rr, ext), cv::IMREAD_COLOR);
                        if (t.empty()) throw std::runtime_error("missing tile while building pyramid");
                        t.copyTo(mosaic(cv::Rect(dx * pyr.tile, dy * pyr.tile, t.cols, t.rows)));
                    }
                if ((cw & 1) || (ch & 1)) cv::copyMakeBorder(mosaic, mosaic, 0, ch & 1, 0, cw & 1, cv::BORDER_REPLICATE);
                cv::Mat down;
                cv::resize(mosaic, down, cv::Size(tw, th), 0, 0, cv::INTER_AREA);
                writeTile(out, down, ext);
                if ((done & 15) == 0) ctx.report(stage, p0 + (p1 - p0) * done / std::max(1L, total));
            }
    }
}
cv::Mat readPyramidRect(const std::string& root, const Pyramid& pyr, int level, cv::Rect r, const std::string& ext, ImageCache& cache) {
    cv::Mat out(r.height, r.width, CV_8UC3);
    const int lw = pyr.levelW(level), lh = pyr.levelH(level);
    cv::Rect in = r & cv::Rect(0, 0, lw, lh);
    if (in.empty()) {
        out.setTo(0);
        return out;
    }
    for (int tr = in.y / pyr.tile; tr <= (in.y + in.height - 1) / pyr.tile; tr++)
        for (int tc = in.x / pyr.tile; tc <= (in.x + in.width - 1) / pyr.tile; tc++) {
            std::string p = tilePath(root, level, tc, tr, ext);
            auto t = cache.get(p, [&] {
                cv::Mat m = cv::imread(p, cv::IMREAD_COLOR);
                if (m.empty()) throw std::runtime_error("missing tile " + p);
                return m;
            });
            cv::Rect tileRect(tc * pyr.tile, tr * pyr.tile, t->cols, t->rows);
            cv::Rect ov = tileRect & in;
            if (ov.empty()) continue;
            (*t)(cv::Rect(ov.x - tileRect.x, ov.y - tileRect.y, ov.width, ov.height)).copyTo(out(cv::Rect(ov.x - r.x, ov.y - r.y, ov.width, ov.height)));
        }
    if (in != r) {
        cv::Mat inner = out(cv::Rect(in.x - r.x, in.y - r.y, in.width, in.height)).clone();
        cv::copyMakeBorder(inner, out, in.y - r.y, r.y + r.height - in.y - in.height, in.x - r.x, r.x + r.width - in.x - in.width, cv::BORDER_REPLICATE);
    }
    return out;
}

// =============================================================================================== plan
namespace {
const int kTile = 512;
const int kLevels = 4;   // Laplacian levels below the base (bands down to 16 px)
const int kMargin = 96;  // window margin (multiple of 2^kLevels); verified by the tile-boundary test

struct PlanFrame {
    std::string id, path;
    ImageMeta meta;
    FrameModel model;
    std::vector<uint8_t> mask;
    int mgw = 0, mgh = 0;
    FrameQuality quality;
    int reduce = 1;     // decode reduction used for rendering (anti-aliasing when the output grid is coarser)
    cv::Rect bbox;      // seam-grid bounding box
    cv::Mat gain;       // CV_32FC3 over bbox (encoded-value gain towards the overview's low frequencies)
    float tone[6] = {1, 1, 1, 0, 0, 0};  // per-channel (B,G,R) affine tone match to the overview: v' = a*v + b (b in 0..1)
    uint64_t hash = 0;  // identity of everything that determines this frame's pixels
    bool maskedAt(double fx, double fy) const {
        if (mask.empty()) return false;
        int cx = std::min(mgw - 1, std::max(0, (int)(fx / model.w * mgw))), cy = std::min(mgh - 1, std::max(0, (int)(fy / model.h * mgh)));
        return mask[cy * mgw + cx] != 0;
    }
};
struct Plan {
    int ovW = 0, ovH = 0, W = 0, H = 0, q = 1, Ws = 0, Hs = 0, block = 1024;
    double S = 1, sx = 1, sy = 1;
    std::string workingSpace, hash;
    std::vector<PlanFrame> frames;  // [0] = overview (label 0)
    cv::Mat labels;                 // CV_8U Hs x Ws
    cv::Mat detail;                 // CV_32F Hs x Ws: effective detail gain of the chosen source
    uint64_t globalHash = 0;
};

inline Pt seamToCanvas(const Plan& pl, double u, double v) { return {(u + 0.5) * pl.q / pl.sx, (v + 0.5) * pl.q / pl.sy}; }

cv::Mat loadFrame(const Plan& pl, const PlanFrame& pf, int reduce) { return loadOriented(pf.path, pf.meta, reduce, pl.workingSpace); }

// Warp a frame onto a rectangle of the seam grid (low resolution, anti-aliased). colour in [0,1].
void warpToSeam(const Plan& pl, const PlanFrame& pf, cv::Rect r, cv::Mat& color, cv::Mat& valid) {
    Pt cc = seamToCanvas(pl, r.x + r.width * 0.5 - 0.5, r.y + r.height * 0.5 - 0.5);
    double sSeam = pf.model.scaleAt(cc) * pl.q / std::sqrt(pl.sx * pl.sy);
    int red = 1;
    for (int k : {8, 4, 2})
        if (k <= sSeam) {
            red = k;
            break;
        }
    cv::Mat img = loadFrame(pl, pf, red);
    double minif = sSeam / red;
    if (minif > 1.15) cv::GaussianBlur(img, img, cv::Size(0, 0), 0.45 * minif);
    cv::Mat mx(r.height, r.width, CV_32F), my(r.height, r.width, CV_32F);
    valid = cv::Mat(r.height, r.width, CV_8U);
    const double inset = 2.0 * red;
    cv::parallel_for_(cv::Range(0, r.height), [&](const cv::Range& rg) {
        for (int y = rg.start; y < rg.end; y++) {
            float* px = mx.ptr<float>(y);
            float* py = my.ptr<float>(y);
            uchar* v = valid.ptr<uchar>(y);
            for (int x = 0; x < r.width; x++) {
                Pt p = pf.model.toFrame(seamToCanvas(pl, r.x + x, r.y + y));
                bool ok = p.x >= inset && p.y >= inset && p.x <= pf.model.w - inset && p.y <= pf.model.h - inset;
                if (ok && pf.maskedAt(p.x, p.y)) ok = false;
                v[x] = ok ? 255 : 0;
                px[x] = (float)(p.x / red - 0.5);
                py[x] = (float)(p.y / red - 0.5);
            }
        }
    });
    cv::Mat w8;
    cv::remap(img, w8, mx, my, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    w8.convertTo(color, CV_32FC3, 1.0 / 255);
}

// ---------------------------------------------------------------------------------------------- seams
struct SeamLayer {
    cv::Rect bbox;
    cv::Mat color;  // CV_32FC3 (gain compensated)
    cv::Mat valid;  // CV_8U
    cv::Mat Q;      // CV_32F selection quality (0 where invalid)
    cv::Mat raw;    // CV_32F effective detail gain (s * sharpness)
    inline bool in(int x, int y) const { return x >= bbox.x && y >= bbox.y && x < bbox.x + bbox.width && y < bbox.y + bbox.height; }
    inline bool ok(int x, int y) const { return in(x, y) && valid.at<uchar>(y - bbox.y, x - bbox.x); }
    inline const cv::Vec3f& col(int x, int y) const { return color.at<cv::Vec3f>(y - bbox.y, x - bbox.x); }
    inline float q(int x, int y) const { return in(x, y) ? Q.at<float>(y - bbox.y, x - bbox.x) : 0.f; }
};

struct SeamSolver {
    const std::vector<SeamLayer>& L;
    cv::Mat labels;  // CV_8U
    cv::Mat qmax;    // CV_32F
    int W, H;
    const float lambdaD = 2.0f, beta = 8.0f, kappa = 0.03f, deadZone = 0.08f;

    SeamSolver(const std::vector<SeamLayer>& layers, int W_, int H_) : L(layers), W(W_), H(H_) {
        labels = cv::Mat(H, W, CV_8U, cv::Scalar(0));
        qmax = cv::Mat(H, W, CV_32F, cv::Scalar(0));
        for (size_t l = 0; l < L.size(); l++) {
            const SeamLayer& s = L[l];
            for (int y = s.bbox.y; y < s.bbox.y + s.bbox.height; y++)
                for (int x = s.bbox.x; x < s.bbox.x + s.bbox.width; x++) {
                    if (!s.ok(x, y)) continue;
                    float q = s.q(x, y);
                    if (q > qmax.at<float>(y, x)) {
                        qmax.at<float>(y, x) = q;
                        labels.at<uchar>(y, x) = (uchar)l;
                    }
                }
        }
    }
    inline float D(int l, int x, int y) const {
        if (!L[l].ok(x, y)) return 1e6f;
        // sources within a few percent of the best are treated as equally good: seams then follow image content
        return lambdaD * std::max(0.f, 1.f - L[l].q(x, y) / std::max(1e-6f, qmax.at<float>(y, x)) - deadZone);
    }
    inline float diffAt(int a, int b, int x, int y, bool& have) const {
        if (!L[a].ok(x, y) || !L[b].ok(x, y)) {
            have = false;
            return 0;
        }
        have = true;
        const cv::Vec3f& ca = L[a].col(x, y);
        const cv::Vec3f& cb = L[b].col(x, y);
        return (std::abs(ca[0] - cb[0]) + std::abs(ca[1] - cb[1]) + std::abs(ca[2] - cb[2])) / 3.f;
    }
    // seam cost between label a at (x1,y1) and label b at (x2,y2)
    inline float V(int a, int b, int x1, int y1, int x2, int y2) const {
        if (a == b) return 0;
        bool h1, h2;
        float d1 = diffAt(a, b, x1, y1, h1), d2 = diffAt(a, b, x2, y2, h2);
        float d = h1 && h2 ? d1 + d2 : (h1 ? 2 * d1 : (h2 ? 2 * d2 : 0.f));
        return kappa + beta * d;
    }
    bool expand(int alpha) {
        const cv::Rect bb = L[alpha].bbox & cv::Rect(0, 0, W, H);
        if (bb.empty()) return false;
        cv::Mat node(bb.height, bb.width, CV_32S, cv::Scalar(-1));
        int n = 0;
        for (int y = 0; y < bb.height; y++)
            for (int x = 0; x < bb.width; x++) {
                int gx = bb.x + x, gy = bb.y + y;
                if (labels.at<uchar>(gy, gx) == alpha || !L[alpha].ok(gx, gy)) continue;
                node.at<int>(y, x) = n++;
            }
        if (n == 0) return false;
        std::vector<float> u0(n, 0.f), u1(n, 0.f);
        cv::detail::GCGraph<float> g(n, 4 * n);
        for (int i = 0; i < n; i++) g.addVtx();
        struct Edge {
            int p, q;
            float k;
        };
        for (int y = 0; y < bb.height; y++)
            for (int x = 0; x < bb.width; x++) {
                int gx = bb.x + x, gy = bb.y + y;
                int p = node.at<int>(y, x);
                int fp = labels.at<uchar>(gy, gx);
                if (p >= 0) {
                    u0[p] += D(fp, gx, gy);
                    u1[p] += D(alpha, gx, gy);
                }
                for (int dir = 0; dir < 2; dir++) {
                    int qx = gx + (dir == 0), qy = gy + (dir == 1);
                    if (qx >= W || qy >= H) continue;
                    int lx = qx - bb.x, ly = qy - bb.y;
                    int qn = (lx < bb.width && ly < bb.height) ? node.at<int>(ly, lx) : -1;
                    int fq = labels.at<uchar>(qy, qx);
                    if (p < 0 && qn < 0) continue;
                    if (p >= 0 && qn >= 0) {
                        float A = V(fp, fq, gx, gy, qx, qy), B = V(fp, alpha, gx, gy, qx, qy), C = V(alpha, fq, gx, gy, qx, qy);
                        u1[p] += C - A;
                        u1[qn] += -C;
                        float K = B + C - A;
                        // constant A is dropped; shift unaries so that they stay comparable
                        u0[p] += 0;
                        if (K > 0) g.addEdges(p, qn, 0.f, K);
                    } else if (p >= 0) {  // q fixed
                        u0[p] += V(fp, fq, gx, gy, qx, qy);
                        u1[p] += V(alpha, fq, gx, gy, qx, qy);
                    } else {  // p fixed
                        u0[qn] += V(fp, fq, gx, gy, qx, qy);
                        u1[qn] += V(fp, alpha, gx, gy, qx, qy);
                    }
                }
            }
        // left / top neighbours outside the bbox are fixed too
        for (int y = 0; y < bb.height; y++)
            for (int x = 0; x < bb.width; x++) {
                int p = node.at<int>(y, x);
                if (p < 0) continue;
                int gx = bb.x + x, gy = bb.y + y, fp = labels.at<uchar>(gy, gx);
                if (x == 0 && gx > 0) {
                    int fq = labels.at<uchar>(gy, gx - 1);
                    u0[p] += V(fq, fp, gx - 1, gy, gx, gy);
                    u1[p] += V(fq, alpha, gx - 1, gy, gx, gy);
                }
                if (y == 0 && gy > 0) {
                    int fq = labels.at<uchar>(gy - 1, gx);
                    u0[p] += V(fq, fp, gx, gy - 1, gx, gy);
                    u1[p] += V(fq, alpha, gx, gy - 1, gx, gy);
                }
            }
        for (int i = 0; i < n; i++) {
            float m = std::min(u0[i], u1[i]);
            g.addTermWeights(i, u0[i] - m, u1[i] - m);  // cost(keep) = source weight, cost(alpha) = sink weight
        }
        g.maxFlow();
        bool changed = false;
        for (int y = 0; y < bb.height; y++)
            for (int x = 0; x < bb.width; x++) {
                int p = node.at<int>(y, x);
                if (p >= 0 && g.inSourceSegment(p)) {
                    labels.at<uchar>(bb.y + y, bb.x + x) = (uchar)alpha;
                    changed = true;
                }
            }
        return changed;
    }
};

// Up-sample a seam-grid image (given with its seam-grid origin) onto an output-pixel window.
cv::Mat upsampleSeam(const cv::Mat& img, cv::Point origin, cv::Rect win, int q, int interp) {
    // sub-crop needed (with padding) to keep warpAffine cheap
    int u0 = (int)std::floor((win.x + 0.5) / q - 0.5) - 2, u1 = (int)std::ceil((win.x + win.width - 0.5) / q - 0.5) + 2;
    int v0 = (int)std::floor((win.y + 0.5) / q - 0.5) - 2, v1 = (int)std::ceil((win.y + win.height - 0.5) / q - 0.5) + 2;
    cv::Rect want(u0 - origin.x, v0 - origin.y, u1 - u0 + 1, v1 - v0 + 1);
    cv::Rect have = want & cv::Rect(0, 0, img.cols, img.rows);
    cv::Mat crop;
    if (have.empty()) {
        // window lies completely outside this image: replicate the nearest pixel
        int cx = std::min(img.cols - 1, std::max(0, want.x)), cy = std::min(img.rows - 1, std::max(0, want.y));
        crop = img(cv::Rect(cx, cy, 1, 1));
        have = cv::Rect(cx, cy, 1, 1);
    } else crop = img(have);
    double ox = origin.x + have.x, oy = origin.y + have.y;
    cv::Mat M = (cv::Mat_<double>(2, 3) << 1.0 / q, 0, (win.x + 0.5) / q - 0.5 - ox, 0, 1.0 / q, (win.y + 0.5) / q - 0.5 - oy);
    cv::Mat out;
    cv::warpAffine(crop, out, M, win.size(), interp | cv::WARP_INVERSE_MAP, cv::BORDER_REPLICATE);
    return out;
}

// Render one source frame onto an output-pixel window as float BGR (0..255). valid: frame has pixels there.
void renderSource(const Plan& pl, const PlanFrame& pf, ImageCache& cache, cv::Rect win, int interp, cv::Mat& out, cv::Mat* valid) {
    const int red = pf.reduce;
    auto src = cache.get(pf.id + "@" + std::to_string(red), [&] { return loadFrame(pl, pf, red); });
    cv::Mat mx(win.height, win.width, CV_32F), my(win.height, win.width, CV_32F);
    if (valid) *valid = cv::Mat(win.height, win.width, CV_8U);
    std::vector<float> rminx(win.height, 1e9f), rmaxx(win.height, -1e9f), rminy(win.height, 1e9f), rmaxy(win.height, -1e9f);
    const double isx = 1.0 / pl.sx, isy = 1.0 / pl.sy;
    cv::parallel_for_(cv::Range(0, win.height), [&](const cv::Range& rg) {
        for (int y = rg.start; y < rg.end; y++) {
            float* px = mx.ptr<float>(y);
            float* py = my.ptr<float>(y);
            uchar* v = valid ? valid->ptr<uchar>(y) : nullptr;
            float a = 1e9f, b = -1e9f, c = 1e9f, d = -1e9f;
            for (int x = 0; x < win.width; x++) {
                Pt p = pf.model.toFrame({(win.x + x + 0.5) * isx, (win.y + y + 0.5) * isy});
                bool ok = p.x >= 0 && p.y >= 0 && p.x <= pf.model.w && p.y <= pf.model.h;
                if (v) v[x] = ok ? 255 : 0;
                float fx = (float)(p.x / red - 0.5), fy = (float)(p.y / red - 0.5);
                px[x] = fx;
                py[x] = fy;
                if (ok || !valid) {
                    a = std::min(a, fx);
                    b = std::max(b, fx);
                    c = std::min(c, fy);
                    d = std::max(d, fy);
                }
            }
            rminx[y] = a;
            rmaxx[y] = b;
            rminy[y] = c;
            rmaxy[y] = d;
        }
    });
    float a = 1e9f, b = -1e9f, c = 1e9f, d = -1e9f;
    for (int y = 0; y < win.height; y++) {
        a = std::min(a, rminx[y]);
        b = std::max(b, rmaxx[y]);
        c = std::min(c, rminy[y]);
        d = std::max(d, rmaxy[y]);
    }
    out = cv::Mat(win.height, win.width, CV_32FC3, cv::Scalar(0, 0, 0));
    if (b < a) return;  // frame not visible in this window
    const int pad = 6;
    cv::Rect roi((int)std::floor(a) - pad, (int)std::floor(c) - pad, (int)std::ceil(b) - (int)std::floor(a) + 2 * pad + 1, (int)std::ceil(d) - (int)std::floor(c) + 2 * pad + 1);
    roi &= cv::Rect(0, 0, src->cols, src->rows);
    if (roi.empty()) return;
    cv::Mat srcF;
    (*src)(roi).convertTo(srcF, CV_32FC3);
    mx -= (float)roi.x;
    my -= (float)roi.y;
    cv::remap(srcF, out, mx, my, interp, cv::BORDER_REPLICATE);
}

struct BlockResult {
    json tiles = json::object();
};

// Renders the window of one block and returns the 8-bit core.
cv::Mat renderBlock(const Plan& pl, ImageCache& cache, cv::Rect core, json* prov) {
    const int M = kMargin;
    cv::Rect win(core.x - M, core.y - M, pl.block + 2 * M, pl.block + 2 * M);  // constant size, aligned to 2^kLevels
    // labels present in the window
    cv::Rect seamRect((int)std::floor((win.x + 0.5) / pl.q - 0.5) - 3, (int)std::floor((win.y + 0.5) / pl.q - 0.5) - 3, 0, 0);
    seamRect.width = (int)std::ceil((win.x + win.width - 0.5) / pl.q - 0.5) + 4 - seamRect.x;
    seamRect.height = (int)std::ceil((win.y + win.height - 0.5) / pl.q - 0.5) + 4 - seamRect.y;
    cv::Rect sr = seamRect & cv::Rect(0, 0, pl.Ws, pl.Hs);
    std::set<int> present;
    cv::Mat lc;
    if (sr.empty()) present.insert(0);
    else {
        lc = pl.labels(sr);
        for (int y = 0; y < lc.rows; y++)
            for (int x = 0; x < lc.cols; x++) present.insert(lc.at<uchar>(y, x));
    }
    cv::Rect coreIn(M, M, core.width, core.height);
    cv::Mat base;
    renderSource(pl, pl.frames[0], cache, win, cv::INTER_CUBIC, base, nullptr);
    cv::Mat result;
    cv::Mat bestLabel(win.height, win.width, CV_8U, cv::Scalar(0));
    if (present.size() == 1 && *present.begin() == 0) {
        result = base;
    } else {
        // hard label masks at output resolution from the bilinearly up-sampled seam-grid indicators
        cv::Mat bestVal(win.height, win.width, CV_32F, cv::Scalar(-1));
        for (int l : present) {
            cv::Mat ind;
            cv::Mat(lc == l).convertTo(ind, CV_32F, 1.0 / 255);
            cv::Mat up = upsampleSeam(ind, sr.tl(), win, pl.q, cv::INTER_LINEAR);
            cv::Mat better = up > bestVal;
            up.copyTo(bestVal, better);
            bestLabel.setTo(l, better);
        }
        std::vector<cv::Mat> acc(kLevels + 1);
        for (int l : present) {
            cv::Mat img;
            if (l == 0) img = base;
            else {
                const PlanFrame& pf = pl.frames[l];
                cv::Mat valid;
                renderSource(pl, pf, cache, win, cv::INTER_LANCZOS4, img, &valid);
                cv::Mat gain = upsampleSeam(pf.gain, pf.bbox.tl(), win, pl.q, cv::INTER_LINEAR);
                img = img.mul(cv::Scalar(pf.tone[0], pf.tone[1], pf.tone[2])) + cv::Scalar(pf.tone[3] * 255.0, pf.tone[4] * 255.0, pf.tone[5] * 255.0);
                cv::multiply(img, gain, img);
                base.copyTo(img, ~valid);  // outside the frame: continue with the (lower-detail) overview
            }
            cv::Mat w;
            cv::Mat(bestLabel == l).convertTo(w, CV_32F, 1.0 / 255);
            // Laplacian pyramid of the image, Gaussian pyramid of the mask
            cv::Mat gImg = img, gW = w;
            for (int k = 0; k <= kLevels; k++) {
                cv::Mat lap, w3;
                cv::Mat nextImg, nextW;
                if (k < kLevels) {
                    cv::pyrDown(gImg, nextImg);
                    cv::pyrDown(gW, nextW);
                    cv::Mat up;
                    cv::pyrUp(nextImg, up, gImg.size());
                    lap = gImg - up;
                } else lap = gImg;
                cv::Mat ch[3] = {gW, gW, gW};
                cv::merge(ch, 3, w3);
                cv::multiply(lap, w3, lap);
                if (acc[k].empty()) acc[k] = lap;
                else acc[k] += lap;
                gImg = nextImg;
                gW = nextW;
            }
        }
        result = acc[kLevels];
        for (int k = kLevels - 1; k >= 0; k--) {
            cv::Mat up;
            cv::pyrUp(result, up, acc[k].size());
            result = up + acc[k];
        }
    }
    cv::Mat out8;
    result(coreIn).convertTo(out8, CV_8UC3);
    if (prov) {
        // per stored tile: which sources contribute and how much
        for (int ty = 0; ty < core.height; ty += kTile)
            for (int tx = 0; tx < core.width; tx += kTile) {
                cv::Rect t(M + tx, M + ty, std::min(kTile, core.width - tx), std::min(kTile, core.height - ty));
                cv::Mat lab = bestLabel(t);
                std::map<int, int> cnt;
                for (int y = 0; y < lab.rows; y++) {
                    const uchar* p = lab.ptr<uchar>(y);
                    for (int x = 0; x < lab.cols; x++) cnt[p[x]]++;
                }
                json arr = json::array();
                for (auto& kv : cnt) arr.push_back({pl.frames[kv.first].id, std::round(1000.0 * kv.second / (double)lab.total()) / 1000.0});
                (*prov)[std::to_string((core.x + tx) / kTile) + "_" + std::to_string((core.y + ty) / kTile)] = arr;
            }
    }
    return out8;
}

uint64_t blockHash(const Plan& pl, cv::Rect core) {
    const int M = kMargin;
    cv::Rect win(core.x - M, core.y - M, pl.block + 2 * M, pl.block + 2 * M);
    cv::Rect seamRect((int)std::floor((win.x + 0.5) / pl.q - 0.5) - 2, (int)std::floor((win.y + 0.5) / pl.q - 0.5) - 2, 0, 0);
    seamRect.width = (int)std::ceil((win.x + win.width - 0.5) / pl.q - 0.5) + 3 - seamRect.x;
    seamRect.height = (int)std::ceil((win.y + win.height - 0.5) / pl.q - 0.5) + 3 - seamRect.y;
    cv::Rect sr = seamRect & cv::Rect(0, 0, pl.Ws, pl.Hs);
    uint64_t h = pl.globalHash;
    int geo[4] = {core.x, core.y, core.width, core.height};
    h = fnv1a(geo, sizeof(geo), h);
    std::set<int> present;
    present.insert(0);
    if (!sr.empty()) {
        cv::Mat lc = pl.labels(sr).clone();
        h = fnv1a(lc.data, lc.total(), h);
        for (size_t i = 0; i < lc.total(); i++) present.insert(lc.data[i]);
    }
    for (int l : present) {
        const PlanFrame& pf = pl.frames[l];
        h = fnv1a(&pf.hash, sizeof(pf.hash), h);
        h = fnv1a(pf.tone, sizeof(pf.tone), h);
        if (l > 0 && !sr.empty()) {
            cv::Rect g = sr & pf.bbox;
            if (!g.empty()) {
                cv::Mat gc = pf.gain(cv::Rect(g.x - pf.bbox.x, g.y - pf.bbox.y, g.width, g.height)).clone();
                h = fnv1a(gc.data, gc.total() * gc.elemSize(), h);
            }
        }
    }
    return h;
}

std::string hex64(uint64_t v) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%016llx", (unsigned long long)v);
    return buf;
}

uint64_t fileIdentity(const std::string& path) {
    std::error_code ec;
    auto sz = fs::file_size(path, ec);
    uint64_t h = fnv1a(path.data(), path.size());
    return fnv1a(&sz, sizeof(sz), h);
}
}  // namespace

// =============================================================================================== compose
json composeProject(Project& P0, const json& args, const Ctx& ctx) {
    int64_t t0 = nowMs();
    Project P = P0;  // snapshot; the stored project is only touched at commit
    json* ovp = P.overview();
    if (!ovp) throw UserError("no_overview", "Add an overview photo first.");
    json& ov = *ovp;
    Plan pl;
    pl.ovW = ov["meta"]["width"];
    pl.ovH = ov["meta"]["height"];
    pl.workingSpace = P.workingSpace();
    if (pl.workingSpace == "unknown") pl.workingSpace = "";
    auto accepted = acceptedFrames(P);
    const FrameQuality ovQ = FrameQuality::fromJson(ov["quality"]);
    if (accepted.size() > 250) throw UserError("too_many", "At most 250 accepted close-ups can be fused into one result.");
    ctx.report("Planning", 0.01);

    // ---- output grid: supported by source sampling, bounded by settings -------------------------------
    json cov = computeCoverage(P, false);
    double S = accepted.empty() ? 1.0 : cov["stats"].value("p80GainCovered", 1.0);
    {
        // use the 90th percentile of the capped effective gain as the grid scale
        std::vector<double> g;
        for (auto& L : accepted) {
            Pt c = L.model.toCanvas({L.model.w * 0.5, L.model.h * 0.5});
            g.push_back(detailGain(L.model.scaleAt(c), L.quality.sharpSigma, ovQ.sigmaAt(c.x, c.y, pl.ovW, pl.ovH)));
        }
        if (!g.empty()) {
            std::sort(g.begin(), g.end());
            S = std::max(S, g[std::min(g.size() - 1, (size_t)(g.size() * 0.75))]);
        }
    }
    const json& st = P.j["settings"];
    double maxScale = st.value("maxScale", 8.0), maxMP = st.value("maxOutputMP", 400.0);
    if (args.contains("scale")) S = args["scale"].get<double>();
    S = std::max(1.0, std::min({S, maxScale, std::sqrt(maxMP * 1e6 / (double(pl.ovW) * pl.ovH))}));
    S = std::round(S * 100) / 100;
    pl.S = S;
    pl.W = std::max(1, (int)std::lround(S * pl.ovW));
    pl.H = std::max(1, (int)std::lround(S * pl.ovH));
    pl.sx = double(pl.W) / pl.ovW;
    pl.sy = double(pl.H) / pl.ovH;
    pl.block = args.value("blockSize", ctx.memoryBudgetMB < 400 ? 512 : 1024);
    if (pl.block != 512 && pl.block != 1024 && pl.block != 2048) pl.block = 1024;
    pl.q = 1;
    while ((double(pl.W) / pl.q) * (double(pl.H) / pl.q) > 1.2e6) pl.q++;
    pl.Ws = (pl.W + pl.q - 1) / pl.q;
    pl.Hs = (pl.H + pl.q - 1) / pl.q;
    Pyramid pyr(pl.W, pl.H, kTile);

    // ---- storage check ---------------------------------------------------------------------------------
    {
        std::error_code ec;
        auto sp = fs::space(P.dir, ec);
        double need = double(pl.W) * pl.H * 3 * 0.75 * 1.34;  // conservative PNG estimate incl. pyramid
        if (!ec && (double)sp.available < need + 64e6)
            throw UserError("storage_full", "Not enough free storage for this result (about " + std::to_string((int)(need / 1e6)) + " MB needed). Free up space or lower the maximum output size.");
    }

    // ---- frames ----------------------------------------------------------------------------------------
    {
        PlanFrame o;
        o.id = ov["id"];
        o.path = framePath(P, ov);
        o.meta = metaFromFrame(ov);
        o.model = FrameModel(pl.ovW, pl.ovH, H3::identity(), overviewRadial(P).k1);
        o.quality = FrameQuality::fromJson(ov["quality"]);
        o.bbox = cv::Rect(0, 0, pl.Ws, pl.Hs);
        pl.frames.push_back(o);
    }
    for (auto& L : accepted) {
        const json& f = *P.frame(L.id);
        PlanFrame pf;
        pf.id = L.id;
        pf.path = framePath(P, f);
        pf.meta = metaFromFrame(f);
        pf.model = L.model;
        pf.mask = L.mask;
        pf.mgw = L.mgw;
        pf.mgh = L.mgh;
        pf.quality = L.quality;
        Pt c = L.model.toCanvas({L.model.w * 0.5, L.model.h * 0.5});
        double m = L.model.scaleAt(c) / S;  // frame px per output px
        pf.reduce = m >= 4.4 ? 4 : (m >= 2.2 ? 2 : 1);
        pl.frames.push_back(pf);
    }
    for (auto& pf : pl.frames) {
        uint64_t h = fileIdentity(pf.path);
        h = fnv1a(pf.model.H.m.data(), sizeof(double) * 9, h);
        h = fnv1a(&pf.model.rad.k1, sizeof(double), h);
        h = fnv1a(&pf.reduce, sizeof(int), h);
        if (!pf.mask.empty()) h = fnv1a(pf.mask.data(), pf.mask.size(), h);
        pf.hash = h;
    }
    {
        uint64_t h = fnv1a(kCoreVersion, strlen(kCoreVersion));
        double g[3] = {pl.S, pl.sx, pl.sy};
        int gi[8] = {pl.W, pl.H, pl.q, pl.block, kMargin, kLevels, kTile, 0};
        h = fnv1a(g, sizeof(g), h);
        h = fnv1a(gi, sizeof(gi), h);
        h = fnv1a(pl.workingSpace.data(), pl.workingSpace.size(), h);
        pl.globalHash = h;
    }
    std::string inputHash = P.inputHash();
    pl.hash = inputHash + "-" + hex64(pl.globalHash);

    // ---- run directory (resume a matching interrupted run) -------------------------------------------
    std::string runId, runDir;
    std::error_code ec;
    for (auto& e : fs::directory_iterator(P.abs("results"), ec)) {
        std::string name = e.path().filename().string();
        if (name.size() > 4 && name.substr(name.size() - 4) == ".tmp") {
            std::string ph = e.path().string() + "/plan.hash";
            if (fileExists(ph) && readFile(ph) == pl.hash && args.value("resume", true)) {
                runId = name.substr(0, name.size() - 4);
                runDir = e.path().string();
            } else {
                fs::remove_all(e.path(), ec);  // stale partial run of a different plan
            }
        }
    }
    bool resumed = !runId.empty();
    if (!resumed) {
        runId = P.newId("r");
        {
            std::lock_guard<std::recursive_mutex> lk(projectMutex());
            Project cur = Project::load(P.dir);
            cur.j["nextId"] = std::max(cur.j.value("nextId", 1), P.j.value("nextId", 1));
            cur.save();
        }
        runDir = P.abs("results/" + runId + ".tmp");
        fs::create_directories(runDir + "/tiles/" + std::to_string(pyr.maxLevel));
    }
    const std::string tilesRoot = runDir + "/tiles";

    // ---- seam-resolution analysis: colour matching + MRF source selection ----------------------------
    const size_t nL = pl.frames.size();
    bool planLoaded = false;
    if (resumed && fileExists(runDir + "/labels.png") && fileExists(runDir + "/plan.bin")) {
        cv::Mat lab = cv::imread(runDir + "/labels.png", cv::IMREAD_UNCHANGED);
        std::ifstream in(runDir + "/plan.bin", std::ios::binary);
        bool ok = !lab.empty() && lab.cols == pl.Ws && lab.rows == pl.Hs && lab.type() == CV_8U && in.good();
        for (size_t l = 1; ok && l < nL; l++) {
            int r[4];
            in.read((char*)r, sizeof(r));
            if (!in || r[2] <= 0 || r[3] <= 0 || r[2] > pl.Ws || r[3] > pl.Hs) {
                ok = false;
                break;
            }
            pl.frames[l].bbox = cv::Rect(r[0], r[1], r[2], r[3]);
            in.read((char*)pl.frames[l].tone, sizeof(pl.frames[l].tone));
            pl.frames[l].gain = cv::Mat(r[3], r[2], CV_32FC3);
            in.read((char*)pl.frames[l].gain.data, (std::streamsize)(pl.frames[l].gain.total() * 12));
            if (!in) ok = false;
        }
        if (ok) {
            pl.detail = cv::Mat(pl.Hs, pl.Ws, CV_32F);
            in.read((char*)pl.detail.data, (std::streamsize)(pl.detail.total() * 4));
            ok = (bool)in;
        }
        if (ok) {
            pl.labels = lab;
            planLoaded = true;
        }
    }
    json warnings = json::array();
    if (!planLoaded) {
        std::vector<SeamLayer> layers(nL);
        ctx.report("Matching exposure and colour", 0.03);
        // overview at seam resolution
        {
            SeamLayer& L0 = layers[0];
            L0.bbox = cv::Rect(0, 0, pl.Ws, pl.Hs);
            warpToSeam(pl, pl.frames[0], L0.bbox, L0.color, L0.valid);
            L0.valid.setTo(255);
            L0.Q = cv::Mat(pl.Hs, pl.Ws, CV_32F, cv::Scalar(1.0f));
            L0.raw = cv::Mat(pl.Hs, pl.Ws, CV_32F, cv::Scalar(1.0f));
        }
        for (size_t l = 1; l < nL; l++) {
            ctx.check();
            ctx.report("Matching exposure and colour", 0.03 + 0.07 * l / nL, "");
            PlanFrame& pf = pl.frames[l];
            SeamLayer& SL = layers[l];
            auto fp = pf.model.footprint();
            double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
            for (auto& p : fp) {
                minx = std::min(minx, p.x * pl.sx / pl.q);
                miny = std::min(miny, p.y * pl.sy / pl.q);
                maxx = std::max(maxx, p.x * pl.sx / pl.q);
                maxy = std::max(maxy, p.y * pl.sy / pl.q);
            }
            cv::Rect bb((int)std::floor(minx) - 1, (int)std::floor(miny) - 1, 0, 0);
            bb.width = (int)std::ceil(maxx) + 1 - bb.x;
            bb.height = (int)std::ceil(maxy) + 1 - bb.y;
            bb &= cv::Rect(0, 0, pl.Ws, pl.Hs);
            if (bb.width < 2 || bb.height < 2) {
                bb = cv::Rect(0, 0, 1, 1);
                SL.bbox = pf.bbox = bb;
                SL.color = cv::Mat(1, 1, CV_32FC3, cv::Scalar(0, 0, 0));
                SL.valid = cv::Mat(1, 1, CV_8U, cv::Scalar(0));
                SL.Q = cv::Mat(1, 1, CV_32F, cv::Scalar(0));
                SL.raw = SL.Q.clone();
                pf.gain = cv::Mat(1, 1, CV_32FC3, cv::Scalar(1, 1, 1));
                continue;
            }
            SL.bbox = pf.bbox = bb;
            warpToSeam(pl, pf, bb, SL.color, SL.valid);
            cv::erode(SL.valid, SL.valid, cv::Mat(), cv::Point(-1, -1), 1, cv::BORDER_CONSTANT, cv::Scalar(0));
            // --- exposure / colour: match the frame's low frequencies to the overview's -----------------
            cv::Mat O = layers[0].color(bb);
            cv::Mat m8 = SL.valid.clone();
            {
                cv::Mat chO[3], chC[3];
                cv::split(O, chO);
                cv::split(SL.color, chC);
                for (int c = 0; c < 3; c++) {
                    m8 &= (chO[c] > 0.03f) & (chO[c] < 0.97f) & (chC[c] > 0.03f) & (chC[c] < 0.97f);
                }
            }
            cv::Mat m;
            m8.convertTo(m, CV_32F, 1.0 / 255);
            cv::Mat m3;
            {
                cv::Mat ch[3] = {m, m, m};
                cv::merge(ch, 3, m3);
            }
            // (1) global per-channel affine tone match (different exposure, white balance, contrast / veiling flare).
            // Fitted on LOW-PASSED images: the overview is blurrier than a close-up, and fitting on fine structure
            // would mistake that loss of detail contrast for a tone difference and flatten the close-up.
            {
                double n = cv::sum(m)[0];
                if (n > 200) {
                    const double ls = std::max(4.0, 0.08 * std::sqrt((double)bb.area()));
                    cv::Mat lc, lo, lm;
                    cv::GaussianBlur(SL.color.mul(m3), lc, cv::Size(0, 0), ls);
                    cv::GaussianBlur(O.mul(m3), lo, cv::Size(0, 0), ls);
                    cv::GaussianBlur(m, lm, cv::Size(0, 0), ls);
                    cv::Mat w8 = lm > 0.5, lm3;
                    {
                        cv::Mat ch[3] = {lm, lm, lm};
                        cv::merge(ch, 3, lm3);
                    }
                    cv::divide(lc, lm3 + cv::Scalar(1e-6, 1e-6, 1e-6), lc);
                    cv::divide(lo, lm3 + cv::Scalar(1e-6, 1e-6, 1e-6), lo);
                    double nw = cv::countNonZero(w8);
                    if (nw > 50) {
                        cv::Scalar mC = cv::mean(lc, w8), mO = cv::mean(lo, w8);
                        cv::Scalar vC = cv::mean(lc.mul(lc), w8), cCO = cv::mean(lc.mul(lo), w8);
                        for (int c = 0; c < 3; c++) {
                            double var = vC[c] - mC[c] * mC[c], cov = cCO[c] - mC[c] * mO[c];
                            double gain = mC[c] > 1e-3 ? clampd(mO[c] / mC[c], 0.5, 2.0) : 1.0;
                            double a = gain, b = 0;
                            // A contrast (slope) change is only applied with strong evidence (large-scale tonal
                            // variation, std > 0.1) and only mildly: vignetting and local lighting otherwise bias the
                            // slope low and would flatten genuine detail contrast.
                            if (var > 0.01) {
                                a = clampd(cov / var, 0.9 * gain, 1.1 * gain);
                                b = clampd(mO[c] - a * mC[c], -0.08, 0.08);
                            }
                            pf.tone[c] = (float)a;
                            pf.tone[3 + c] = (float)b;
                        }
                        SL.color = SL.color.mul(cv::Scalar(pf.tone[0], pf.tone[1], pf.tone[2])) + cv::Scalar(pf.tone[3], pf.tone[4], pf.tone[5]);
                    }
                }
            }
            // (2) smooth residual gain field towards the overview's low frequencies
            cv::Scalar sO = cv::sum(O.mul(m3));
            cv::Scalar sC = cv::sum(SL.color.mul(m3));
            double gg[3];
            double cnt = cv::sum(m)[0];
            for (int c = 0; c < 3; c++) gg[c] = (cnt > 50 && sC[c] > 1e-3) ? clampd(sO[c] / sC[c], 0.4, 2.5) : 1.0;
            double sigma = std::max(3.0, 0.15 * std::sqrt((double)bb.area()));
            cv::Mat num, den, wsum;
            cv::GaussianBlur(O.mul(m3), num, cv::Size(0, 0), sigma);
            cv::GaussianBlur(SL.color.mul(m3), den, cv::Size(0, 0), sigma);
            cv::GaussianBlur(m, wsum, cv::Size(0, 0), sigma);
            pf.gain = cv::Mat(bb.height, bb.width, CV_32FC3);
            for (int y = 0; y < bb.height; y++)
                for (int x = 0; x < bb.width; x++) {
                    cv::Vec3f& g = pf.gain.at<cv::Vec3f>(y, x);
                    const cv::Vec3f& n = num.at<cv::Vec3f>(y, x);
                    const cv::Vec3f& d = den.at<cv::Vec3f>(y, x);
                    float w = wsum.at<float>(y, x);
                    for (int c = 0; c < 3; c++) {
                        double v = gg[c];
                        if (w > 0.1f && d[c] > 1e-3f) v = clampd(n[c] / d[c], gg[c] * 0.75, gg[c] * 1.33);
                        g[c] = (float)v;
                    }
                }
            cv::multiply(SL.color, pf.gain, SL.color);
            double gmean = (pf.tone[0] + pf.tone[1] + pf.tone[2]) / 3 * (gg[0] + gg[1] + gg[2]) / 3;
            if (gmean < 0.7 || gmean > 1.45) warnings.push_back({{"frame", pf.id}, {"code", "exposure_mismatch"}, {"gain", gmean}});
            // --- selection quality: effective detail (sampling x sharpness), capped by the output grid ----
            SL.Q = cv::Mat(bb.height, bb.width, CV_32F, cv::Scalar(0));
            SL.raw = cv::Mat(bb.height, bb.width, CV_32F, cv::Scalar(0));
            const double edge = 0.07 * std::min(pf.model.w, pf.model.h);
            for (int y = 0; y < bb.height; y++)
                for (int x = 0; x < bb.width; x++) {
                    if (!SL.valid.at<uchar>(y, x)) continue;
                    Pt c = seamToCanvas(pl, bb.x + x, bb.y + y);
                    Pt p = pf.model.toFrame(c);
                    double g = detailGain(pf.model.scaleAt(c), pf.quality.sigmaAt(p.x, p.y, pf.model.w, pf.model.h), pl.frames[0].quality.sigmaAt(c.x, c.y, pl.ovW, pl.ovH));
                    double db = std::min({p.x, p.y, pf.model.w - p.x, pf.model.h - p.y});
                    double fall = 0.55 + 0.45 * clampd(db / edge, 0.0, 1.0);
                    SL.raw.at<float>(y, x) = (float)g;
                    // The border fall-off only arbitrates between close-ups. A close-up that locally resolves at
                    // least as much as the overview always beats the overview (which stays the fallback).
                    // (cells where a close-up is measurably blurrier than the overview were masked during verification)
                    double qv = std::max(1.05, std::min(g, S * 1.0) * fall);
                    SL.Q.at<float>(y, x) = (float)qv;
                }
        }
        // user overrides (seam / region): prefer or exclude a source inside a circle (canvas coordinates)
        for (const json& o : P.j["edits"].value("overrides", json::array())) {
            std::string fid = o.value("frame", "");
            int li = -1;
            for (size_t l = 0; l < nL; l++)
                if (pl.frames[l].id == fid || (fid == "overview" && l == 0)) li = (int)l;
            if (li < 0) continue;
            SeamLayer& SL = layers[li];
            double cx = o.value("x", 0.0) * pl.sx / pl.q, cy = o.value("y", 0.0) * pl.sy / pl.q, rr = std::max(1.0, o.value("r", 0.0) * pl.sx / pl.q);
            bool exclude = o.value("mode", "prefer") == "exclude";
            for (int y = std::max(SL.bbox.y, (int)(cy - rr)); y < std::min(SL.bbox.y + SL.bbox.height, (int)(cy + rr) + 1); y++)
                for (int x = std::max(SL.bbox.x, (int)(cx - rr)); x < std::min(SL.bbox.x + SL.bbox.width, (int)(cx + rr) + 1); x++) {
                    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rr * rr) continue;
                    if (exclude) {
                        if (li > 0) SL.valid.at<uchar>(y - SL.bbox.y, x - SL.bbox.x) = 0;
                    } else if (SL.valid.at<uchar>(y - SL.bbox.y, x - SL.bbox.x)) {
                        SL.Q.at<float>(y - SL.bbox.y, x - SL.bbox.x) = (float)(S * 50.0);
                    }
                }
        }
        ctx.check();
        ctx.report("Selecting seams", 0.11);
        SeamSolver solver(layers, pl.Ws, pl.Hs);
        if (nL > 1) {
            for (int sweep = 0; sweep < 2; sweep++) {
                bool any = false;
                for (size_t a = 0; a < nL; a++) {
                    ctx.check();
                    ctx.report("Selecting seams", 0.11 + 0.07 * (sweep * nL + a) / (2.0 * nL));
                    any |= solver.expand((int)a);
                }
                if (!any) break;
            }
        }
        pl.labels = solver.labels;
        pl.detail = cv::Mat(pl.Hs, pl.Ws, CV_32F, cv::Scalar(1.0f));
        for (int y = 0; y < pl.Hs; y++)
            for (int x = 0; x < pl.Ws; x++) {
                int l = pl.labels.at<uchar>(y, x);
                if (l > 0) pl.detail.at<float>(y, x) = std::max(1.0f, std::min((float)S, layers[l].raw.at<float>(y - layers[l].bbox.y, x - layers[l].bbox.x)));
            }
        // persist the plan so that an interrupted run resumes with bit-identical decisions
        cv::imwrite(runDir + "/labels.png", pl.labels);
        {
            std::ofstream out(runDir + "/plan.bin.tmp", std::ios::binary);
            for (size_t l = 1; l < nL; l++) {
                int r[4] = {pl.frames[l].bbox.x, pl.frames[l].bbox.y, pl.frames[l].bbox.width, pl.frames[l].bbox.height};
                out.write((char*)r, sizeof(r));
                out.write((char*)pl.frames[l].tone, sizeof(pl.frames[l].tone));
                cv::Mat g = pl.frames[l].gain.isContinuous() ? pl.frames[l].gain : pl.frames[l].gain.clone();
                out.write((char*)g.data, (std::streamsize)(g.total() * 12));
            }
            out.write((char*)pl.detail.data, (std::streamsize)(pl.detail.total() * 4));
            out.close();
            fs::rename(runDir + "/plan.bin.tmp", runDir + "/plan.bin");
        }
        atomicWriteFile(runDir + "/plan.hash", pl.hash);
    }

    // ---- blocks ---------------------------------------------------------------------------------------
    struct Block {
        cv::Rect core;
        uint64_t hash;
        bool done = false;
    };
    std::vector<Block> blocks;
    for (int y = 0; y < pl.H; y += pl.block)
        for (int x = 0; x < pl.W; x += pl.block) {
            Block b;
            b.core = cv::Rect(x, y, std::min(pl.block, pl.W - x), std::min(pl.block, pl.H - y));
            b.hash = blockHash(pl, b.core);
            blocks.push_back(b);
        }
    json provenance = json::object();
    json blockHashes = json::object();
    std::string journalPath = runDir + "/blocks.jsonl";
    auto blockKey = [&](const Block& b) { return std::to_string(b.core.x) + "_" + std::to_string(b.core.y); };
    // resume: blocks already completed by the interrupted run
    if (resumed && fileExists(journalPath)) {
        std::ifstream in(journalPath);
        std::string line;
        std::map<std::string, json> jr;
        while (std::getline(in, line)) {
            try {
                json e = json::parse(line);
                jr[e["key"].get<std::string>()] = e;
            } catch (...) {
            }
        }
        for (auto& b : blocks) {
            auto it = jr.find(blockKey(b));
            if (it == jr.end() || it->second.value("hash", "") != hex64(b.hash)) continue;
            b.done = true;
            for (auto& kv : it->second["tiles"].items()) provenance[kv.key()] = kv.value();
        }
    }
    // incremental recompute: copy blocks whose inputs are unchanged from the last committed result
    int reused = 0;
    if (!P.j["result"].is_null()) {
        std::string prevDir = P.abs("results/" + P.j["result"].value("runId", ""));
        std::string pm = prevDir + "/manifest.json";
        if (fileExists(pm)) {
            try {
                json prev = json::parse(readFile(pm));
                if (prev.value("width", 0) == pl.W && prev.value("height", 0) == pl.H && prev.value("blockSize", 0) == pl.block) {
                    for (auto& b : blocks) {
                        if (b.done) continue;
                        std::string key = blockKey(b);
                        if (!prev["blocks"].contains(key) || prev["blocks"][key] != hex64(b.hash)) continue;
                        bool ok = true;
                        json tiles = json::object();
                        for (int ty = b.core.y; ty < b.core.y + b.core.height && ok; ty += kTile)
                            for (int tx = b.core.x; tx < b.core.x + b.core.width && ok; tx += kTile) {
                                std::string src = tilePath(prevDir + "/tiles", pyr.maxLevel, tx / kTile, ty / kTile, "png");
                                std::string dst = tilePath(tilesRoot, pyr.maxLevel, tx / kTile, ty / kTile, "png");
                                std::error_code e2;
                                fs::remove(dst, e2);
                                fs::create_hard_link(src, dst, e2);
                                if (e2) {
                                    e2.clear();
                                    fs::copy_file(src, dst, fs::copy_options::overwrite_existing, e2);
                                }
                                if (e2) ok = false;
                                std::string tk = std::to_string(tx / kTile) + "_" + std::to_string(ty / kTile);
                                if (prev["provenance"].contains(tk)) tiles[tk] = prev["provenance"][tk];
                            }
                        if (!ok) continue;
                        b.done = true;
                        reused++;
                        for (auto& kv : tiles.items()) provenance[kv.key()] = kv.value();
                        std::ofstream jo(journalPath, std::ios::app);
                        jo << json{{"key", key}, {"hash", hex64(b.hash)}, {"tiles", tiles}}.dump() << "\n";
                    }
                }
            } catch (...) {
            }
        }
    }

    size_t budget = (size_t)std::max(96, ctx.memoryBudgetMB / 2) << 20;
    ImageCache cache(budget);
    std::mutex mu;
    std::atomic<size_t> next{0};
    std::atomic<int> doneCount{0};
    int already = 0;
    for (auto& b : blocks) already += b.done;
    doneCount = already;
    std::exception_ptr err;
    std::atomic<bool> stop{false};
    int nThreads = std::max(1, std::min(ctx.threads, 8));
    auto worker = [&] {
        try {
            for (;;) {
                size_t i = next.fetch_add(1);
                if (i >= blocks.size() || stop) break;
                Block& b = blocks[i];
                if (b.done) continue;
                ctx.check();
                json prov = json::object();
                cv::Mat img = renderBlock(pl, cache, b.core, &prov);
                for (int ty = 0; ty < b.core.height; ty += kTile)
                    for (int tx = 0; tx < b.core.width; tx += kTile) {
                        cv::Rect t(tx, ty, std::min(kTile, b.core.width - tx), std::min(kTile, b.core.height - ty));
                        writeTile(tilePath(tilesRoot, pyr.maxLevel, (b.core.x + tx) / kTile, (b.core.y + ty) / kTile, "png"), img(t), "png");
                    }
                {
                    std::lock_guard<std::mutex> lk(mu);
                    b.done = true;
                    for (auto& kv : prov.items()) provenance[kv.key()] = kv.value();
                    std::ofstream jo(journalPath, std::ios::app);
                    jo << json{{"key", blockKey(b)}, {"hash", hex64(b.hash)}, {"tiles", prov}}.dump() << "\n";
                    jo.flush();
                    int d = ++doneCount;
                    ctx.report("Rendering detail tiles", 0.18 + 0.67 * d / blocks.size(), std::to_string(d) + " / " + std::to_string(blocks.size()));
                }
            }
        } catch (...) {
            std::lock_guard<std::mutex> lk(mu);
            if (!err) err = std::current_exception();
            stop = true;
        }
    };
    ctx.report("Rendering detail tiles", 0.18 + 0.67 * already / std::max<size_t>(1, blocks.size()), std::to_string(already) + " / " + std::to_string(blocks.size()));
    {
        std::vector<std::thread> th;
        for (int i = 1; i < nThreads; i++) th.emplace_back(worker);
        worker();
        for (auto& t : th) t.join();
    }
    cache.clear();
    if (err) std::rethrow_exception(err);
    for (auto& b : blocks) blockHashes[blockKey(b)] = hex64(b.hash);

    // ---- pyramid ---------------------------------------------------------------------------------------
    buildLowerLevels(tilesRoot, pyr, "png", ctx, "Building zoom pyramid", 0.85, 0.96);
    writeDzi(runDir + "/result.dzi", pyr, "png");
    ctx.check();
    ctx.report("Finalizing", 0.97);

    // ---- overview layer on the canvas (only needed when the overview itself was undistorted) ----------
    std::string overviewBase;
    if (std::abs(pl.frames[0].model.rad.k1) > 1e-9) {
        Plan p1 = pl;
        p1.sx = p1.sy = p1.S = 1;
        ImageCache c2(256u << 20);
        cv::Mat full;
        renderSource(p1, pl.frames[0], c2, cv::Rect(0, 0, pl.ovW, pl.ovH), cv::INTER_CUBIC, full, nullptr);
        cv::Mat f8;
        full.convertTo(f8, CV_8UC3);
        cv::imwrite(runDir + "/overview_canvas.png", f8, {cv::IMWRITE_PNG_COMPRESSION, 1});
        overviewBase = "overview_canvas.png";
    }

    // ---- statistics: output size vs. estimated genuine detail ------------------------------------------
    cv::Mat det8;
    pl.detail.convertTo(det8, CV_8U, 32.0);
    cv::imwrite(runDir + "/detail.png", det8);
    double areaTot = (double)pl.Ws * pl.Hs, effMP = 0, areaClose = 0;
    json hist = json::object();
    for (int y = 0; y < pl.Hs; y++)
        for (int x = 0; x < pl.Ws; x++) {
            float g = pl.detail.at<float>(y, x);
            effMP += double(g) * g;
            if (pl.labels.at<uchar>(y, x) > 0) areaClose++;
        }
    effMP = effMP / areaTot * (double(pl.ovW) * pl.ovH) / 1e6;
    for (double t : {1.5, 2.0, 3.0, 4.0, 6.0}) {
        char key[32];
        snprintf(key, sizeof(key), "ge%.1f", t);
        hist[key] = cv::countNonZero(pl.detail >= t) / areaTot;
    }
    std::vector<int> labelArea(nL, 0);
    for (int y = 0; y < pl.Hs; y++)
        for (int x = 0; x < pl.Ws; x++) labelArea[pl.labels.at<uchar>(y, x)]++;
    json framesJ = json::array();
    for (size_t l = 0; l < nL; l++) {
        const PlanFrame& pf = pl.frames[l];
        json fj = {{"label", (int)l}, {"id", pf.id}, {"H", pf.model.H.toJson()}, {"k1", pf.model.rad.k1}, {"width", pf.model.w}, {"height", pf.model.h},
                   {"areaFrac", labelArea[l] / areaTot}, {"reduce", pf.reduce}};
        if (l > 0) {
            Pt c = pf.model.toCanvas({pf.model.w * 0.5, pf.model.h * 0.5});
            fj["scale"] = pf.model.scaleAt(c);
            fj["sharpSigma"] = pf.quality.sharpSigma;
        }
        framesJ.push_back(fj);
    }
    json manifest = {
        {"format", "detailed-capture-result"}, {"version", 1}, {"coreVersion", kCoreVersion}, {"runId", runId}, {"createdAt", nowIso()},
        {"width", pl.W}, {"height", pl.H}, {"scale", pl.S}, {"scaleX", pl.sx}, {"scaleY", pl.sy},
        {"overviewWidth", pl.ovW}, {"overviewHeight", pl.ovH}, {"overviewK1", pl.frames[0].model.rad.k1},
        {"tileSize", kTile}, {"tileFormat", "png"}, {"maxLevel", pyr.maxLevel}, {"tiles", "tiles"}, {"dzi", "result.dzi"},
        {"blockSize", pl.block}, {"seamScale", pl.q}, {"labels", "labels.png"}, {"detailMap", "detail.png"}, {"detailMapScale", 32.0},
        {"overviewBase", overviewBase.empty() ? json(nullptr) : json(overviewBase)},
        {"colorSpace", pl.workingSpace.empty() ? "unknown (as overview)" : pl.workingSpace}, {"bitDepth", 8},
        {"frames", framesJ}, {"provenance", provenance}, {"blocks", blockHashes}, {"inputHash", inputHash}, {"planHash", pl.hash},
        {"warnings", warnings},
        {"stats",
         {{"outputMP", double(pl.W) * pl.H / 1e6},
          {"overviewMP", double(pl.ovW) * pl.ovH / 1e6},
          {"estimatedDetailMP", effMP},
          {"closeupAreaFrac", areaClose / areaTot},
          {"detailHistogram", hist},
          {"framesUsed", (int)nL - 1},
          {"blocks", (int)blocks.size()},
          {"blocksReused", reused},
          {"blocksResumed", already - reused},
          {"ms", nowMs() - t0},
          {"threads", nThreads}}},
        {"note", "Pixel dimensions are not a measure of detail: 'estimatedDetailMP' and 'detailHistogram' estimate genuine captured detail "
                 "from source sampling density and measured sharpness. Areas with label 0 are the enlarged overview (no added detail)."}};
    atomicWriteFile(runDir + "/manifest.json", manifest.dump(1));

    // ---- atomic commit: the previous result stays valid until this rename succeeds --------------------
    std::string finalDir = P.abs("results/" + runId);
    fs::rename(runDir, finalDir, ec);
    if (ec) throw UserError("io", "Could not finalize the result.");
    json summary = {{"runId", runId}, {"width", pl.W}, {"height", pl.H}, {"scale", pl.S}, {"inputHash", inputHash}, {"stale", false},
                    {"stats", manifest["stats"]}, {"createdAt", manifest["createdAt"]}, {"maxLevel", pyr.maxLevel}};
    std::string oldRun;
    {
        std::lock_guard<std::recursive_mutex> lk(projectMutex());
        Project cur = Project::load(P.dir);
        if (!cur.j["result"].is_null()) oldRun = cur.j["result"].value("runId", "");
        summary["stale"] = cur.inputHash() != inputHash;
        cur.j["result"] = summary;
        cur.save();
        P0 = cur;
    }
    if (!oldRun.empty() && oldRun != runId) fs::remove_all(P.abs("results/" + oldRun), ec);
    ctx.report("Finalizing", 1.0);
    return summary;
}

}  // namespace dc
