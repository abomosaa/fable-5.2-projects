// Registration graph: overview anchoring, neighbour edges, chain placement, global refinement, dense
// verification, per-frame classification and the coverage (effective detail) map.
#include "dc/ba.h"
#include "dc/project.h"
#include <opencv2/calib3d.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <filesystem>
#include <map>
#include <mutex>
#include <set>

namespace fs = std::filesystem;

namespace dc {

namespace {
const int kOverviewWorkDim = 4096, kOverviewMaxFeat = 40000;
const int kFrameWorkDim = 2000, kFrameMaxFeat = 5000;
const double kMinGain = 1.15;

struct Session {
    std::string ovId;
    std::shared_ptr<Features> ovFeat;
    cv::Mat ovGray;  // full-resolution oriented overview (CV_8U)
};
std::mutex g_mu;
std::map<std::string, std::shared_ptr<Session>> g_sessions;

std::shared_ptr<Session> getSession(Project& P, const Ctx& ctx, bool needGray) {
    json* ov = P.overview();
    if (!ov) throw UserError("no_overview", "Add an overview photo first.");
    std::string ovId = (*ov)["id"];
    std::shared_ptr<Session> s;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        auto it = g_sessions.find(P.dir);
        if (it != g_sessions.end() && it->second->ovId == ovId) s = it->second;
        else {
            s = std::make_shared<Session>();
            s->ovId = ovId;
            g_sessions[P.dir] = s;
        }
    }
    ImageMeta meta = metaFromFrame(*ov);
    if (!s->ovFeat) {
        auto F = std::make_shared<Features>();
        std::string cache = P.abs("work/" + ovId + ".feat");
        if (!Features::load(cache, *F)) {
            ctx.report("Analyzing overview", 0.02);
            cv::Mat g = loadOrientedGray(framePath(P, *ov), meta, 1);
            *F = extractFeatures(g, kOverviewWorkDim, kOverviewMaxFeat, &ctx);
            F->save(cache);
            if (s->ovGray.empty()) s->ovGray = g;
        }
        s->ovFeat = F;
    }
    if (needGray && s->ovGray.empty()) s->ovGray = loadOrientedGray(framePath(P, *ov), meta, 1);
    return s;
}

std::shared_ptr<Features> frameFeatures(Project& P, const json& f, const Ctx& ctx) {
    auto F = std::make_shared<Features>();
    std::string cache = P.abs("work/" + f["id"].get<std::string>() + ".feat");
    if (Features::load(cache, *F)) return F;
    cv::Mat g = loadOrientedGray(framePath(P, f), metaFromFrame(f), 1);
    *F = extractFeatures(g, kFrameWorkDim, kFrameMaxFeat, &ctx);
    F->save(cache);
    return F;
}

std::vector<cv::Point2f> quadPts(const std::array<Pt, 4>& q) {
    std::vector<cv::Point2f> v;
    for (auto& p : q) v.emplace_back((float)p.x, (float)p.y);
    return v;
}
double quadArea(const std::array<Pt, 4>& q) { return std::abs(polygonArea({q[0], q[1], q[2], q[3]})); }
double overlapFrac(const std::array<Pt, 4>& a, const std::array<Pt, 4>& b) {
    std::vector<cv::Point2f> inter;
    double ia = 0;
    try {
        ia = cv::intersectConvexConvex(quadPts(a), quadPts(b), inter, true);
    } catch (const cv::Exception&) {
        ia = 0;
    }
    double m = std::min(quadArea(a), quadArea(b));
    return m > 0 ? ia / m : 0;
}
std::array<Pt, 4> footprintOf(const H3& H, int w, int h) { return {H.apply(0, 0), H.apply(w, 0), H.apply(w, h), H.apply(0, h)}; }

// ------------------------------------------------------------------------------------- dense verification
struct Verify {
    bool valid = false;
    double zncc = -1, texturedFrac = 0, exposureRatio = 1;
    int gw = 16, gh = 12;
    std::vector<uint8_t> bad;
    double maskedFrac = 0;
    int softCells = 0;  // cells masked because the close-up is blurrier than the overview there
    double mad = 0;     // mean absolute grey difference to the overview after exposure normalisation
};

Verify verifyDense(const cv::Mat& ovGray, const Radial& ovRad, const std::string& path, const ImageMeta& meta, const FrameModel& fm) {
    Verify V;
    V.gh = std::max(4, std::min(32, (int)std::lround(16.0 * fm.h / fm.w)));
    V.bad.assign(V.gw * V.gh, 0);
    auto fp = fm.footprint();
    double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
    for (auto& p : fp) {
        minx = std::min(minx, p.x);
        miny = std::min(miny, p.y);
        maxx = std::max(maxx, p.x);
        maxy = std::max(maxy, p.y);
    }
    int x0 = std::max(0, (int)std::floor(minx)), y0 = std::max(0, (int)std::floor(miny));
    int x1 = std::min(ovGray.cols, (int)std::ceil(maxx)), y1 = std::min(ovGray.rows, (int)std::ceil(maxy));
    if (x1 - x0 < 24 || y1 - y0 < 24) return V;
    int step = std::max(1, (int)std::ceil(std::max(x1 - x0, y1 - y0) / 900.0));
    int rw = (x1 - x0) / step, rh = (y1 - y0) / step;
    if (rw < 24 || rh < 24) return V;
    Pt cc{(minx + maxx) / 2, (miny + maxy) / 2};
    double s = fm.scaleAt(cc);  // frame px per canvas px
    int red = 1;
    for (int r : {8, 4, 2})
        if (r <= s * step) {
            red = r;
            break;
        }
    cv::Mat fg = loadOrientedGray(path, meta, red);
    double minif = s * step / red;
    if (minif > 1.15) cv::GaussianBlur(fg, fg, cv::Size(0, 0), 0.45 * minif);
    cv::Mat mapx(rh, rw, CV_32F), mapy(rh, rw, CV_32F), omx(rh, rw, CV_32F), omy(rh, rw, CV_32F);
    cv::Mat valid(rh, rw, CV_8U);
    for (int y = 0; y < rh; y++) {
        float* mx = mapx.ptr<float>(y);
        float* my = mapy.ptr<float>(y);
        float* ox = omx.ptr<float>(y);
        float* oy = omy.ptr<float>(y);
        uchar* vv = valid.ptr<uchar>(y);
        for (int x = 0; x < rw; x++) {
            Pt c{x0 + (x + 0.5) * step, y0 + (y + 0.5) * step};
            Pt p = fm.toFrame(c);
            vv[x] = (p.x >= 1 && p.y >= 1 && p.x <= fm.w - 1 && p.y <= fm.h - 1) ? 255 : 0;
            mx[x] = (float)(p.x / red - 0.5);
            my[x] = (float)(p.y / red - 0.5);
            Pt o = ovRad.distort(c);
            ox[x] = (float)(o.x - 0.5);
            oy[x] = (float)(o.y - 0.5);
        }
    }
    cv::Mat a, b, og = ovGray;
    if (step > 1) {
        cv::Mat tmp;
        cv::GaussianBlur(ovGray(cv::Rect(x0, y0, x1 - x0, y1 - y0)), tmp, cv::Size(0, 0), 0.45 * step);
        og = cv::Mat(ovGray.size(), CV_8U, cv::Scalar(0));
        tmp.copyTo(og(cv::Rect(x0, y0, x1 - x0, y1 - y0)));
    }
    cv::remap(fg, a, mapx, mapy, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    cv::remap(og, b, omx, omy, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    a.convertTo(a, CV_32F);
    b.convertTo(b, CV_32F);
    // gradient energy at overview resolution (before the robustness blur): is the close-up, reduced to the
    // overview's resolution, at least as detailed as the overview itself?
    cv::Mat gea, geb, a0 = a.clone(), b0 = b.clone();
    {
        cv::Mat gx, gy;
        cv::Sobel(a, gx, CV_32F, 1, 0, 3, 1.0 / 8);
        cv::Sobel(a, gy, CV_32F, 0, 1, 3, 1.0 / 8);
        gea = gx.mul(gx) + gy.mul(gy);
        cv::Sobel(b, gx, CV_32F, 1, 0, 3, 1.0 / 8);
        cv::Sobel(b, gy, CV_32F, 0, 1, 3, 1.0 / 8);
        geb = gx.mul(gx) + gy.mul(gy);
    }
    cv::GaussianBlur(a, a, cv::Size(0, 0), 1.5);
    cv::GaussianBlur(b, b, cv::Size(0, 0), 1.5);
    cv::Mat m;
    valid.convertTo(m, CV_32F, 1.0 / 255);
    const cv::Size win(15, 15);
    auto box = [&](const cv::Mat& src) {
        cv::Mat d;
        cv::boxFilter(src, d, CV_32F, win, cv::Point(-1, -1), true, cv::BORDER_REFLECT);
        return d;
    };
    cv::Mat wm = box(m), ma = box(a.mul(m)), mb = box(b.mul(m)), maa = box(a.mul(a).mul(m)), mbb = box(b.mul(b).mul(m)), mab = box(a.mul(b).mul(m));
    cv::Mat zn(rh, rw, CV_32F, cv::Scalar(0)), tex(rh, rw, CV_8U, cv::Scalar(0));
    // structure present in one image but absent in the other (e.g. a flat side wall of a raised object where the
    // overview shows a textured surface): ZNCC is undefined there, so it is tracked separately
    cv::Mat oneSided(rh, rw, CV_32F, cv::Scalar(0));
    std::vector<float> vals;
    double sa = 0, sb = 0;
    int nv = 0;
    for (int y = 0; y < rh; y++)
        for (int x = 0; x < rw; x++) {
            float w = wm.at<float>(y, x);
            if (w < 0.95f || !valid.at<uchar>(y, x)) continue;
            nv++;
            float ea = ma.at<float>(y, x) / w, eb = mb.at<float>(y, x) / w;
            sa += ea;
            sb += eb;
            float va = maa.at<float>(y, x) / w - ea * ea, vb = mbb.at<float>(y, x) / w - eb * eb, cab = mab.at<float>(y, x) / w - ea * eb;
            if ((va < 16.f && vb >= 100.f) || (vb < 16.f && va >= 100.f)) oneSided.at<float>(y, x) = 1.f;
            if (va < 16.f || vb < 16.f) continue;  // needs real texture (std >= 4 grey levels) in both images
            float z = cab / std::sqrt(va * vb);
            zn.at<float>(y, x) = z;
            tex.at<uchar>(y, x) = 255;
            vals.push_back(z);
        }
    if (nv < 200) return V;
    V.valid = true;
    V.texturedFrac = double(vals.size()) / nv;
    V.exposureRatio = sb > 1 ? sa / sb : 1.0;
    {
        // mean absolute difference after exposure normalisation (also sees flat, texture-free landmarks)
        cv::Mat d;
        cv::absdiff(a * (sa > 1 ? sb / sa : 1.0), b, d);
        V.mad = cv::mean(d, valid)[0];
    }
    if (vals.size() >= 100) {
        std::nth_element(vals.begin(), vals.begin() + vals.size() / 2, vals.end());
        V.zncc = vals[vals.size() / 2];
    }
    // per frame-cell consistency: mean ZNCC of textured pixels inside the cell's canvas footprint
    cv::Mat texF;
    tex.convertTo(texF, CV_32F, 1.0 / 255);
    cv::Mat znSum, texSum, geaSum, gebSum;
    cv::integral(zn, znSum, CV_64F);
    cv::integral(texF, texSum, CV_64F);
    cv::Mat oneSum;
    cv::integral(oneSided, oneSum, CV_64F);
    const double normAB = sa > 1 ? sb / sa : 1.0;  // brings the close-up to the overview's exposure
    cv::integral(gea, geaSum, CV_64F);
    cv::integral(geb, gebSum, CV_64F);
    cv::Mat aSum, bSum, aaSum, bbSum;
    cv::integral(a0, aSum, aaSum, CV_64F, CV_64F);
    cv::integral(b0, bSum, bbSum, CV_64F, CV_64F);
    int nBad = 0, nCells = 0;
    for (int cy = 0; cy < V.gh; cy++)
        for (int cx = 0; cx < V.gw; cx++) {
            Pt c0 = fm.toCanvas({(cx + 0.0) * fm.w / V.gw, (cy + 0.0) * fm.h / V.gh}), c1 = fm.toCanvas({(cx + 1.0) * fm.w / V.gw, (cy + 1.0) * fm.h / V.gh});
            Pt c2 = fm.toCanvas({(cx + 1.0) * fm.w / V.gw, (cy + 0.0) * fm.h / V.gh}), c3 = fm.toCanvas({(cx + 0.0) * fm.w / V.gw, (cy + 1.0) * fm.h / V.gh});
            double bx0 = std::min({c0.x, c1.x, c2.x, c3.x}), bx1 = std::max({c0.x, c1.x, c2.x, c3.x});
            double by0 = std::min({c0.y, c1.y, c2.y, c3.y}), by1 = std::max({c0.y, c1.y, c2.y, c3.y});
            int rx0 = std::max(0, (int)std::floor((bx0 - x0) / step)), rx1 = std::min(rw, (int)std::ceil((bx1 - x0) / step));
            int ry0 = std::max(0, (int)std::floor((by0 - y0) / step)), ry1 = std::min(rh, (int)std::ceil((by1 - y0) / step));
            if (rx1 - rx0 < 2 || ry1 - ry0 < 2) continue;
            auto rs = [&](const cv::Mat& I) { return I.at<double>(ry1, rx1) - I.at<double>(ry0, rx1) - I.at<double>(ry1, rx0) + I.at<double>(ry0, rx0); };
            double nt = rs(texSum), area = double(rx1 - rx0) * (ry1 - ry0);
            nCells++;
            // one image has structure here and the other is flat, or the two differ strongly in brightness after
            // exposure normalisation (e.g. a dark side wall where the overview shows a bright surface): content differs
            const double meanA = rs(aSum) / std::max(1.0, area) * normAB, meanB = rs(bSum) / std::max(1.0, area);
            if (rs(oneSum) > 0.30 * area || std::abs(meanA - meanB) > 30.0) {
                V.bad[cy * V.gw + cx] = 1;
                nBad++;
                continue;
            }
            if (nt < 0.15 * area || nt < 12) continue;  // not enough texture to judge
            double mz = rs(znSum) / nt;
            // content disagrees, or the close-up is clearly blurrier here than the overview (local defocus)
            // "sharpness index" = gradient energy relative to local contrast; invariant to exposure / tone curve
            double areaN = std::max(1.0, area);
            double va = rs(aaSum) / areaN - (rs(aSum) / areaN) * (rs(aSum) / areaN), vb = rs(bbSum) / areaN - (rs(bSum) / areaN) * (rs(bSum) / areaN);
            bool softer = va > 16 && vb > 64 && (rs(geaSum) / va) < 0.30 * (rs(gebSum) / vb);
            if (mz < 0.30 || softer) {
                V.bad[cy * V.gw + cx] = 1;
                nBad++;
                if (softer && mz >= 0.30) V.softCells++;
            }
        }
    V.maskedFrac = nCells ? double(nBad) / nCells : 0;
    return V;
}

// ------------------------------------------------------------------------------------- dense refinement
// Block matching of the (warped, down-sampled) frame against the overview. Unlike sparse features, a block
// of several text lines / pattern elements is only weakly ambiguous inside a small search radius, so this
// corrects mild false alignments and yields dense, evenly distributed anchor correspondences.
struct Dense {
    bool ok = false;
    H3 H;
    std::vector<Pt> pf, po;  // inlier correspondences: frame px <-> canvas px
    int matched = 0, inliers = 0, step = 1;
    json toJson() const {
        json a = json::array(), b = json::array();
        for (size_t i = 0; i < pf.size(); i++) {
            a.push_back({std::round(pf[i].x * 100) / 100, std::round(pf[i].y * 100) / 100});
            b.push_back({std::round(po[i].x * 1000) / 1000, std::round(po[i].y * 1000) / 1000});
        }
        return json{{"ok", ok}, {"H", H.toJson()}, {"pf", a}, {"po", b}, {"matched", matched}, {"inliers", inliers}, {"step", step}};
    }
    static Dense fromJson(const json& j) {
        Dense d;
        d.ok = j.value("ok", false);
        d.H = H3::fromJson(j.at("H"));
        for (auto& p : j.at("pf")) d.pf.push_back({p[0].get<double>(), p[1].get<double>()});
        for (auto& p : j.at("po")) d.po.push_back({p[0].get<double>(), p[1].get<double>()});
        d.matched = j.value("matched", 0);
        d.inliers = j.value("inliers", 0);
        d.step = j.value("step", 1);
        return d;
    }
};

Dense denseRefine(const cv::Mat& ovGray, const std::string& path, const ImageMeta& meta, int fw, int fh, const H3& H0) {
    Dense D;
    D.H = H0;
    H3 H = H0;
    cv::Mat fgRaw;
    int fgRed = 0;
    for (int iter = 0; iter < 2; iter++) {
        FrameModel fm(fw, fh, H, 0.0);
        auto fp = fm.footprint();
        double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
        for (auto& p : fp) {
            minx = std::min(minx, p.x);
            miny = std::min(miny, p.y);
            maxx = std::max(maxx, p.x);
            maxy = std::max(maxy, p.y);
        }
        int x0 = std::max(0, (int)std::floor(minx)), y0 = std::max(0, (int)std::floor(miny));
        int x1 = std::min(ovGray.cols, (int)std::ceil(maxx)), y1 = std::min(ovGray.rows, (int)std::ceil(maxy));
        if (x1 - x0 < 96 || y1 - y0 < 96) break;
        int step = std::max(1, (int)std::ceil(std::max(x1 - x0, y1 - y0) / 1400.0));
        int rw = (x1 - x0) / step, rh = (y1 - y0) / step;
        if (rw < 96 || rh < 96) break;
        double s = fm.scaleAt({(minx + maxx) / 2, (miny + maxy) / 2});
        int red = 1;
        for (int r : {8, 4, 2})
            if (r <= s * step) {
                red = r;
                break;
            }
        if (fgRed != red) {
            fgRaw = loadOrientedGray(path, meta, red);
            fgRed = red;
        }
        cv::Mat fg = fgRaw;
        double minif = s * step / red;
        if (minif > 1.15) cv::GaussianBlur(fgRaw, fg, cv::Size(0, 0), 0.45 * minif);
        cv::Mat mapx(rh, rw, CV_32F), mapy(rh, rw, CV_32F), valid(rh, rw, CV_8U);
        cv::parallel_for_(cv::Range(0, rh), [&](const cv::Range& rg) {
            for (int y = rg.start; y < rg.end; y++) {
                float* mx = mapx.ptr<float>(y);
                float* my = mapy.ptr<float>(y);
                uchar* vv = valid.ptr<uchar>(y);
                for (int x = 0; x < rw; x++) {
                    Pt p = fm.toFrame({x0 + (x + 0.5) * step, y0 + (y + 0.5) * step});
                    vv[x] = (p.x >= 1 && p.y >= 1 && p.x <= fw - 1 && p.y <= fh - 1) ? 255 : 0;
                    mx[x] = (float)(p.x / red - 0.5);
                    my[x] = (float)(p.y / red - 0.5);
                }
            }
        });
        cv::Mat a, b;
        cv::remap(fg, a, mapx, mapy, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
        cv::Mat ovc = ovGray(cv::Rect(x0, y0, rw * step, rh * step));
        if (step > 1) cv::resize(ovc, b, cv::Size(rw, rh), 0, 0, cv::INTER_AREA);
        else b = ovc;
        a.convertTo(a, CV_32F);
        b.convertTo(b, CV_32F);
        cv::GaussianBlur(a, a, cv::Size(0, 0), 1.0);
        cv::GaussianBlur(b, b, cv::Size(0, 0), 1.0);
        cv::Mat vint;
        cv::integral(valid, vint, CV_32S);
        const int B = 48, stride = 32, R = iter == 0 ? 12 : 5;
        std::vector<cv::Point2f> pf, po;
        for (int by = R; by + B + R <= rh; by += stride)
            for (int bx = R; bx + B + R <= rw; bx += stride) {
                int nv = vint.at<int>(by + B, bx + B) - vint.at<int>(by, bx + B) - vint.at<int>(by + B, bx) + vint.at<int>(by, bx);
                if (nv != 255 * B * B) continue;
                cv::Mat t = a(cv::Rect(bx, by, B, B));
                cv::Scalar mu, sd;
                cv::meanStdDev(t, mu, sd);
                if (sd[0] < 3.0) continue;
                cv::Mat res;
                cv::matchTemplate(b(cv::Rect(bx - R, by - R, B + 2 * R, B + 2 * R)), t, res, cv::TM_CCOEFF_NORMED);
                double p1;
                cv::Point loc;
                cv::minMaxLoc(res, nullptr, &p1, nullptr, &loc);
                if (p1 < 0.5) continue;
                // ambiguity: a second, separate peak that is almost as good (repeating structure)
                cv::Mat r2 = res.clone();
                cv::rectangle(r2, cv::Rect(loc.x - 3, loc.y - 3, 7, 7) & cv::Rect(0, 0, r2.cols, r2.rows), cv::Scalar(-1), cv::FILLED);
                double p2;
                cv::minMaxLoc(r2, nullptr, &p2);
                if (p2 > p1 - 0.04 && p2 > 0.5) continue;
                double dx = loc.x, dy = loc.y;
                if (loc.x > 0 && loc.x < res.cols - 1) {
                    double l = res.at<float>(loc.y, loc.x - 1), c = p1, r = res.at<float>(loc.y, loc.x + 1), den = l - 2 * c + r;
                    if (den < -1e-6) dx += 0.5 * (l - r) / den;
                }
                if (loc.y > 0 && loc.y < res.rows - 1) {
                    double l = res.at<float>(loc.y - 1, loc.x), c = p1, r = res.at<float>(loc.y + 1, loc.x), den = l - 2 * c + r;
                    if (den < -1e-6) dy += 0.5 * (l - r) / den;
                }
                Pt c{x0 + (bx + B * 0.5) * step, y0 + (by + B * 0.5) * step};
                Pt f = fm.toFrame(c);
                pf.emplace_back((float)f.x, (float)f.y);
                po.emplace_back((float)(c.x + (dx - R) * step), (float)(c.y + (dy - R) * step));
            }
        D.matched = (int)pf.size();
        D.step = step;
        if (pf.size() < 12) break;
        cv::Mat mask, M;
        try {
            M = cv::findHomography(pf, po, cv::USAC_MAGSAC, 1.5 * step, mask, 3000, 0.999);
        } catch (const cv::Exception&) {
            break;
        }
        if (M.empty()) break;
        H3 Hn = H3::fromCv(M).normalized();
        std::vector<Pt> ia, ib;
        for (size_t i = 0; i < pf.size(); i++) {
            Pt q = Hn.apply(pf[i].x, pf[i].y);
            if (std::hypot(q.x - po[i].x, q.y - po[i].y) <= 1.5 * step) {
                ia.push_back({pf[i].x, pf[i].y});
                ib.push_back({po[i].x, po[i].y});
            }
        }
        if ((int)ia.size() < std::max(10, (int)(0.45 * pf.size())) || !validateHomography(Hn, fw, fh).ok) break;
        if (hullArea(ia) < 0.12 * double(fw) * fh) break;
        H = Hn;
        D.ok = true;
        D.H = Hn;
        D.pf = ia;
        D.po = ib;
        D.inliers = (int)ia.size();
    }
    return D;
}

struct Node {
    json* f = nullptr;
    std::string id, name;
    int w = 0, h = 0;
    std::shared_ptr<Features> feat;
    PairResult direct;
    bool placed = false;
    H3 H;
    std::string via;
    bool usedHint = false, manual = false;
    int consistentEdges = 0, conflictEdges = 0;
    std::vector<double> planar;  // planarRatio of edges with enough epipolar support
    std::vector<Pt> offPlane, inPlane;
    int group = -1;
    double pairRms = 0, anchorRms = 0;
    int nPairObs = 0, nAnchorObs = 0;
    Dense dense;
};

std::string manualSig(const json& f) {
    std::string s = f["user"].value("manualPoints", json::array()).dump() + f.value("hint", json()).dump();
    char buf[32];
    snprintf(buf, sizeof(buf), "%016llx", (unsigned long long)fnv1a(s.data(), s.size()));
    return buf;
}
}  // namespace

void dropSessionCaches(const std::string& dir) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (dir.empty()) g_sessions.clear();
    else g_sessions.erase(dir);
}

// ============================================================================================ register
json registerProject(Project& P, const json& args, const Ctx& ctx) {
    int64_t t0 = nowMs();
    auto S = getSession(P, ctx, true);
    json& ov = *P.overview();
    const int ovW = ov["meta"]["width"], ovH = ov["meta"]["height"];
    const Features& OF = *S->ovFeat;

    // pair cache
    std::string cachePath = P.abs("work/regcache.json");
    json cache = json::object();
    if (!args.value("full", false) && fileExists(cachePath)) {
        try {
            cache = json::parse(readFile(cachePath));
        } catch (...) {
            cache = json::object();
        }
    }

    std::vector<Node> nodes;
    for (json* fp : P.closeups()) {
        if (!(*fp)["user"].value("included", true)) continue;
        Node n;
        n.f = fp;
        n.id = (*fp)["id"];
        n.name = (*fp).value("originalName", "");
        if (n.name.empty()) n.name = "photo " + std::to_string(nodes.size() + 1);
        n.w = (*fp)["meta"]["width"];
        n.h = (*fp)["meta"]["height"];
        nodes.push_back(std::move(n));
    }
    const int N = (int)nodes.size();
    std::map<std::string, int> lensGroups;
    auto groupOf = [&](const json& f) {
        std::string g = f.value("lensGroup", "");
        if (!lensGroups.count(g)) lensGroups[g] = (int)lensGroups.size();
        return lensGroups[g];
    };

    // ---- 1. features -------------------------------------------------------------------------------
    for (int i = 0; i < N; i++) {
        ctx.check();
        ctx.report("Extracting features", 0.05 + 0.35 * i / std::max(1, N), nodes[i].name);
        nodes[i].feat = frameFeatures(P, *nodes[i].f, ctx);
        nodes[i].group = groupOf(*nodes[i].f);
    }
    int ovGroup = -1;
    {
        std::string g = ov.value("lensGroup", "");
        if (lensGroups.count(g)) ovGroup = lensGroups[g];
    }

    // ---- 2. direct overview matches ----------------------------------------------------------------
    for (int i = 0; i < N; i++) {
        ctx.check();
        ctx.report("Matching to overview", 0.40 + 0.15 * i / std::max(1, N), nodes[i].name);
        Node& n = nodes[i];
        json& f = *n.f;
        std::string key = n.id + ">ov", sig = manualSig(f);
        if (cache.contains(key) && cache[key].value("sig", "") == sig) {
            n.direct = PairResult::fromJson(cache[key]["pr"]);
            n.usedHint = cache[key].value("usedHint", false);
            n.manual = cache[key].value("manual", false);
            n.via = cache[key].value("via", "overview");
            continue;
        }
        const json& mp = f["user"]["manualPoints"];
        PairResult pr;
        n.via = "overview";
        if (mp.is_array() && mp.size() >= 4) {
            std::vector<Pt> a, b;
            for (auto& m : mp) {
                a.push_back({m["fx"].get<double>(), m["fy"].get<double>()});
                b.push_back({m["ox"].get<double>(), m["oy"].get<double>()});
            }
            H3 Hm;
            double rms = 0;
            n.manual = true;
            if (homographyFromPoints(a, b, Hm, rms) && validateHomography(Hm, n.w, n.h).ok) {
                PairOptions po;
                po.havePrior = true;
                po.prior = Hm;
                po.priorRadius = std::max(16.0, 0.012 * std::hypot((double)ovW, (double)ovH));
                po.requireAinsideB = true;
                po.minInliers = 10;
                pr = estimatePair(*n.feat, OF, po);
                if (pr.ok) n.via = "manual+refine";
                else {
                    pr = PairResult();
                    pr.ok = true;
                    pr.H = Hm;
                    pr.nInliers = (int)a.size();
                    pr.nPutative = (int)a.size();
                    pr.rms = rms;
                    pr.inA = a;
                    pr.inB = b;
                    pr.scale = validateHomography(Hm, n.w, n.h).scale;
                    pr.hullFrac = hullArea(a) / (double(n.w) * n.h);
                    n.via = "manual";
                }
            } else {
                pr.fail = "degenerate";
                n.via = "manual";
            }
        } else {
            PairOptions po;
            po.requireAinsideB = true;
            if (f.contains("hint") && f["hint"].is_object()) {
                const json& h = f["hint"];
                double hx = h["x"], hy = h["y"], hw = h["w"], hh = h["h"];
                double ex = std::max(0.6 * hw, 0.08 * ovW), ey = std::max(0.6 * hh, 0.08 * ovH);
                po.restrict = true;
                po.restrictB = cv::Rect2d(hx - ex, hy - ey, hw + 2 * ex, hh + 2 * ey);
                pr = estimatePair(*n.feat, OF, po);
                n.usedHint = pr.ok;
                if (!pr.ok) {
                    po.restrict = false;
                    PairResult pr2 = estimatePair(*n.feat, OF, po);
                    if (pr2.ok || pr2.nInliers > pr.nInliers) pr = pr2;
                }
            } else {
                pr = estimatePair(*n.feat, OF, po);
            }
        }
        n.direct = pr;
        cache[key] = {{"sig", sig}, {"pr", pr.toJson()}, {"usedHint", n.usedHint}, {"manual", n.manual}, {"via", n.via}};
    }

    // ---- 3. neighbour edges + placement --------------------------------------------------------------
    std::map<std::pair<int, int>, PairResult> edges;  // key (a<b): a -> b
    auto edge = [&](int a, int b) -> const PairResult& {
        if (a > b) std::swap(a, b);
        auto k = std::make_pair(a, b);
        auto it = edges.find(k);
        if (it != edges.end()) return it->second;
        std::string key = nodes[a].id + ">" + nodes[b].id;
        PairResult pr;
        if (cache.contains(key)) pr = PairResult::fromJson(cache[key]["pr"]);
        else {
            PairOptions po;
            pr = estimatePair(*nodes[a].feat, *nodes[b].feat, po);
            cache[key] = {{"pr", pr.toJson()}};
        }
        return edges[k] = pr;
    };
    // H mapping frame a -> frame b from the (possibly reversed) stored edge
    auto edgeH = [&](int a, int b, bool alt = false) {
        const PairResult& pr = edge(a, b);
        H3 H = alt ? pr.Halt : pr.H;
        return a < b ? H : H.inverse();
    };
    for (auto& n : nodes) {
        if (n.direct.ok && n.direct.ambiguous && !n.manual) {
            // Two placements have comparable feature support. A unique landmark inside the frame still decides:
            // compare how well each candidate agrees with the overview cell by cell.
            Radial none(ovW, ovH, 0.0);
            Verify v1 = verifyDense(S->ovGray, none, framePath(P, *n.f), metaFromFrame(*n.f), FrameModel(n.w, n.h, n.direct.H, 0.0));
            Verify v2 = verifyDense(S->ovGray, none, framePath(P, *n.f), metaFromFrame(*n.f), FrameModel(n.w, n.h, n.direct.Halt, 0.0));
            auto bad = [](const Verify& v) {
                int b = 0;
                for (auto m : v.bad) b += m;
                return b;
            };
            if (v1.valid && v2.valid) {
                int b1 = bad(v1), b2 = bad(v2);
                bool first = (b2 >= b1 + 3 && v1.maskedFrac < 0.12 && v1.zncc >= v2.zncc - 0.02) || (v2.mad > 1.25 * v1.mad + 0.5 && b1 <= b2);
                bool second = (b1 >= b2 + 3 && v2.maskedFrac < 0.12 && v2.zncc >= v1.zncc - 0.02) || (v1.mad > 1.25 * v2.mad + 0.5 && b2 <= b1);
                if (first && !second) n.direct.ambiguous = false;
                else if (second && !first) {
                    std::swap(n.direct.H, n.direct.Halt);
                    n.direct.ambiguous = false;
                    n.direct.inA.clear();  // inliers belonged to the discarded placement
                    n.direct.inB.clear();
                }
            }
            if (!n.direct.ambiguous) n.via = "overview(landmark)";
        }
        if (n.direct.ok && !n.direct.ambiguous) {
            n.placed = true;
            n.H = n.direct.H;
        }
    }
    int pairWork = 0;
    auto tick = [&] {
        ctx.check();
        pairWork++;
        ctx.report("Matching neighbours", 0.55 + 0.25 * (1 - std::exp(-pairWork / (2.0 * std::max(1, N)))), "");
    };
    // 3a. overlapping placed pairs
    auto matchPlacedOverlaps = [&] {
        for (int a = 0; a < N; a++)
            for (int b = a + 1; b < N; b++) {
                if (!nodes[a].placed || !nodes[b].placed) continue;
                if (edges.count({a, b})) continue;
                if (overlapFrac(footprintOf(nodes[a].H, nodes[a].w, nodes[a].h), footprintOf(nodes[b].H, nodes[b].w, nodes[b].h)) < 0.04) continue;
                tick();
                edge(a, b);
            }
    };
    matchPlacedOverlaps();
    // 3b. chain placement of frames that could not be anchored directly
    bool progress = true;
    while (progress) {
        progress = false;
        for (int u = 0; u < N; u++) {
            Node& nu = nodes[u];
            if (nu.placed) continue;
            int bestP = -1, bestN = 0;
            for (int p = 0; p < N; p++) {
                if (!nodes[p].placed || p == u) continue;
                tick();
                const PairResult& pr = edge(u, p);
                if (pr.ok && !pr.ambiguous && pr.nInliers >= 20 && pr.nInliers > bestN) {
                    bestN = pr.nInliers;
                    bestP = p;
                }
            }
            if (bestP < 0) continue;
            H3 Hc = (nodes[bestP].H * edgeH(u, bestP)).normalized();
            if (!validateHomography(Hc, nu.w, nu.h).ok) continue;
            // resolve an ambiguous direct match with the neighbour's prediction
            if (nu.direct.ambiguous || nu.direct.fail == "repetitive") {
                Pt cc = Hc.apply(nu.w * 0.5, nu.h * 0.5);
                double foot = std::sqrt(quadArea(footprintOf(Hc, nu.w, nu.h)));
                for (int alt = 0; alt < 2; alt++) {
                    const H3& Hd = alt ? nu.direct.Halt : nu.direct.H;
                    Pt c = Hd.apply(nu.w * 0.5, nu.h * 0.5);
                    if (std::hypot(c.x - cc.x, c.y - cc.y) < 0.12 * foot) {
                        nu.H = Hd;
                        nu.placed = true;
                        nu.via = "overview+neighbour";
                        break;
                    }
                }
            }
            if (!nu.placed) {
                // tie the chained position back to the overview with guided matching
                PairOptions po;
                po.havePrior = true;
                po.prior = Hc;
                po.priorRadius = std::max(8.0, 0.01 * std::hypot((double)ovW, (double)ovH));
                po.minInliers = 10;
                po.requireAinsideB = true;
                PairResult g = estimatePair(*nu.feat, OF, po);
                if (g.ok) {
                    nu.H = g.H;
                    nu.direct = g;
                    nu.via = "chain+overview";
                } else {
                    nu.H = Hc;
                    nu.via = "chain";
                }
                nu.placed = true;
            }
            progress = true;
        }
        if (progress) matchPlacedOverlaps();
    }

    // Frames that stay unplaced may still match each other: such "islands" are reported as disconnected, never placed.
    {
        std::vector<int> un;
        for (int i = 0; i < N; i++)
            if (!nodes[i].placed) un.push_back(i);
        if (un.size() <= 16)
            for (size_t a = 0; a < un.size(); a++)
                for (size_t b = a + 1; b < un.size(); b++) {
                    tick();
                    edge(un[a], un[b]);
                }
    }

    // ---- 3c. dense refinement of every placed frame against the overview ----------------------------
    for (int i = 0; i < N; i++) {
        Node& n = nodes[i];
        if (!n.placed) continue;
        ctx.check();
        ctx.report("Refining against overview", 0.80 + 0.02 * i / std::max(1, N), n.name);
        std::string key = n.id + ">dense";
        char sigb[400];
        snprintf(sigb, sizeof(sigb), "%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g", n.H.m[0], n.H.m[1], n.H.m[2], n.H.m[3], n.H.m[4], n.H.m[5], n.H.m[6], n.H.m[7]);
        if (cache.contains(key) && cache[key].value("sig", "") == sigb) n.dense = Dense::fromJson(cache[key]["d"]);
        else {
            n.dense = denseRefine(S->ovGray, framePath(P, *n.f), metaFromFrame(*n.f), n.w, n.h, n.H);
            cache[key] = {{"sig", sigb}, {"d", n.dense.toJson()}};
        }
        if (n.dense.ok) n.H = n.dense.H;
    }
    matchPlacedOverlaps();

    // ---- 4. edge consistency + observations --------------------------------------------------------
    std::vector<int> pidx(N, -1);
    std::vector<BAFrame> bf;
    for (int i = 0; i < N; i++)
        if (nodes[i].placed) {
            pidx[i] = (int)bf.size();
            BAFrame b;
            b.w = nodes[i].w;
            b.h = nodes[i].h;
            b.H = nodes[i].H;
            b.group = nodes[i].group;
            bf.push_back(b);
        }
    std::vector<BAObs> obs;
    std::vector<int> obsFrameA, obsFrameB;  // node indices
    struct OffPair {
        int a, b;
        Pt pa, pb;
        double thr;
    };
    std::vector<OffPair> offPairs;  // candidate off-plane matches, re-checked with the refined models
    json graph = json::array();
    auto scaleOf = [&](int i) { return 1.0 / std::sqrt(std::max(1e-12, std::abs(jacobian(nodes[i].H, nodes[i].w * 0.5, nodes[i].h * 0.5)[0] * jacobian(nodes[i].H, nodes[i].w * 0.5, nodes[i].h * 0.5)[3] - jacobian(nodes[i].H, nodes[i].w * 0.5, nodes[i].h * 0.5)[1] * jacobian(nodes[i].H, nodes[i].w * 0.5, nodes[i].h * 0.5)[2]))); };
    for (auto& kv : edges) {
        int a = kv.first.first, b = kv.first.second;
        const PairResult& pr = kv.second;
        json g = {{"a", nodes[a].id}, {"b", nodes[b].id}, {"ok", pr.ok}, {"n", pr.nInliers}, {"used", false}, {"fail", pr.fail}};
        if (pr.ok && nodes[a].placed && nodes[b].placed) {
            H3 pred = (nodes[b].H.inverse() * nodes[a].H).normalized();  // a -> b implied by placements
            double tol = std::max(40.0, 0.02 * std::hypot((double)nodes[b].w, (double)nodes[b].h));
            auto disc = [&](const H3& He) {
                double e = 0;
                for (size_t k = 0; k < pr.inA.size(); k += std::max<size_t>(1, pr.inA.size() / 12)) {
                    Pt p1 = pred.apply(pr.inA[k]), p2 = He.apply(pr.inA[k]);
                    e = std::max(e, std::hypot(p1.x - p2.x, p1.y - p2.y));
                }
                return e;
            };
            bool consistent = disc(pr.H) < tol;
            if (!consistent && pr.ambiguous && disc(pr.Halt) < tol) consistent = false;  // inliers belong to the other placement: unusable
            if (pr.ambiguous && consistent) g["resolved"] = true;
            g["consistent"] = consistent;
            if (consistent) {
                nodes[a].consistentEdges++;
                nodes[b].consistentEdges++;
                double sc = std::sqrt(scaleOf(a) * scaleOf(b));
                for (size_t k = 0; k < pr.inA.size(); k++) {
                    BAObs o;
                    o.i = pidx[a];
                    o.j = pidx[b];
                    o.pi = pr.inA[k];
                    o.pj = pr.inB[k];
                    o.scale = sc;
                    o.w = 1.0 / std::max(1.0, 0.5 * pr.thr);
                    obs.push_back(o);
                    obsFrameA.push_back(a);
                    obsFrameB.push_back(b);
                }
                g["used"] = true;
                if (pr.nEpipolar >= 40 && !pr.ambiguous) {
                    nodes[a].planar.push_back(pr.planarRatio);
                    nodes[b].planar.push_back(pr.planarRatio);
                }
                for (size_t k = 0; k < pr.offPlaneA.size() && k < pr.offPlaneB.size(); k++) offPairs.push_back({a, b, pr.offPlaneA[k], pr.offPlaneB[k], pr.thr});
                for (size_t k = 0; k < pr.inA.size(); k++) {
                    nodes[a].inPlane.push_back(pr.inA[k]);
                    nodes[b].inPlane.push_back(pr.inB[k]);
                }
            } else {
                nodes[a].conflictEdges++;
                nodes[b].conflictEdges++;
            }
        }
        graph.push_back(g);
    }
    // anchor observations: dense block matches when available, otherwise sparse feature matches
    for (int i = 0; i < N; i++) {
        Node& n = nodes[i];
        if (!n.placed) continue;
        if (n.dense.ok) {
            size_t stepK = std::max<size_t>(1, n.dense.pf.size() / 300);
            for (size_t k = 0; k < n.dense.pf.size(); k += stepK) {
                BAObs o;
                o.i = pidx[i];
                o.j = -1;
                o.pi = n.dense.pf[k];
                o.pj = n.dense.po[k];
                o.scale = 1;
                o.w = 1.0 / (0.5 * n.dense.step);
                obs.push_back(o);
                obsFrameA.push_back(i);
                obsFrameB.push_back(-1);
            }
            continue;
        }
        const PairResult* src = nullptr;
        PairResult guided;
        if (n.direct.ok && !n.direct.inA.empty() && (n.via == "overview" || n.via == "overview(landmark)" || n.via == "manual" || n.via == "manual+refine" || n.via == "chain+overview")) src = &n.direct;
        else {
            PairOptions po;
            po.havePrior = true;
            po.prior = n.H;
            po.priorRadius = std::max(8.0, 0.008 * std::hypot((double)ovW, (double)ovH));
            po.minInliers = 8;
            po.requireAinsideB = true;
            guided = estimatePair(*n.feat, OF, po);
            if (guided.ok) src = &guided;
        }
        if (!src) continue;
        double wgt = (n.via == "manual") ? 0.5 : 1.0 / std::max(1.0, 0.5 * src->thr);
        for (size_t k = 0; k < src->inA.size(); k++) {
            BAObs o;
            o.i = pidx[i];
            o.j = -1;
            o.pi = src->inA[k];
            o.pj = src->inB[k];
            o.scale = 1;
            o.w = wgt;
            obs.push_back(o);
            obsFrameA.push_back(i);
            obsFrameB.push_back(-1);
        }
    }

    // ---- 5. global refinement ----------------------------------------------------------------------
    ctx.check();
    ctx.report("Global refinement", 0.83);
    json baInfo = json::object();
    std::vector<double> k1(lensGroups.size(), 0.0);
    if (!bf.empty() && !obs.empty()) {
        BAOptions bo;
        bo.ovW = ovW;
        bo.ovH = ovH;
        bo.ovGroup = ovGroup;
        std::vector<BAFrame> f0 = bf;
        BAResult r0 = bundleAdjust(f0, obs, (int)lensGroups.size(), {}, bo);
        BAResult best = r0;
        std::vector<BAFrame> fbest = f0;
        // radial distortion: only when overlaps constrain it well and it clearly improves the fit
        int nPair = 0;
        for (auto& o : obs)
            if (o.j >= 0) nPair++;
        bool tryK1 = bf.size() >= 3 && nPair >= 150 && !args.value("noDistortion", false);
        if (tryK1) {
            bo.solveK1 = true;
            std::vector<BAFrame> f1 = f0;
            BAResult r1 = bundleAdjust(f1, obs, (int)lensGroups.size(), {}, bo);
            bool sane = true;
            for (double k : r1.k1)
                if (std::abs(k) > 0.2) sane = false;
            bool allValid = true;
            for (auto& fr : f1)
                if (!validateHomography(fr.H, fr.w, fr.h).ok) allValid = false;
            baInfo["costNoDistortion"] = r0.cost;
            baInfo["costWithDistortion"] = r1.cost;
            if (sane && allValid && r1.cost < 0.85 * r0.cost) {
                best = r1;
                fbest = f1;
                k1 = r1.k1;
            }
        }
        baInfo["cost0"] = r0.cost0;
        baInfo["cost"] = best.cost;
        baInfo["iters"] = best.iters;
        baInfo["observations"] = (int)obs.size();
        // adopt refined transforms (guard against a refinement that degrades a frame into an invalid shape)
        for (int i = 0; i < N; i++)
            if (pidx[i] >= 0 && validateHomography(fbest[pidx[i]].H, nodes[i].w, nodes[i].h).ok) nodes[i].H = fbest[pidx[i]].H;
        // residual statistics
        std::vector<double> sp(N, 0), sa(N, 0);
        for (size_t k = 0; k < obs.size(); k++) {
            double e = best.obsRes[k];
            int a = obsFrameA[k], b = obsFrameB[k];
            if (b >= 0) {
                sp[a] += e * e;
                nodes[a].nPairObs++;
                sp[b] += e * e;
                nodes[b].nPairObs++;
            } else {
                sa[a] += e * e;
                nodes[a].nAnchorObs++;
            }
        }
        for (int i = 0; i < N; i++) {
            nodes[i].pairRms = nodes[i].nPairObs ? std::sqrt(sp[i] / nodes[i].nPairObs) : 0;
            nodes[i].anchorRms = nodes[i].nAnchorObs ? std::sqrt(sa[i] / nodes[i].nAnchorObs) : 0;
        }
    }
    double ovK1 = ovGroup >= 0 ? k1[ovGroup] : 0.0;
    Radial ovRad(ovW, ovH, ovK1);
    // Off-plane evidence is only kept if it (a) survives the refined model - residuals that lens distortion or
    // the initial pairwise fit explained are not parallax - and (b) is locally COHERENT: real parallax moves all
    // points of a small region by a similar, moderate amount, whereas wrong matches on repeated glyphs or pattern
    // elements (which also satisfy an epipolar constraint along a text line) scatter randomly.
    {
        const int G = 12;
        struct Rv {
            Pt p, v;
        };
        std::map<std::pair<int, int>, std::vector<Rv>> cells;  // (node, cell) -> residual vectors
        auto cellOf = [&](int node, const Pt& p) {
            int cx = std::min(G - 1, std::max(0, (int)(p.x / nodes[node].w * G))), cy = std::min(G - 1, std::max(0, (int)(p.y / nodes[node].h * G)));
            return std::make_pair(node, cy * G + cx);
        };
        double thrMax = 0;
        for (auto& op : offPairs) {
            FrameModel ma(nodes[op.a].w, nodes[op.a].h, nodes[op.a].H, nodes[op.a].group >= 0 ? k1[nodes[op.a].group] : 0.0);
            FrameModel mb(nodes[op.b].w, nodes[op.b].h, nodes[op.b].H, nodes[op.b].group >= 0 ? k1[nodes[op.b].group] : 0.0);
            Pt q = mb.toFrame(ma.toCanvas(op.pa));
            Pt v{q.x - op.pb.x, q.y - op.pb.y};
            double mag = std::hypot(v.x, v.y);
            thrMax = std::max(thrMax, op.thr);
            if (mag <= 3 * op.thr || mag > 40 * op.thr) continue;
            cells[cellOf(op.a, op.pa)].push_back({op.pa, v});
            cells[cellOf(op.b, op.pb)].push_back({op.pb, {-v.x, -v.y}});
        }
        for (auto& kv : cells) {
            auto& v = kv.second;
            if (v.size() < 4) continue;
            std::vector<double> xs, ys;
            for (auto& r : v) {
                xs.push_back(r.v.x);
                ys.push_back(r.v.y);
            }
            std::nth_element(xs.begin(), xs.begin() + xs.size() / 2, xs.end());
            std::nth_element(ys.begin(), ys.begin() + ys.size() / 2, ys.end());
            double mx = xs[xs.size() / 2], my = ys[ys.size() / 2], mm = std::hypot(mx, my);
            int agree = 0;
            for (auto& r : v)
                if (std::hypot(r.v.x - mx, r.v.y - my) < std::max(2 * thrMax, 0.3 * mm)) agree++;
            if (agree * 10 < (int)v.size() * 6 || mm <= 3 * thrMax) continue;
            for (auto& r : v) nodes[kv.first.first].offPlane.push_back(r.p);
        }
    }
    const FrameQuality ovQ = FrameQuality::fromJson(ov["quality"]);
    // ---- 6. dense verification + classification ----------------------------------------------------
    int accepted = 0, rejected = 0, uncertain = 0;
    for (int i = 0; i < N; i++) {
        ctx.check();
        ctx.report("Verifying alignment", 0.85 + 0.14 * i / std::max(1, N), nodes[i].name);
        Node& n = nodes[i];
        json& f = *n.f;
        json reg = json::object();
        std::vector<std::string> reasons, warns;
        std::string status;
        FrameQuality q = FrameQuality::fromJson(f["quality"]);
        reg["nMatches"] = n.direct.nPutative;
        reg["nInliers"] = n.direct.nInliers;
        reg["rmsPx"] = n.direct.rms;
        reg["ambiguous"] = n.direct.ambiguous;
        reg["usedHint"] = n.usedHint;
        if (!n.placed) {
            bool island = false, ambEdges = false;
            for (auto& kv : edges)
                if ((kv.first.first == i || kv.first.second == i) && kv.second.ok) {
                    if (kv.second.ambiguous) ambEdges = true;
                    else island = true;
                }
            if (n.direct.ambiguous || n.direct.fail == "repetitive" || (ambEdges && !island)) {
                status = "uncertain";
                reasons.push_back("ambiguous_repeat");
                if (n.direct.ok) {
                    reg["H"] = n.direct.H.toJson();  // primary candidate (not used unless the user forces it)
                    reg["Halt"] = n.direct.Halt.toJson();
                }
            } else {
                status = "rejected";
                const std::string& fl = n.direct.fail;
                if (island) reasons.push_back("disconnected");
                else if (fl == "degenerate" || fl == "mirrored" || fl == "folded" || fl == "stretch" || fl == "perspective") reasons.push_back("bad_geometry");
                else if (fl == "low_spread" || fl == "high_residual") reasons.push_back("weak_match");
                else reasons.push_back("no_match");
                if (q.bestSigma > 2.2) reasons.push_back("blurry");
                if (q.texturedFrac < 0.15) reasons.push_back("textureless");
            }
            if (status == "uncertain" && n.direct.ok && f["user"].value("forceAccept", false) && validateHomography(n.direct.H, n.w, n.h).ok) {
                n.placed = true;
                n.H = n.direct.H;
                n.via = "forced";
            }
        }
        if (n.placed) {
            double fk1 = n.group >= 0 ? k1[n.group] : 0.0;
            FrameModel fm(n.w, n.h, n.H, fk1);
            Verify V = verifyDense(S->ovGray, ovRad, framePath(P, f), metaFromFrame(f), fm);
            auto fp = fm.footprint();
            Pt cc = fm.toCanvas({n.w * 0.5, n.h * 0.5});
            double s = fm.scaleAt(cc);
            const double sigOv = ovQ.sigmaAt(cc.x, cc.y, ovW, ovH);
            double effGain = detailGain(s, q.sharpSigma, sigOv);
            // parallax mask from off-plane matches
            std::vector<uint8_t> mask = V.bad;
            int mgw = V.gw, mgh = V.gh;
            {
                std::vector<int> offC(mgw * mgh, 0), inC(mgw * mgh, 0);
                auto cell = [&](const Pt& p) {
                    int cx = std::min(mgw - 1, std::max(0, (int)(p.x / n.w * mgw))), cy = std::min(mgh - 1, std::max(0, (int)(p.y / n.h * mgh)));
                    return cy * mgw + cx;
                };
                for (auto& p : n.offPlane) offC[cell(p)]++;
                for (auto& p : n.inPlane) inC[cell(p)]++;
                for (int c = 0; c < mgw * mgh; c++)
                    if (offC[c] >= 3 && offC[c] > inC[c]) mask[c] = 1;
            }
            // grow masked groups by one cell (isolated single cells are left as they are): inconsistent geometry
            // rarely ends exactly at a cell border
            {
                std::vector<uint8_t> grown = mask;
                for (int cy = 0; cy < mgh; cy++)
                    for (int cx = 0; cx < mgw; cx++) {
                        if (!mask[cy * mgw + cx]) continue;
                        int nbr = 0;
                        for (int dy = -1; dy <= 1; dy++)
                            for (int dx = -1; dx <= 1; dx++) {
                                int x = cx + dx, y = cy + dy;
                                if ((dx || dy) && x >= 0 && y >= 0 && x < mgw && y < mgh && mask[y * mgw + x]) nbr++;
                            }
                        if (nbr == 0) continue;
                        for (int dy = -1; dy <= 1; dy++)
                            for (int dx = -1; dx <= 1; dx++) {
                                int x = cx + dx, y = cy + dy;
                                if (x >= 0 && y >= 0 && x < mgw && y < mgh) grown[y * mgw + x] = 1;
                            }
                    }
                mask = grown;
            }
            int nb = 0;
            for (auto m : mask) nb += m;
            double maskedFrac = double(nb) / std::max<size_t>(1, mask.size());
            double planar = 1.0;
            if (!n.planar.empty()) {
                std::sort(n.planar.begin(), n.planar.end());
                planar = n.planar[n.planar.size() / 2];
            }
            status = "accepted";
            if (V.valid && V.zncc >= 0 && V.texturedFrac >= 0.03) {
                if (V.zncc < 0.25) {
                    status = "rejected";
                    reasons.push_back("content_mismatch");
                } else if (V.zncc < 0.45) {
                    status = "uncertain";
                    reasons.push_back("low_similarity");
                }
            } else if (n.via == "chain" && !n.dense.ok) {
                status = "uncertain";
                reasons.push_back("chain_only");
            }
            // Reject for missing detail only when even the sharpest parts of the photo are soft: a soft SUBJECT
            // (smooth gradients) lowers the median sharpness without the photo being at fault.
            double bestGain = detailGain(s, q.bestSigma, sigOv);
            const bool lacksDetail = bestGain < kMinGain;
            if (status != "rejected" && lacksDetail) {
                status = "rejected";
                reasons.push_back(s >= kMinGain ? "blurry" : "no_detail_gain");
            }
            if (status != "rejected") {  // (a photo that is simply blurred is reported as such, not as inconsistent)
                if (maskedFrac > 0.5) {
                    status = "rejected";
                    reasons.push_back(V.softCells * 2 > nb ? "blurry" : "inconsistent");
                } else if (planar < 0.6 && n.planar.size() >= 1) {
                    status = "uncertain";
                    reasons.push_back("parallax");
                } else if (maskedFrac > 0.02) warns.push_back(V.softCells * 2 > nb ? "soft_regions" : "partial_mask");
            }
            if (status == "accepted") {
                if (n.conflictEdges >= 2 && n.consistentEdges == 0) {
                    status = "uncertain";
                    reasons.push_back("conflict");
                } else if ((n.nPairObs >= 20 && n.pairRms > 6.0) || (n.nAnchorObs >= 8 && n.anchorRms > 1.5)) {
                    // does not fit its neighbours (close-up px) or the overview (overview px) as well as a flat,
                    // distortion-corrected photo should: edges may break at this photo's border
                    status = "uncertain";
                    reasons.push_back("high_residual");
                } else if (!n.manual && n.direct.nInliers < 20 && n.consistentEdges == 0 && (!V.valid || V.zncc < 0.6)) {
                    status = "uncertain";
                    reasons.push_back("weak_match");
                }
            }
            if (n.manual) warns.push_back("manual");
            if (status == "uncertain" && f["user"].value("forceAccept", false)) {
                status = "accepted";
                warns.push_back("user_forced");
            }
            if (n.via == "forced") {
                status = "accepted";
                warns.push_back("user_forced");
            }
            if (V.valid && (V.exposureRatio < 0.7 || V.exposureRatio > 1.45)) warns.push_back("exposure_mismatch");
            if (std::abs(fk1) > 1e-4) warns.push_back("lens_distortion");
            reg["H"] = n.H.toJson();
            reg["k1"] = fk1;
            reg["via"] = n.via;
            reg["scale"] = s;
            reg["effGain"] = effGain;
            reg["zncc"] = V.zncc;
            reg["texturedFrac"] = V.texturedFrac;
            reg["exposureRatio"] = V.exposureRatio;
            reg["maskedFrac"] = maskedFrac;
            reg["maskW"] = mgw;
            reg["maskH"] = mgh;
            std::string bits(mask.size(), '0');
            for (size_t k = 0; k < mask.size(); k++)
                if (mask[k]) bits[k] = '1';
            reg["maskBits"] = nb ? bits : "";
            reg["residualPx"] = n.pairRms;
            reg["anchorResidualPx"] = n.anchorRms;
            reg["pairs"] = n.consistentEdges;
            reg["conflicts"] = n.conflictEdges;
            reg["planarRatio"] = planar;
            reg["maskSoftCells"] = V.softCells;
            reg["maskOffPlanePts"] = (int)n.offPlane.size();
            reg["denseBlocks"] = n.dense.inliers;
            reg["denseOk"] = n.dense.ok;
            json fpj = json::array();
            for (auto& p : fp) fpj.push_back({p.x, p.y});
            reg["footprint"] = fpj;
        }
        for (const json& w : f.value("warnings", json::array())) {
            std::string ws = w;
            if (ws != "blurry" && ws != "textureless") warns.push_back(ws);  // (blur / texture are judged by the checks above)
        }
        reg["status"] = status;
        reg["reasons"] = reasons;
        reg["warnings"] = warns;
        json msgs = json::array();
        for (auto& r : reasons) msgs.push_back(reasonText(r));
        for (auto& w : warns) msgs.push_back(reasonText(w));
        reg["messages"] = msgs;
        f["reg"] = reg;
        if (status == "accepted") accepted++;
        else if (status == "rejected") rejected++;
        else uncertain++;
    }
    for (json* fp : P.closeups(true)) {
        json& f = *fp;
        if (f["user"].value("removed", false)) continue;
        if (!f["user"].value("included", true)) {
            json keep = f.value("reg", json::object());
            keep["excluded"] = true;
            f["reg"] = keep;
        }
    }
    // scene-level honesty: does the subject look non-planar / inconsistent overall?
    int affected = 0, placedN = 0;
    for (auto& n : nodes) {
        if (!n.placed) continue;
        placedN++;
        const json& rg = (*n.f)["reg"];
        bool par = false;
        for (auto& r : rg.value("reasons", json::array()))
            if (r == "parallax" || r == "inconsistent") par = true;
        if (par || rg.value("maskedFrac", 0.0) > 0.10) affected++;
    }
    json planarity = {{"suspect", placedN >= 2 && affected >= std::max(2, (int)std::ceil(0.25 * placedN))}, {"framesAffected", affected}, {"framesPlaced", placedN}};
    json k1j = json::object();
    for (auto& kv : lensGroups) k1j[kv.first] = k1[kv.second];
    P.j["registration"] = {{"overviewK1", ovK1}, {"k1", k1j}, {"ba", baInfo}, {"graph", graph}, {"updatedAt", nowIso()},
                           {"accepted", accepted}, {"rejected", rejected}, {"uncertain", uncertain}, {"ms", nowMs() - t0},
                           {"overviewFeatures", (int)OF.count()}, {"planarity", planarity}};
    // result staleness
    if (!P.j["result"].is_null()) P.j["result"]["stale"] = P.j["result"].value("inputHash", "") != P.inputHash();
    atomicWriteFile(cachePath, cache.dump());
    if (!args.value("_noSave", false)) P.save();
    ctx.report("Verifying alignment", 1.0);
    json out = P.j["registration"];
    out.erase("graph");
    return out;
}

// Diagnostic: pairwise estimate between two frames (or a frame and the overview) of a project.
json debugPair(Project& P, const json& a) {
    Ctx ctx;
    auto S = getSession(P, ctx, false);
    auto feat = [&](const std::string& id) -> std::shared_ptr<Features> {
        if (id == "overview") return S->ovFeat;
        const json* f = P.frame(id);
        if (!f) throw UserError("no_frame", "Frame not found.");
        return frameFeatures(P, *f, ctx);
    };
    auto A = feat(a.at("a")), B = feat(a.at("b"));
    PairOptions po;
    po.requireAinsideB = a.value("b", "") == "overview";
    PairResult pr = estimatePair(*A, *B, po);
    json j = pr.toJson();
    j.erase("inA");
    j.erase("inB");
    j.erase("offPlaneA");
    j["featuresA"] = (int)A->count();
    j["featuresB"] = (int)B->count();
    return j;
}

// ============================================================================================ coverage
json computeCoverage(Project& P, bool writeMap) {
    json* ovp = P.overview();
    if (!ovp) throw UserError("no_overview", "Add an overview photo first.");
    const int ovW = (*ovp)["meta"]["width"], ovH = (*ovp)["meta"]["height"];
    const int cell = std::max(1, (int)std::ceil(std::max(ovW, ovH) / 256.0));
    const int gw = (ovW + cell - 1) / cell, gh = (ovH + cell - 1) / cell;
    cv::Mat G(gh, gw, CV_32F, cv::Scalar(1.0f));
    cv::Mat src(gh, gw, CV_16S, cv::Scalar(-1));
    auto frames = acceptedFrames(P);
    const FrameQuality ovQ = FrameQuality::fromJson((*ovp)["quality"]);
    std::vector<double> footW;
    for (size_t fi = 0; fi < frames.size(); fi++) {
        const LoadedFrame& L = frames[fi];
        auto fp = L.model.footprint();
        double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
        for (auto& p : fp) {
            minx = std::min(minx, p.x);
            miny = std::min(miny, p.y);
            maxx = std::max(maxx, p.x);
            maxy = std::max(maxy, p.y);
        }
        footW.push_back(std::sqrt(std::abs(polygonArea({fp[0], fp[1], fp[2], fp[3]}))));
        int x0 = std::max(0, (int)(minx / cell)), x1 = std::min(gw - 1, (int)(maxx / cell));
        int y0 = std::max(0, (int)(miny / cell)), y1 = std::min(gh - 1, (int)(maxy / cell));
        for (int y = y0; y <= y1; y++)
            for (int x = x0; x <= x1; x++) {
                Pt c{(x + 0.5) * cell, (y + 0.5) * cell};
                Pt p = L.model.toFrame(c);
                if (p.x < 0 || p.y < 0 || p.x >= L.model.w || p.y >= L.model.h) continue;
                if (L.maskedAt(p.x, p.y)) continue;
                double g = detailGain(L.model.scaleAt(c), L.quality.sigmaAt(p.x, p.y, L.model.w, L.model.h), ovQ.sigmaAt(c.x, c.y, ovW, ovH));
                if (g > G.at<float>(y, x)) {
                    G.at<float>(y, x) = (float)g;
                    src.at<short>(y, x) = (short)fi;
                }
            }
    }
    const double covThr = 1.5;
    cv::Mat covered = G >= covThr;
    double total = (double)gw * gh;
    json st;
    st["coveredFrac"] = cv::countNonZero(covered) / total;
    for (double t : {1.5, 2.0, 3.0, 4.0, 6.0}) {
        char key[32];
        snprintf(key, sizeof(key), "ge%.1f", t);
        st[key] = cv::countNonZero(G >= t) / total;
    }
    st["meanGain"] = cv::mean(G)[0];
    {
        std::vector<float> v;
        for (int y = 0; y < gh; y++)
            for (int x = 0; x < gw; x++)
                if (G.at<float>(y, x) >= covThr) v.push_back(G.at<float>(y, x));
        if (!v.empty()) {
            std::sort(v.begin(), v.end());
            st["medianGainCovered"] = v[v.size() / 2];
            st["p80GainCovered"] = v[std::min(v.size() - 1, (size_t)(v.size() * 0.8))];
            st["maxGain"] = v.back();
        } else {
            st["medianGainCovered"] = 1.0;
            st["p80GainCovered"] = 1.0;
            st["maxGain"] = 1.0;
        }
    }
    // gaps: connected low-detail regions, with a capture suggestion at the point deepest inside each gap
    json gaps = json::array();
    if (!frames.empty()) {
        cv::Mat gapMask = ~covered, labels, stats, cent, dist;
        int nl = cv::connectedComponentsWithStats(gapMask, labels, stats, cent, 8, CV_32S);
        cv::Mat padded;
        cv::copyMakeBorder(gapMask, padded, 1, 1, 1, 1, cv::BORDER_CONSTANT, cv::Scalar(0));
        cv::distanceTransform(padded, dist, cv::DIST_L2, 3);
        dist = dist(cv::Rect(1, 1, gw, gh));
        std::sort(footW.begin(), footW.end());
        double fw = footW[footW.size() / 2];
        std::vector<std::pair<double, json>> gl;
        for (int i = 1; i < nl; i++) {
            double area = stats.at<int>(i, cv::CC_STAT_AREA) / total;
            if (area < 0.004) continue;
            cv::Rect bb(stats.at<int>(i, cv::CC_STAT_LEFT), stats.at<int>(i, cv::CC_STAT_TOP), stats.at<int>(i, cv::CC_STAT_WIDTH), stats.at<int>(i, cv::CC_STAT_HEIGHT));
            double best = -1;
            cv::Point bp;
            for (int y = bb.y; y < bb.y + bb.height; y++)
                for (int x = bb.x; x < bb.x + bb.width; x++)
                    if (labels.at<int>(y, x) == i && dist.at<float>(y, x) > best) {
                        best = dist.at<float>(y, x);
                        bp = cv::Point(x, y);
                    }
            json g = {{"x", bb.x * cell}, {"y", bb.y * cell}, {"w", bb.width * cell}, {"h", bb.height * cell}, {"areaFrac", area},
                      {"cx", (bp.x + 0.5) * cell}, {"cy", (bp.y + 0.5) * cell}, {"suggestSize", fw}};
            gl.push_back({area, g});
        }
        std::sort(gl.begin(), gl.end(), [](auto& a, auto& b) { return a.first > b.first; });
        for (size_t i = 0; i < gl.size() && i < 12; i++) gaps.push_back(gl[i].second);
    }
    json out = {{"gridW", gw}, {"gridH", gh}, {"cell", cell}, {"stats", st}, {"gaps", gaps}, {"frames", (int)frames.size()}, {"threshold", covThr}};
    if (writeMap) {
        cv::Mat m8;
        G.convertTo(m8, CV_8U, 32.0);  // 1.0x -> 32, 7.97x -> 255
        std::string rel = "work/coverage.png";
        cv::imwrite(P.abs(rel + ".tmp.png"), m8);
        std::error_code ec;
        fs::rename(P.abs(rel + ".tmp.png"), P.abs(rel), ec);
        out["map"] = rel;
        out["mapScale"] = 32.0;
    }
    return out;
}

// ============================================================================================ live locate
json locatePreview(const std::string& dir, const cv::Mat& gray) {
    Project P = Project::load(dir);
    Ctx ctx;
    auto S = getSession(P, ctx, false);
    json* ov = P.overview();
    const int ovW = (*ov)["meta"]["width"], ovH = (*ov)["meta"]["height"];
    Features F = extractFeatures(gray, 640, 1200, nullptr);
    PairOptions po;
    po.checkAmbiguity = false;
    po.requireAinsideB = true;
    po.minInliers = 10;
    PairResult pr = estimatePair(F, *S->ovFeat, po);
    json out = {{"found", pr.ok}, {"inliers", pr.nInliers}};
    if (!pr.ok) return out;
    json q = json::array();
    for (auto& p : footprintOf(pr.H, gray.cols, gray.rows)) q.push_back({p.x / ovW, p.y / ovH});
    out["quad"] = q;
    out["previewScale"] = pr.scale;  // preview px per overview px
    // overlap with the already accepted coverage (fraction of the located footprint)
    auto frames = acceptedFrames(P);
    double best = 0;
    auto fp = footprintOf(pr.H, gray.cols, gray.rows);
    for (auto& L : frames) best = std::max(best, overlapFrac(fp, L.model.footprint()));
    out["overlapWithAccepted"] = best;
    return out;
}

}  // namespace dc
