#include "dc/geom.h"
#include <opencv2/imgproc.hpp>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <ctime>
#include <mutex>

namespace dc {

static std::function<void(const std::string&)> g_sink;
static std::mutex g_logMu;
void setLogSink(std::function<void(const std::string&)> sink) { g_sink = std::move(sink); }
void logf(const char* fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    std::lock_guard<std::mutex> lk(g_logMu);
    if (g_sink) g_sink(buf);
    else if (getenv("DC_VERBOSE")) fprintf(stderr, "[dc] %s\n", buf);
}
int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
std::string nowIso() {
    std::time_t t = std::time(nullptr);
    char buf[32];
    std::tm tm{};
    gmtime_r(&t, &tm);
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

H3 H3::inverse() const {
    const auto& a = m;
    double d = det();
    if (std::abs(d) < 1e-300) throw std::runtime_error("singular homography");
    H3 r;
    r.m = {(a[4] * a[8] - a[5] * a[7]) / d, (a[2] * a[7] - a[1] * a[8]) / d, (a[1] * a[5] - a[2] * a[4]) / d,
           (a[5] * a[6] - a[3] * a[8]) / d, (a[0] * a[8] - a[2] * a[6]) / d, (a[2] * a[3] - a[0] * a[5]) / d,
           (a[3] * a[7] - a[4] * a[6]) / d, (a[1] * a[6] - a[0] * a[7]) / d, (a[0] * a[4] - a[1] * a[3]) / d};
    return r;
}
H3 H3::normalized() const {
    H3 r = *this;
    if (std::abs(m[8]) > 1e-12)
        for (auto& v : r.m) v /= m[8];
    return r;
}
H3 H3::fromCv(const cv::Mat& M) {
    cv::Mat d;
    M.convertTo(d, CV_64F);
    H3 h;
    for (int i = 0; i < 9; i++) h.m[i] = d.at<double>(i / 3, i % 3);
    return h;
}

// Orientation transforms in continuous coordinates. With continuous coordinates a flip is x -> W - x exactly.
H3 orientationTransform(int o, int W, int Hh) {
    double w = W, h = Hh;
    switch (o) {
        case 2: return H3{{-1, 0, w, 0, 1, 0, 0, 0, 1}};   // mirror horizontal
        case 3: return H3{{-1, 0, w, 0, -1, h, 0, 0, 1}};  // rotate 180
        case 4: return H3{{1, 0, 0, 0, -1, h, 0, 0, 1}};   // mirror vertical
        case 5: return H3{{0, 1, 0, 1, 0, 0, 0, 0, 1}};    // transpose
        case 6: return H3{{0, -1, h, 1, 0, 0, 0, 0, 1}};   // rotate 90 CW
        case 7: return H3{{0, -1, h, -1, 0, w, 0, 0, 1}};  // transverse
        case 8: return H3{{0, 1, 0, -1, 0, w, 0, 0, 1}};   // rotate 90 CCW
        default: return H3::identity();
    }
}
void orientedSize(int o, int W, int H, int& w, int& h) {
    if (o >= 5 && o <= 8) {
        w = H;
        h = W;
    } else {
        w = W;
        h = H;
    }
}
void applyOrientation(const cv::Mat& s, cv::Mat& d, int o) {
    switch (o) {
        case 2: cv::flip(s, d, 1); break;
        case 3: cv::flip(s, d, -1); break;
        case 4: cv::flip(s, d, 0); break;
        case 5: cv::transpose(s, d); break;
        case 6: cv::rotate(s, d, cv::ROTATE_90_CLOCKWISE); break;
        case 7: {
            cv::Mat t;
            cv::transpose(s, t);
            cv::flip(t, d, -1);
            break;
        }
        case 8: cv::rotate(s, d, cv::ROTATE_90_COUNTERCLOCKWISE); break;
        default: d = s; break;
    }
}

cv::Mat toIndexConvention(const H3& H) {
    // x_idx = x_cont - 0.5  =>  Hidx = T(-0.5) * H * T(+0.5)
    H3 r = H3::translate(-0.5, -0.5) * H * H3::translate(0.5, 0.5);
    return r.toCv();
}
H3 fromIndexConvention(const cv::Mat& Hcv) { return H3::translate(0.5, 0.5) * H3::fromCv(Hcv) * H3::translate(-0.5, -0.5); }

Pt Radial::distort(Pt u) const {
    if (k1 == 0) return u;
    // solve rd * (1 + k1 rd^2) = ru for rd (normalised radius)
    double dx = (u.x - cx) / R, dy = (u.y - cy) / R;
    double ru = std::sqrt(dx * dx + dy * dy);
    if (ru < 1e-12) return u;
    double rd = ru;
    for (int i = 0; i < 12; i++) {
        double f = rd * (1 + k1 * rd * rd) - ru, fp = 1 + 3 * k1 * rd * rd;
        if (std::abs(fp) < 1e-9) break;
        double step = f / fp;
        rd -= step;
        if (std::abs(step) < 1e-13) break;
    }
    double s = rd / ru;
    return {cx + (u.x - cx) * s, cy + (u.y - cy) * s};
}

double FrameModel::scaleAt(Pt c) const {
    const double e = 0.5;
    Pt a = toFrame({c.x - e, c.y}), b = toFrame({c.x + e, c.y}), d = toFrame({c.x, c.y - e}), f = toFrame({c.x, c.y + e});
    double j00 = (b.x - a.x), j10 = (b.y - a.y), j01 = (f.x - d.x), j11 = (f.y - d.y);
    return std::sqrt(std::abs(j00 * j11 - j01 * j10));
}
std::array<Pt, 4> FrameModel::footprint() const {
    return {toCanvas({0, 0}), toCanvas({double(w), 0}), toCanvas({double(w), double(h)}), toCanvas({0, double(h)})};
}

std::array<double, 4> jacobian(const H3& H, double x, double y) {
    const auto& m = H.m;
    double X = m[0] * x + m[1] * y + m[2], Y = m[3] * x + m[4] * y + m[5], Z = m[6] * x + m[7] * y + m[8];
    return {(m[0] * Z - X * m[6]) / (Z * Z), (m[1] * Z - X * m[7]) / (Z * Z), (m[3] * Z - Y * m[6]) / (Z * Z),
            (m[4] * Z - Y * m[7]) / (Z * Z)};
}

double polygonArea(const std::vector<Pt>& p) {
    double a = 0;
    for (size_t i = 0; i < p.size(); i++) {
        const Pt& u = p[i];
        const Pt& v = p[(i + 1) % p.size()];
        a += u.x * v.y - v.x * u.y;
    }
    return 0.5 * a;
}
bool pointInQuad(const std::array<Pt, 4>& q, Pt p) {
    int sign = 0;
    for (int i = 0; i < 4; i++) {
        const Pt& a = q[i];
        const Pt& b = q[(i + 1) % 4];
        double c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        int s = c > 0 ? 1 : (c < 0 ? -1 : 0);
        if (s == 0) continue;
        if (sign == 0) sign = s;
        else if (s != sign) return false;
    }
    return true;
}
double hullArea(const std::vector<Pt>& pts) {
    if (pts.size() < 3) return 0;
    std::vector<cv::Point2f> p, hull;
    p.reserve(pts.size());
    for (auto& q : pts) p.emplace_back((float)q.x, (float)q.y);
    cv::convexHull(p, hull);
    if (hull.size() < 3) return 0;
    return std::abs(cv::contourArea(hull));
}

HCheck validateHomography(const H3& Hin, int w, int h) {
    HCheck r;
    for (double v : Hin.m)
        if (!std::isfinite(v)) {
            r.reason = "degenerate";
            return r;
        }
    if (std::abs(Hin.m[8]) < 1e-12) {
        r.reason = "degenerate";
        return r;
    }
    H3 H = Hin.normalized();
    // The projective denominator must keep one sign over the whole frame (no horizon crossing).
    double xs[5] = {0, double(w), double(w), 0, w * 0.5}, ys[5] = {0, 0, double(h), double(h), h * 0.5};
    double smin = 1e300, smax = 0, aniMax = 0;
    for (int i = 0; i < 5; i++) {
        if (H.w(xs[i], ys[i]) <= 1e-6) {
            r.reason = "degenerate";
            return r;
        }
        auto J = jacobian(H, xs[i], ys[i]);
        double det = J[0] * J[3] - J[1] * J[2];
        if (!(det > 1e-12)) {  // mirrored or collapsed
            r.reason = det < 0 ? "mirrored" : "degenerate";
            return r;
        }
        // singular values of the 2x2 Jacobian
        double a = J[0] * J[0] + J[2] * J[2], b = J[0] * J[1] + J[2] * J[3], d = J[1] * J[1] + J[3] * J[3];
        double tr = a + d, disc = std::sqrt(std::max(0.0, (a - d) * (a - d) + 4 * b * b));
        double s1 = std::sqrt(std::max(1e-300, (tr + disc) / 2)), s2 = std::sqrt(std::max(1e-300, (tr - disc) / 2));
        aniMax = std::max(aniMax, s1 / s2);
        double s = std::sqrt(det);
        smin = std::min(smin, s);
        smax = std::max(smax, s);
        if (i == 4) r.scale = 1.0 / s;  // src px per dst px at the centre
    }
    r.anisotropy = aniMax;
    r.scaleSpread = smax / smin;
    // projected quad must be convex with consistent winding
    std::array<Pt, 4> q = {H.apply(0, 0), H.apply(w, 0), H.apply(w, h), H.apply(0, h)};
    for (int i = 0; i < 4; i++) {
        const Pt& a = q[i];
        const Pt& b = q[(i + 1) % 4];
        const Pt& c = q[(i + 2) % 4];
        double cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (cr <= 0) {
            r.reason = "folded";
            return r;
        }
    }
    if (aniMax > 3.0) {
        r.reason = "stretch";  // implausible local stretching (tilt > ~70 degrees or wrong match)
        return r;
    }
    if (r.scaleSpread > 2.5) {
        r.reason = "perspective";  // implausibly strong perspective across one frame
        return r;
    }
    r.ok = true;
    return r;
}

}  // namespace dc
