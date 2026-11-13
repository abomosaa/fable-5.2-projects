// Deterministic tests for the Detailed Capture core. They exercise the real algorithms through the same
// command dispatcher the Android app uses (no mocks). Run: build/core/dcore_tests [filter]
#include "dc/ba.h"
#include "dc/compose.h"
#include "dc/project.h"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>

namespace fs = std::filesystem;
using namespace dc;

static int g_fail = 0, g_checks = 0;
#define CHECK(cond)                                                                      \
    do {                                                                                 \
        g_checks++;                                                                      \
        if (!(cond)) {                                                                   \
            g_fail++;                                                                    \
            printf("    FAILED %s:%d  %s\n", __FILE__, __LINE__, #cond);                 \
        }                                                                                \
    } while (0)
#define CHECK_NEAR(a, b, tol)                                                                             \
    do {                                                                                                  \
        g_checks++;                                                                                       \
        double _a = (a), _b = (b);                                                                        \
        if (!(std::abs(_a - _b) <= (tol))) {                                                              \
            g_fail++;                                                                                     \
            printf("    FAILED %s:%d  %s = %.6g, expected %.6g (tol %.3g)\n", __FILE__, __LINE__, #a, _a, _b, (double)(tol)); \
        }                                                                                                 \
    } while (0)

static std::string g_tmp;
static json call(const std::string& cmd, const json& args, Ctx ctx = Ctx()) {
    if (ctx.threads == 2 && ctx.memoryBudgetMB == 512) ctx.threads = 3;
    return json::parse(apiCall(cmd, args.dump(), ctx));
}
static json ok(const std::string& cmd, const json& args, Ctx ctx = Ctx()) {
    json r = call(cmd, args, ctx);
    if (!r.value("ok", false)) {
        printf("    command %s failed: %s\n", cmd.c_str(), r.dump().c_str());
        g_fail++;
        return json::object();
    }
    return r["data"];
}

// ---------------------------------------------------------------------------------------------- fixtures
// Procedural "poster": unique, feature-rich, with fine lettering. Deterministic.
static cv::Mat makeScene(int w, int h, unsigned seed) {
    std::mt19937 rng(seed);
    auto U = [&](double a, double b) { return std::uniform_real_distribution<double>(a, b)(rng); };
    cv::Mat img(h, w, CV_8UC3, cv::Scalar(205, 215, 222));
    cv::Mat noise(h / 8, w / 8, CV_8UC3);
    for (int y = 0; y < noise.rows; y++)
        for (int x = 0; x < noise.cols; x++) noise.at<cv::Vec3b>(y, x) = cv::Vec3b((uchar)U(170, 235), (uchar)U(170, 235), (uchar)U(170, 235));
    cv::resize(noise, noise, img.size(), 0, 0, cv::INTER_CUBIC);
    cv::addWeighted(img, 0.5, noise, 0.5, 0, img);
    for (int i = 0; i < 260; i++) {
        cv::Scalar col(U(20, 230), U(20, 230), U(20, 230));
        cv::Point c((int)U(0, w), (int)U(0, h));
        int kind = (int)U(0, 4);
        if (kind == 0) cv::circle(img, c, (int)U(6, 60), col, U(0, 1) < 0.5 ? cv::FILLED : 3, cv::LINE_AA);
        else if (kind == 1) cv::rectangle(img, c, c + cv::Point((int)U(10, 140), (int)U(10, 120)), col, U(0, 1) < 0.4 ? cv::FILLED : 2, cv::LINE_AA);
        else if (kind == 2) cv::line(img, c, c + cv::Point((int)U(-200, 200), (int)U(-200, 200)), col, (int)U(1, 5), cv::LINE_AA);
        else {
            char buf[16];
            snprintf(buf, sizeof(buf), "%c%d%c", 'A' + (int)U(0, 26), (int)U(10, 999), 'a' + (int)U(0, 26));
            cv::putText(img, buf, c, cv::FONT_HERSHEY_SIMPLEX, U(0.4, 1.6), col, (int)U(1, 3), cv::LINE_AA);
        }
    }
    return img;
}

struct View {
    cv::Mat img;
    H3 H;  // scene (continuous) -> view (continuous)
};
// A "camera view": the scene region centred on (cx, cy) covering `cover` of the scene width, rotated by deg.
static View makeView(const cv::Mat& scene, int w, int h, double cx, double cy, double cover, double deg, double persp = 0.0) {
    double s = w / (cover * scene.cols);
    double t = deg * CV_PI / 180;
    H3 R{{std::cos(t), -std::sin(t), 0, std::sin(t), std::cos(t), 0, 0, 0, 1}};
    H3 P{{1, 0, 0, 0, 1, 0, persp, persp * 0.6, 1}};
    H3 H = H3::translate(w / 2.0, h / 2.0) * P * R * H3::scale(s, s) * H3::translate(-cx, -cy);
    View v;
    v.H = H.normalized();
    cv::Mat src = scene;
    if (s < 0.7) cv::GaussianBlur(scene, src, cv::Size(0, 0), 0.45 / s);  // anti-alias the minification
    cv::warpPerspective(src, v.img, toIndexConvention(v.H), cv::Size(w, h), cv::INTER_CUBIC, cv::BORDER_CONSTANT, cv::Scalar(90, 95, 100));
    return v;
}

struct Fixture {
    std::string dir;
    cv::Mat scene;
    View overview;
    std::vector<View> views;
    std::vector<std::string> ids;
};
static void writeImg(const std::string& p, const cv::Mat& m) { cv::imwrite(p, m, {cv::IMWRITE_JPEG_QUALITY, 96}); }
static std::string addFrame(const std::string& dir, const cv::Mat& img, const std::string& name, const std::string& role, const json& extra = json::object()) {
    writeImg(dir + "/originals/" + name, img);
    json a = {{"dir", dir}, {"file", "originals/" + name}, {"role", role}, {"originalName", name}};
    a.update(extra);
    json r = call("frame.add", a);
    return r.value("ok", false) ? r["data"]["id"].get<std::string>() : std::string();
}
// overview + 2x2 close-ups (+ optional extra frames), fully registered
static Fixture makeProject(const std::string& name, unsigned seed = 11, int nClose = 4) {
    Fixture F;
    F.dir = g_tmp + "/" + name;
    fs::remove_all(F.dir);
    ok("project.create", {{"dir", F.dir}, {"name", name}});
    F.scene = makeScene(2400, 1800, seed);
    F.overview = makeView(F.scene, 800, 600, 1200, 900, 1.0, 0.0);
    addFrame(F.dir, F.overview.img, "overview.jpg", "overview");
    const double cs[4][3] = {{650, 480, 3.0}, {1750, 480, -4.0}, {650, 1320, 5.0}, {1750, 1320, -2.0}};
    for (int i = 0; i < nClose; i++) {
        F.views.push_back(makeView(F.scene, 800, 600, cs[i][0], cs[i][1], 0.5, cs[i][2], 2e-5 * (i - 1.5)));
        F.ids.push_back(addFrame(F.dir, F.views.back().img, "close" + std::to_string(i) + ".jpg", "closeup"));
    }
    return F;
}
static json loadProject(const std::string& dir) { return ok("project.load", {{"dir", dir}}); }
static json frameOf(const json& p, const std::string& id) {
    for (auto& f : p["frames"])
        if (f["id"] == id) return f;
    return json::object();
}
static std::string resultDir(const std::string& dir) { return dir + "/results/" + loadProject(dir)["result"]["runId"].get<std::string>(); }
static cv::Mat exportPng(const std::string& dir, const std::string& name, const json& extra = json::object()) {
    json a = {{"dir", dir}, {"format", "png"}, {"path", g_tmp + "/" + name}};
    a.update(extra);
    ok("export.flat", a);
    return cv::imread(g_tmp + "/" + name, cv::IMREAD_COLOR);
}
static double maxAbsDiff(const cv::Mat& a, const cv::Mat& b) {
    if (a.size() != b.size() || a.type() != b.type()) return 1e9;
    cv::Mat d;
    cv::absdiff(a, b, d);
    double mx;
    cv::minMaxLoc(d.reshape(1), nullptr, &mx);
    return mx;
}
static double psnr(const cv::Mat& a, const cv::Mat& b) {
    cv::Mat d;
    cv::absdiff(a, b, d);
    d.convertTo(d, CV_32F);
    double mse = cv::mean(d.mul(d))[0] * 1.0;
    cv::Scalar m = cv::mean(d.mul(d));
    mse = (m[0] + m[1] + m[2]) / 3;
    return mse < 1e-12 ? 99 : 10 * std::log10(255.0 * 255.0 / mse);
}

// ---------------------------------------------------------------------------------------------- tests
static void test_transform_composition() {
    H3 A{{1.1, 0.05, 30, -0.04, 0.95, -12, 1e-5, -2e-5, 1}}, B{{0.7, -0.2, 5, 0.25, 0.8, 9, 3e-5, 1e-5, 1}};
    Pt p{123.4, 567.8};
    Pt q1 = (A * B).apply(p), q2 = A.apply(B.apply(p));
    CHECK_NEAR(q1.x, q2.x, 1e-9);
    CHECK_NEAR(q1.y, q2.y, 1e-9);
    Pt r = A.inverse().apply(A.apply(p));
    CHECK_NEAR(r.x, p.x, 1e-9);
    CHECK_NEAR(r.y, p.y, 1e-9);
    // pixel-centre convention: scaling by 2 maps the centre of pixel 0 (0.5) to 1.0, i.e. between output pixels 0 and 1
    H3 S = H3::scale(2, 2);
    cv::Mat Si = toIndexConvention(S);
    CHECK_NEAR(Si.at<double>(0, 2), 0.5, 1e-12);  // index 0 -> index 0.5
    H3 back = fromIndexConvention(Si);
    for (int i = 0; i < 9; i++) CHECK_NEAR(back.m[i], S.m[i], 1e-12);
    // radial model inverse
    Radial rad(4000, 3000, -0.04);
    for (Pt t : {Pt{10, 20}, Pt{3990, 2980}, Pt{2000, 1500}, Pt{3000, 400}}) {
        Pt u = rad.undistort(t), d = rad.distort(u);
        CHECK_NEAR(d.x, t.x, 1e-6);
        CHECK_NEAR(d.y, t.y, 1e-6);
    }
    FrameModel fm(4000, 3000, A, 0.02);
    Pt c = fm.toCanvas({1234, 2345}), f = fm.toFrame(c);
    CHECK_NEAR(f.x, 1234, 1e-5);
    CHECK_NEAR(f.y, 2345, 1e-5);
    CHECK_NEAR(FrameModel(100, 100, H3::scale(0.25, 0.25), 0).scaleAt({10, 10}), 4.0, 1e-6);
    // validation rejects mirrored / folded / extreme transforms and accepts a plain similarity
    CHECK(validateHomography(H3::scale(0.3, 0.3), 4000, 3000).ok);
    CHECK(!validateHomography(H3{{-1, 0, 100, 0, 1, 0, 0, 0, 1}}, 4000, 3000).ok);
    CHECK(!validateHomography(H3{{1, 0, 0, 0, 1, 0, 0.001, 0, 1}}, 4000, 3000).ok);  // perspective far too strong
    CHECK(!validateHomography(H3{{1, 0, 0, 0, 0.1, 0, 0, 0, 1}}, 4000, 3000).ok);    // 10:1 stretch
    // edit transform: four quarter turns are the identity; crop offsets are integral
    json e = {{"rot90", 1}};
    EditTransform t1 = makeEditTransform(e, 1000, 600);
    CHECK(t1.w == 600 && t1.h == 1000 && t1.integerOnly);
    Pt tl = t1.M.apply(0, 0);
    CHECK_NEAR(tl.x, 600, 1e-9);
    CHECK_NEAR(tl.y, 0, 1e-9);
    H3 M4 = H3::identity();
    int w = 1000, h = 600;
    for (int i = 0; i < 4; i++) {
        EditTransform t = makeEditTransform(e, w, h);
        M4 = t.M * M4;
        w = t.w;
        h = t.h;
    }
    for (int i = 0; i < 9; i++) CHECK_NEAR(M4.m[i], H3::identity().m[i], 1e-9);
    EditTransform tc = makeEditTransform({{"crop", {{"x", 0.1}, {"y", 0.25}, {"w", 0.5}, {"h", 0.5}}}}, 1000, 600);
    CHECK(tc.w == 500 && tc.h == 300 && tc.integerOnly);
    CHECK_NEAR(tc.M.apply(100, 150).x, 0, 1e-9);
    CHECK_NEAR(tc.M.apply(100, 150).y, 0, 1e-9);
    EditTransform ta = makeEditTransform({{"angle", 7.0}}, 1000, 600);
    CHECK(!ta.integerOnly && ta.w < 1000 && ta.h < 600);
    // the inscribed rectangle stays inside the rotated image
    H3 inv = ta.M.inverse();
    for (Pt cpt : {Pt{0, 0}, Pt{(double)ta.w, 0}, Pt{(double)ta.w, (double)ta.h}, Pt{0, (double)ta.h}}) {
        Pt s = inv.apply(cpt);
        CHECK(s.x >= -1.5 && s.y >= -1.5 && s.x <= 1001.5 && s.y <= 601.5);
    }
}

// minimal EXIF APP1 segment with an orientation tag, spliced into a JPEG
static void writeJpegWithOrientation(const std::string& path, const cv::Mat& img, int orientation, bool bigEndian) {
    std::vector<uchar> jpg;
    cv::imencode(".jpg", img, jpg, {cv::IMWRITE_JPEG_QUALITY, 97});
    std::vector<uchar> tiff;
    auto u16 = [&](int v) {
        if (bigEndian) {
            tiff.push_back(v >> 8);
            tiff.push_back(v & 255);
        } else {
            tiff.push_back(v & 255);
            tiff.push_back(v >> 8);
        }
    };
    auto u32 = [&](unsigned v) {
        if (bigEndian) {
            u16(v >> 16);
            u16(v & 0xFFFF);
        } else {
            u16(v & 0xFFFF);
            u16(v >> 16);
        }
    };
    tiff.push_back(bigEndian ? 'M' : 'I');
    tiff.push_back(bigEndian ? 'M' : 'I');
    u16(42);
    u32(8);
    u16(1);
    u16(0x0112);
    u16(3);
    u32(1);
    u16(orientation);
    u16(0);
    u32(0);
    std::vector<uchar> app1 = {0xFF, 0xE1};
    int len = 2 + 6 + (int)tiff.size();
    app1.push_back(len >> 8);
    app1.push_back(len & 255);
    const char* ex = "Exif\0\0";
    app1.insert(app1.end(), ex, ex + 6);
    app1.insert(app1.end(), tiff.begin(), tiff.end());
    std::vector<uchar> out(jpg.begin(), jpg.begin() + 2);
    out.insert(out.end(), app1.begin(), app1.end());
    out.insert(out.end(), jpg.begin() + 2, jpg.end());
    std::ofstream f(path, std::ios::binary);
    f.write((const char*)out.data(), (std::streamsize)out.size());
}

static void test_exif_orientation() {
    // The displayed (oriented) image must be identical for all 8 orientations when the stored raster is the
    // correspondingly transformed version of it.
    cv::Mat shown(120, 200, CV_8UC3, cv::Scalar(40, 40, 40));
    cv::rectangle(shown, cv::Rect(10, 10, 60, 30), cv::Scalar(240, 240, 240), cv::FILLED);   // top-left marker
    cv::rectangle(shown, cv::Rect(150, 80, 40, 30), cv::Scalar(30, 30, 230), cv::FILLED);    // bottom-right, red
    for (int o = 1; o <= 8; o++) {
        // stored = inverse orientation applied to the shown image
        cv::Mat stored;
        switch (o) {
            case 2: cv::flip(shown, stored, 1); break;
            case 3: cv::flip(shown, stored, -1); break;
            case 4: cv::flip(shown, stored, 0); break;
            case 5: cv::transpose(shown, stored); break;
            case 6: cv::rotate(shown, stored, cv::ROTATE_90_COUNTERCLOCKWISE); break;
            case 7: {
                cv::Mat t;
                cv::flip(shown, t, -1);
                cv::transpose(t, stored);
                break;
            }
            case 8: cv::rotate(shown, stored, cv::ROTATE_90_CLOCKWISE); break;
            default: stored = shown.clone();
        }
        std::string path = g_tmp + "/orient" + std::to_string(o) + ".jpg";
        writeJpegWithOrientation(path, stored, o, o % 2 == 0);
        ImageMeta m = readMeta(path);
        CHECK(m.orientation == o);
        CHECK(m.storedW == stored.cols && m.storedH == stored.rows);
        CHECK(m.width() == 200 && m.height() == 120);
        cv::Mat got = loadOriented(path, m, 1, "");
        CHECK(got.size() == shown.size());
        if (got.size() == shown.size()) CHECK(psnr(got, shown) > 35);
        // the continuous-coordinate transform agrees with the raster permutation: centre of stored pixel (sx, sy)
        H3 T = orientationTransform(o, stored.cols, stored.rows);
        cv::Mat probe(stored.rows, stored.cols, CV_8UC1, cv::Scalar(0)), oriented;
        int sx = 17, sy = 5;
        probe.at<uchar>(sy, sx) = 255;
        applyOrientation(probe, oriented, o);
        cv::Point loc;
        cv::minMaxLoc(oriented, nullptr, nullptr, nullptr, &loc);
        Pt q = T.apply(sx + 0.5, sy + 0.5);
        CHECK_NEAR(q.x, loc.x + 0.5, 1e-9);
        CHECK_NEAR(q.y, loc.y + 0.5, 1e-9);
    }
    // reduced decoding keeps the exact 1/r coordinate scale
    cv::Mat big = makeScene(1003, 701, 3);
    writeJpegWithOrientation(g_tmp + "/odd.jpg", big, 6, false);
    ImageMeta m = readMeta(g_tmp + "/odd.jpg");
    cv::Mat r2 = loadOriented(g_tmp + "/odd.jpg", m, 2, "");
    CHECK(r2.cols == (701 + 1) / 2 && r2.rows == (1003 + 1) / 2);
}

static void test_registration_outliers() {
    // synthetic correspondences: 55 % follow a known homography (with noise), 45 % are gross outliers
    std::mt19937 rng(5);
    auto U = [&](double a, double b) { return std::uniform_real_distribution<double>(a, b)(rng); };
    auto N = [&](double s) { return std::normal_distribution<double>(0, s)(rng); };
    H3 Ht{{0.31, 0.02, 400, -0.015, 0.30, 250, 4e-6, -3e-6, 1}};
    Features A, B;
    A.imgW = 4000; A.imgH = 3000; B.imgW = 4000; B.imgH = 3000;
    const int n = 600;
    A.desc = cv::Mat(n, 128, CV_32F);
    B.desc = cv::Mat(n, 128, CV_32F);
    for (int i = 0; i < n; i++) {
        cv::Point2f p((float)U(50, 3950), (float)U(50, 2950));
        A.pts.push_back(p);
        A.size.push_back(12);
        A.angle.push_back(0);
        float* d = A.desc.ptr<float>(i);
        double nn = 0;
        for (int k = 0; k < 128; k++) {
            d[k] = (float)std::abs(N(1));
            nn += d[k] * d[k];
        }
        for (int k = 0; k < 128; k++) d[k] /= (float)std::sqrt(nn);
        A.desc.row(i).copyTo(B.desc.row(i));
        Pt q = Ht.apply(p.x, p.y);
        if (i % 20 < 11) B.pts.push_back(cv::Point2f((float)(q.x + N(0.4)), (float)(q.y + N(0.4))));
        else B.pts.push_back(cv::Point2f((float)U(0, 4000), (float)U(0, 3000)));  // outlier
        B.size.push_back(12 * 0.31f);
        B.angle.push_back(0);
    }
    PairOptions po;
    po.requireAinsideB = true;
    PairResult r = estimatePair(A, B, po);
    CHECK(r.ok);
    CHECK(r.nInliers >= 300 && r.nInliers <= 345);
    double worst = 0;
    for (Pt c : {Pt{0, 0}, Pt{4000, 0}, Pt{4000, 3000}, Pt{0, 3000}, Pt{2000, 1500}}) {
        Pt a = r.H.apply(c), b = Ht.apply(c);
        worst = std::max(worst, std::hypot(a.x - b.x, a.y - b.y));
    }
    CHECK(worst < 0.6);
    CHECK_NEAR(r.scale, 1 / 0.305, 0.08);
    CHECK(!r.ambiguous);
    // pure outliers: nothing is accepted
    Features C = B;
    for (auto& p : C.pts) p = cv::Point2f((float)U(0, 4000), (float)U(0, 3000));
    CHECK(!estimatePair(A, C, po).ok);
    // degenerate: all matches on one line cannot define a homography
    Features L = B, LA = A;
    for (int i = 0; i < n; i++) {
        LA.pts[i] = cv::Point2f((float)(100 + i * 6), 1500.f);
        L.pts[i] = cv::Point2f((float)(400 + i * 1.8), 700.f);
    }
    CHECK(!estimatePair(LA, L, po).ok);
    // mirrored placement is rejected even with perfect matches
    Features Mi = B;
    for (int i = 0; i < n; i++) {
        Mi.pts[i] = cv::Point2f(1300 - A.pts[i].x * 0.3f, 100 + A.pts[i].y * 0.3f);
        Mi.angle[i] = 0;
    }
    PairOptions pm = po;
    pm.checkAmbiguity = false;
    PairResult rm = estimatePair(A, Mi, pm);
    CHECK(!rm.ok);
    // global refinement recovers perturbed transforms from exact observations
    std::vector<BAFrame> fr(2);
    H3 H1 = H3{{0.3, 0.01, 100, -0.01, 0.3, 80, 0, 0, 1}}, H2 = H3{{0.3, -0.01, 900, 0.01, 0.3, 90, 0, 0, 1}};
    fr[0] = {4000, 3000, H3::translate(3, -2) * H1, -1};
    fr[1] = {4000, 3000, H3::translate(-4, 5) * H2, -1};
    std::vector<BAObs> obs;
    for (int i = 0; i < 80; i++) {
        Pt p{U(0, 4000), U(0, 3000)};
        obs.push_back({0, -1, p, H1.apply(p), 1.0, 1.0});
        obs.push_back({1, -1, p, H2.apply(p), 1.0, 1.0});
        Pt c{U(900, 1300), U(100, 900)};  // overlap in canvas
        obs.push_back({0, 1, H1.inverse().apply(c), H2.inverse().apply(c), 1.0, 3.3});
    }
    BAOptions bo;
    bo.ovW = 4000;
    bo.ovH = 3000;
    BAResult br = bundleAdjust(fr, obs, 0, {}, bo);
    CHECK(br.cost < 1e-6 && br.cost0 > 1);
    CHECK_NEAR(fr[0].H.apply(2000, 1500).x, H1.apply(2000, 1500).x, 1e-3);
    CHECK_NEAR(fr[1].H.apply(2000, 1500).y, H2.apply(2000, 1500).y, 1e-3);
}

static void test_end_to_end_and_coverage() {
    Fixture F = makeProject("e2e");
    json reg = ok("register", {{"dir", F.dir}});
    CHECK(reg.value("accepted", 0) == 4);
    json p = loadProject(F.dir);
    printf("    close-up blur estimates:");
    for (auto& id : F.ids) printf(" %.2f", frameOf(p, id)["quality"]["sharpSigma"].get<double>());
    printf(" px\n");
    // registration error against the known views (overview px): estimated H must equal overviewH * viewH^-1
    double worst = 0;
    for (size_t i = 0; i < F.ids.size(); i++) {
        json f = frameOf(p, F.ids[i]);
        CHECK(f["reg"]["status"] == "accepted");
        H3 He = H3::fromJson(f["reg"]["H"]), Hg = (F.overview.H * F.views[i].H.inverse()).normalized();
        for (Pt c : {Pt{40, 40}, Pt{760, 40}, Pt{760, 560}, Pt{40, 560}, Pt{400, 300}}) {
            Pt a = He.apply(c), b = Hg.apply(c);
            worst = std::max(worst, std::hypot(a.x - b.x, a.y - b.y));
        }
        CHECK_NEAR(f["reg"]["scale"].get<double>(), 2.0, 0.07);
    }
    printf("    worst registration error: %.3f overview px\n", worst);
    CHECK(worst < 0.5);
    json cov = ok("coverage", {{"dir", F.dir}});
    double covered = cov["stats"]["coveredFrac"];
    printf("    coverage at >=1.5x: %.1f %%\n", covered * 100);
    CHECK(covered > 0.40 && covered <= 1.0);
    CHECK(fs::exists(F.dir + "/work/coverage.png"));
    // coverage is derived from accepted footprints: excluding a frame must reduce it by about its unique area
    ok("frame.update", {{"dir", F.dir}, {"id", F.ids[0]}, {"user", {{"included", false}}}});
    json cov2 = ok("coverage", {{"dir", F.dir}});
    CHECK(cov2["stats"]["coveredFrac"].get<double>() < covered - 0.07);
    CHECK(cov2["frames"] == 3);
    ok("undo", {{"dir", F.dir}});
    CHECK_NEAR(ok("coverage", {{"dir", F.dir}})["stats"]["coveredFrac"].get<double>(), covered, 1e-9);

    json res = ok("compose", {{"dir", F.dir}});
    CHECK(res["width"].get<int>() > 1200 && res["height"].get<int>() > 900);
    CHECK(res["scale"].get<double>() > 1.5 && res["scale"].get<double>() <= 2.1);
    std::string rd = resultDir(F.dir);
    json man = json::parse(readFile(rd + "/manifest.json"));
    // provenance: every full-resolution tile lists its sources, fractions sum to 1, ids exist
    Pyramid pyr(man["width"], man["height"], man["tileSize"]);
    int tiles = 0;
    for (int r = 0; r < pyr.rows(pyr.maxLevel); r++)
        for (int c = 0; c < pyr.cols(pyr.maxLevel); c++) {
            std::string key = std::to_string(c) + "_" + std::to_string(r);
            CHECK(man["provenance"].contains(key));
            CHECK(fs::exists(tilePath(rd + "/tiles", pyr.maxLevel, c, r, "png")));
            double sum = 0;
            for (auto& e : man["provenance"][key]) {
                sum += e[1].get<double>();
                CHECK(!frameOf(p, e[0].get<std::string>()).empty());
            }
            CHECK_NEAR(sum, 1.0, 0.01);
            tiles++;
        }
    CHECK(tiles == pyr.cols(pyr.maxLevel) * pyr.rows(pyr.maxLevel));
    // the centre of each close-up footprint is taken from a close-up; a corner of the canvas outside all
    // footprints is overview-only
    for (size_t i = 0; i < F.ids.size(); i++) {
        Pt c = (F.overview.H * F.views[i].H.inverse()).apply(400, 300);
        json ins = ok("inspect.point", {{"dir", F.dir}, {"x", c.x * man["scaleX"].get<double>()}, {"y", c.y * man["scaleY"].get<double>()}});
        CHECK(ins["label"].get<int>() > 0);
        CHECK(ins["source"]["id"] == F.ids[i]);
        CHECK_NEAR(ins["source"]["fx"].get<double>(), 400, 2.0);
        CHECK_NEAR(ins["source"]["fy"].get<double>(), 300, 2.0);
    }
    // detail statistics separate grid size from genuine detail
    CHECK(man["stats"]["estimatedDetailMP"].get<double>() < man["stats"]["outputMP"].get<double>() + 1e-6);
    CHECK(man["stats"]["estimatedDetailMP"].get<double>() > man["stats"]["overviewMP"].get<double>());
    // content: the fused image is closer to the true scene than the enlarged overview is
    cv::Mat fused = exportPng(F.dir, "e2e.png");
    CHECK(fused.cols == man["width"].get<int>() && fused.rows == man["height"].get<int>());
    H3 toScene = F.overview.H.inverse() * H3::scale(1.0 / man["scaleX"].get<double>(), 1.0 / man["scaleY"].get<double>());
    cv::Mat ref, up;
    cv::Mat sceneBlur;
    cv::GaussianBlur(F.scene, sceneBlur, cv::Size(0, 0), 0.6);
    cv::warpPerspective(sceneBlur, ref, toIndexConvention(toScene.inverse()), fused.size(), cv::INTER_CUBIC);
    cv::resize(F.overview.img, up, fused.size(), 0, 0, cv::INTER_CUBIC);
    // compare where the scene actually has detail (the flat background says nothing about resolution)
    cv::Mat rg, gx, gy, mag;
    cv::cvtColor(ref, rg, cv::COLOR_BGR2GRAY);
    cv::Sobel(rg, gx, CV_32F, 1, 0);
    cv::Sobel(rg, gy, CV_32F, 0, 1);
    cv::magnitude(gx, gy, mag);
    cv::Mat detail = mag > 120;
    cv::dilate(detail, detail, cv::Mat(), cv::Point(-1, -1), 2);
    cv::Mat border(detail.size(), CV_8U, cv::Scalar(0));
    border(cv::Rect(fused.cols / 8, fused.rows / 8, fused.cols * 3 / 4, fused.rows * 3 / 4)).setTo(255);
    detail &= border;
    auto mseOn = [&](const cv::Mat& x) {
        cv::Mat d;
        cv::absdiff(x, ref, d);
        d.convertTo(d, CV_32F);
        cv::Scalar m = cv::mean(d.mul(d), detail);
        return (m[0] + m[1] + m[2]) / 3;
    };
    double pf = 10 * std::log10(255.0 * 255.0 / mseOn(fused)), pu = 10 * std::log10(255.0 * 255.0 / mseOn(up));
    printf("    PSNR on detailed pixels vs scene: fused %.2f dB, enlarged overview %.2f dB\n", pf, pu);
    CHECK(pf > pu + 3.0);
}

static void test_disconnected_graph() {
    // Two photos of a DIFFERENT poster overlap each other but not the overview: they must not be given positions.
    Fixture F = makeProject("disconnected", 21, 2);
    cv::Mat other = makeScene(2400, 1800, 777);
    View a = makeView(other, 800, 600, 900, 800, 0.5, 2.0), b = makeView(other, 800, 600, 1400, 850, 0.5, -3.0);
    std::string ia = addFrame(F.dir, a.img, "island_a.jpg", "closeup"), ib = addFrame(F.dir, b.img, "island_b.jpg", "closeup");
    json reg = ok("register", {{"dir", F.dir}});
    json p = loadProject(F.dir);
    for (const std::string& id : {ia, ib}) {
        json f = frameOf(p, id);
        CHECK(f["reg"]["status"] == "rejected");
        CHECK(!f["reg"].contains("H") && !f["reg"].contains("footprint"));
        bool disc = false;
        for (auto& r : f["reg"]["reasons"])
            if (r == "disconnected") disc = true;
        CHECK(disc);
        CHECK(f["reg"]["messages"].size() >= 1);
    }
    CHECK(reg["accepted"] == 2 && reg["rejected"] == 2);
    // the pair itself did match (that is what makes it an island rather than noise)
    json pr = ok("debug.pair", {{"dir", F.dir}, {"a", ia}, {"b", ib}});
    CHECK(pr["ok"] == true);
    // a blurred duplicate and a same-scale copy add no detail and are rejected with the right reason
    cv::Mat blurred;
    cv::GaussianBlur(F.views[0].img, blurred, cv::Size(0, 0), 6);
    std::string ibl = addFrame(F.dir, blurred, "blurred.jpg", "closeup");
    std::string isame = addFrame(F.dir, makeView(F.scene, 800, 600, 1200, 900, 0.95, 1.0).img, "same.jpg", "closeup");
    ok("register", {{"dir", F.dir}});
    p = loadProject(F.dir);
    CHECK(frameOf(p, ibl)["reg"]["status"] == "rejected");
    CHECK(frameOf(p, ibl)["reg"]["reasons"][0] == "blurry");
    CHECK(frameOf(p, isame)["reg"]["status"] == "rejected");
    CHECK(frameOf(p, isame)["reg"]["reasons"][0] == "no_detail_gain");
    // manual correspondences place a frame through the same graph and are flagged as manual
    Fixture G = makeProject("manual", 31, 1);
    json mp = json::array();
    H3 Hg = (G.overview.H * G.views[0].H.inverse()).normalized();
    for (Pt c : {Pt{100, 100}, Pt{700, 120}, Pt{680, 500}, Pt{120, 480}, Pt{400, 300}}) {
        Pt o = Hg.apply(c);
        mp.push_back({{"fx", c.x}, {"fy", c.y}, {"ox", o.x + 1.5}, {"oy", o.y - 1.0}});  // imprecise taps
    }
    ok("frame.update", {{"dir", G.dir}, {"id", G.ids[0]}, {"user", {{"manualPoints", mp}}}});
    ok("register", {{"dir", G.dir}});
    json f = frameOf(loadProject(G.dir), G.ids[0]);
    CHECK(f["reg"]["status"] == "accepted");
    CHECK(f["reg"]["via"].get<std::string>().rfind("manual", 0) == 0);
    Pt e = H3::fromJson(f["reg"]["H"]).apply(400, 300), g = Hg.apply(400, 300);
    CHECK(std::hypot(e.x - g.x, e.y - g.y) < 0.5);  // refined beyond the precision of the taps
}

static void test_tile_boundaries() {
    Fixture F = makeProject("tiles", 41);
    ok("register", {{"dir", F.dir}});
    ok("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}});
    cv::Mat a = exportPng(F.dir, "tiles512.png");
    std::string rdA = resultDir(F.dir);
    json manA = json::parse(readFile(rdA + "/manifest.json"));
    // lower pyramid levels are exact 2x2 area averages of the level above (checked across tile borders)
    Pyramid pyr(manA["width"], manA["height"], manA["tileSize"]);
    ImageCache cache(256u << 20);
    cv::Mat L0 = readPyramidRect(rdA + "/tiles", pyr, pyr.maxLevel, cv::Rect(0, 0, pyr.w, pyr.h), "png", cache);
    CHECK(maxAbsDiff(L0, a) == 0);
    cv::Mat L1 = readPyramidRect(rdA + "/tiles", pyr, pyr.maxLevel - 1, cv::Rect(0, 0, pyr.levelW(pyr.maxLevel - 1), pyr.levelH(pyr.maxLevel - 1)), "png", cache);
    cv::Mat pad = L0, down;
    if ((L0.cols & 1) || (L0.rows & 1)) cv::copyMakeBorder(L0, pad, 0, L0.rows & 1, 0, L0.cols & 1, cv::BORDER_REPLICATE);
    cv::resize(pad, down, L1.size(), 0, 0, cv::INTER_AREA);
    CHECK(maxAbsDiff(down, L1) <= 1);
    CHECK(L1.cols == (L0.cols + 1) / 2);
    // rendering in different block layouts gives the same image: no seams at block borders
    ok("compose", {{"dir", F.dir}, {"blockSize", 1024}, {"scale", 2.0}});
    cv::Mat b = exportPng(F.dir, "tiles1024.png");
    double d = maxAbsDiff(a, b);
    printf("    512 vs 1024 block layout: max abs difference %.0f grey levels\n", d);
    CHECK(d <= 1);
    // no discontinuity across a tile border beyond what the image content has across any other column
    cv::Mat g;
    cv::cvtColor(a, g, cv::COLOR_BGR2GRAY);
    g.convertTo(g, CV_32F);
    auto colJump = [&](int x) { return cv::mean(cv::abs(g.col(x) - g.col(x - 1)))[0]; };
    double border = colJump(512), ref = 0;
    for (int x = 500; x < 524; x++)
        if (x != 512) ref = std::max(ref, colJump(x));
    CHECK(border <= ref * 1.5 + 0.5);
}

static void test_cancel_restart() {
    Fixture F = makeProject("cancel", 51);
    ok("register", {{"dir", F.dir}});
    json first = ok("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}});
    std::string run1 = first["runId"];
    cv::Mat before = exportPng(F.dir, "cancel_before.png");
    // change the inputs, then cancel the recompute part-way through rendering
    ok("frame.update", {{"dir", F.dir}, {"id", F.ids[3]}, {"user", {{"included", false}}}});
    CHECK(loadProject(F.dir)["result"]["stale"] == true);
    Ctx ctx;
    ctx.threads = 1;
    ctx.cancel = std::make_shared<std::atomic<bool>>(false);
    int rendered = 0;
    ctx.progress = [&](const std::string& stage, double, const std::string&) {
        if (stage == "Rendering detail tiles" && ++rendered >= 4) ctx.cancel->store(true);
    };
    json r = call("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}}, ctx);
    CHECK(r["ok"] == false && r["error"]["code"] == "cancelled");
    json p = loadProject(F.dir);
    // the last valid output is untouched and still readable
    CHECK(p["result"]["runId"] == run1);
    CHECK(p["job"]["state"] == "cancelled" && p["job"]["resumable"] == true);
    CHECK(maxAbsDiff(exportPng(F.dir, "cancel_still.png"), before) == 0);
    // a partial run directory with a journal exists
    int tmpDirs = 0, journalLines = 0;
    for (auto& e : fs::directory_iterator(F.dir + "/results"))
        if (e.path().extension() == ".tmp") {
            tmpDirs++;
            std::ifstream in(e.path().string() + "/blocks.jsonl");
            std::string line;
            while (std::getline(in, line)) journalLines++;
        }
    CHECK(tmpDirs == 1);
    CHECK(journalLines >= 3);
    // "process restart": drop in-memory caches, mark the job as interrupted on load, then resume
    dropSessionCaches();
    json rec = ok("project.load", {{"dir", F.dir}, {"recover", true}});
    CHECK(rec["job"]["state"] == "cancelled");
    json second = ok("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}});
    CHECK(second["stats"]["blocksResumed"].get<int>() >= 3);
    CHECK(second["runId"] != run1);
    CHECK(!fs::exists(F.dir + "/results/" + run1));  // old result removed only after the new one is committed
    cv::Mat resumed = exportPng(F.dir, "cancel_resumed.png");
    // identical to an uninterrupted run of the same inputs
    Fixture G = makeProject("cancel_ref", 51);
    ok("register", {{"dir", G.dir}});
    ok("frame.update", {{"dir", G.dir}, {"id", G.ids[3]}, {"user", {{"included", false}}}});
    ok("compose", {{"dir", G.dir}, {"blockSize", 512}, {"scale", 2.0}});
    cv::Mat fresh = exportPng(G.dir, "cancel_fresh.png");
    CHECK(maxAbsDiff(resumed, fresh) == 0);
    CHECK(maxAbsDiff(resumed, before) > 5);  // and it really is a different image than before the change
    // incremental recompute: re-including the frame reuses unchanged blocks from the committed result
    ok("undo", {{"dir", F.dir}});
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"overrides", json::array({{{"x", 100}, {"y", 100}, {"r", 40}, {"frame", "overview"}, {"mode", "prefer"}}})}}}});
    json third = ok("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}});
    json fourth = ok("compose", {{"dir", F.dir}, {"blockSize", 512}, {"scale", 2.0}});
    CHECK(fourth["stats"]["blocksReused"].get<int>() == fourth["stats"]["blocks"].get<int>());
    (void)third;
    // an interrupted job is reported after a crash (state still "running" on disk)
    {
        Project P = Project::load(F.dir);
        P.j["job"] = {{"type", "compose"}, {"state", "running"}};
        P.save();
    }
    CHECK(ok("project.load", {{"dir", F.dir}, {"recover", true}})["job"]["state"] == "interrupted");
}

static void test_persistence_undo() {
    Fixture F = makeProject("undo", 61, 2);
    ok("register", {{"dir", F.dir}});
    json p0 = loadProject(F.dir);
    CHECK(p0["undo"].empty());
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"rot90", 1}}}});
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"crop", {{"x", 0.1}, {"y", 0.1}, {"w", 0.5}, {"h", 0.5}}}}}});
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"color", {{"exposure", 0.5}, {"contrast", 0.2}, {"saturation", 0.0}, {"temperature", 0.0}, {"tint", 0.0}}}}}});
    ok("frame.update", {{"dir", F.dir}, {"id", F.ids[0]}, {"user", {{"removed", true}}}});
    json p1 = loadProject(F.dir);
    CHECK(p1["edits"]["rot90"] == 1 && p1["edits"]["crop"]["w"] == 0.5 && p1["edits"]["color"]["exposure"] == 0.5);
    CHECK(frameOf(p1, F.ids[0])["user"]["removed"] == true);
    CHECK(p1["undo"].size() == 4);
    // state survives a "restart" (fresh read from disk) byte-for-byte
    dropSessionCaches();
    CHECK(json::parse(readFile(F.dir + "/project.json")) == p1);
    CHECK(!fs::exists(F.dir + "/project.json.tmp"));
    // the removed frame's original is still on disk (removal is reversible)
    CHECK(fs::exists(F.dir + "/" + frameOf(p1, F.ids[0])["file"].get<std::string>()));
    json u1 = ok("undo", {{"dir", F.dir}});
    CHECK(frameOf(u1, F.ids[0])["user"]["removed"] == false && u1["edits"]["color"]["exposure"] == 0.5);
    json u2 = ok("undo", {{"dir", F.dir}});
    CHECK(u2["edits"]["color"]["exposure"] == 0.0 && u2["edits"]["crop"]["w"] == 0.5);
    json u3 = ok("undo", {{"dir", F.dir}});
    CHECK(u3["edits"]["crop"].is_null() && u3["edits"]["rot90"] == 1);
    json r1 = ok("redo", {{"dir", F.dir}});
    CHECK(r1["edits"]["crop"]["w"] == 0.5);
    // a new edit clears the redo stack
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"angle", 3.0}}}});
    json r2 = ok("redo", {{"dir", F.dir}});
    CHECK(r2["_changed"] == false);
    ok("undo", {{"dir", F.dir}});
    ok("undo", {{"dir", F.dir}});
    ok("undo", {{"dir", F.dir}});
    json end = ok("undo", {{"dir", F.dir}});
    CHECK(end["_changed"] == false);
    CHECK(end["edits"] == p0["edits"]);
    // originals are byte-identical to what was imported
    std::string orig = F.dir + "/" + frameOf(p0, F.ids[1])["file"].get<std::string>();
    std::string bytesBefore = readFile(orig);
    ok("register", {{"dir", F.dir}, {"full", true}});
    ok("compose", {{"dir", F.dir}});
    CHECK(readFile(orig) == bytesBefore);
    // a damaged project file is reported, not silently replaced
    {
        std::string dmg = g_tmp + "/damaged";
        fs::create_directories(dmg);
        std::ofstream(dmg + "/project.json") << "{ this is not json";
        json r = call("project.load", {{"dir", dmg}});
        CHECK(r["ok"] == false && r["error"]["code"] == "corrupt_project");
    }
    // unsupported / tiny inputs are refused with a message and leave the project unchanged
    cv::Mat tiny(100, 100, CV_8UC3, cv::Scalar(1, 2, 3));
    size_t before = loadProject(F.dir)["frames"].size();
    CHECK(addFrame(F.dir, tiny, "tiny.jpg", "closeup").empty());
    std::ofstream(F.dir + "/originals/garbage.jpg") << "not an image";
    CHECK(call("frame.add", {{"dir", F.dir}, {"file", "originals/garbage.jpg"}, {"role", "closeup"}})["ok"] == false);
    {
        // a truncated JPEG decodes "successfully" (grey tail) in most decoders: it must be refused, not imported
        std::string full = readFile(F.dir + "/originals/close0.jpg");
        std::ofstream(F.dir + "/originals/truncated.jpg", std::ios::binary).write(full.data(), (std::streamsize)(full.size() * 2 / 3));
        json r = call("frame.add", {{"dir", F.dir}, {"file", "originals/truncated.jpg"}, {"role", "closeup"}});
        CHECK(r["ok"] == false && r["error"]["code"] == "truncated");
    }
    CHECK(loadProject(F.dir)["frames"].size() == before);
}

static void test_export() {
    Fixture F = makeProject("export", 71);
    ok("register", {{"dir", F.dir}});
    json res = ok("compose", {{"dir", F.dir}, {"scale", 1.8}});
    const int W = res["width"], H = res["height"];
    CHECK(W == (int)std::lround(800 * 1.8) && H == (int)std::lround(600 * 1.8));  // never silently the overview size
    std::string rd = resultDir(F.dir);
    Pyramid pyr(W, H, 512);
    ImageCache cache(256u << 20);
    cv::Mat base = readPyramidRect(rd + "/tiles", pyr, pyr.maxLevel, cv::Rect(0, 0, W, H), "png", cache);
    // PNG and TIFF are lossless and identical to the tiles; JPEG is close
    cv::Mat png = exportPng(F.dir, "exp.png");
    CHECK(maxAbsDiff(png, base) == 0);
    json jt = ok("export.flat", {{"dir", F.dir}, {"format", "tiff"}, {"path", g_tmp + "/exp.tif"}});
    cv::Mat tif = cv::imread(g_tmp + "/exp.tif", cv::IMREAD_COLOR);
    CHECK(jt["width"] == W && jt["height"] == H);
    CHECK(maxAbsDiff(tif, base) == 0);
    json jb = ok("export.flat", {{"dir", F.dir}, {"format", "tiff"}, {"path", g_tmp + "/exp_big.tif"}, {"bigTiff", true}});
    {
        std::string hd = readFile(g_tmp + "/exp_big.tif").substr(0, 4);
        CHECK(hd[0] == 'I' && hd[2] == 43);  // BigTIFF magic
        (void)jb;
    }
    json jj = ok("export.flat", {{"dir", F.dir}, {"format", "jpeg"}, {"path", g_tmp + "/exp.jpg"}, {"quality", 95}});
    cv::Mat jpg = cv::imread(g_tmp + "/exp.jpg", cv::IMREAD_COLOR);
    CHECK(jpg.cols == W && jpg.rows == H);
    double pj = psnr(jpg, base);
    printf("    streaming JPEG q95 PSNR vs lossless: %.2f dB\n", pj);
    CHECK(pj > 38);
    CHECK(jj["notes"].size() >= 1);
    // 90-degree rotation and crop are exact pixel permutations
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"rot90", 1}}}});
    cv::Mat rot = exportPng(F.dir, "exp_rot.png"), expect;
    cv::rotate(base, expect, cv::ROTATE_90_CLOCKWISE);
    CHECK(maxAbsDiff(rot, expect) == 0);
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"rot90", 0}, {"crop", {{"x", 0.25}, {"y", 0.5}, {"w", 0.5}, {"h", 0.25}}}}}});
    cv::Mat crop = exportPng(F.dir, "exp_crop.png");
    cv::Rect cr((int)std::lround(0.25 * W), (int)std::lround(0.5 * H), (int)std::lround(0.5 * W), (int)std::lround(0.25 * H));
    CHECK(crop.size() == cr.size());
    CHECK(maxAbsDiff(crop, base(cr)) == 0);
    // unedited export still available
    CHECK(maxAbsDiff(exportPng(F.dir, "exp_noedit.png", {{"applyEdits", false}}), base) == 0);
    // colour edit matches the documented affine on encoded values
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"crop", nullptr}, {"color", {{"exposure", 0.0}, {"contrast", 0.0}, {"saturation", -1.0}, {"temperature", 0.0}, {"tint", 0.0}}}}}});
    cv::Mat grayExp = exportPng(F.dir, "exp_gray.png");
    cv::Vec3b px = grayExp.at<cv::Vec3b>(H / 2, W / 2), src = base.at<cv::Vec3b>(H / 2, W / 2);
    CHECK(std::abs(px[0] - px[1]) <= 1 && std::abs(px[1] - px[2]) <= 1);
    CHECK_NEAR(px[1], 0.2126 * src[2] + 0.7152 * src[1] + 0.0722 * src[0], 1.5);
    ok("undo", {{"dir", F.dir}});
    // scaled export uses the pyramid and reports its true size
    json js = ok("export.flat", {{"dir", F.dir}, {"format", "png"}, {"path", g_tmp + "/exp_half.png"}, {"scale", 0.5}, {"applyEdits", false}});
    CHECK(js["width"] == (int)std::lround(W * 0.5) && js["resampled"] == true);
    // tile package: standard DZI, offline viewer, provenance manifest
    json jp = ok("export.tiles", {{"dir", F.dir}, {"outDir", g_tmp + "/pkg"}, {"format", "png"}, {"applyEdits", false}});
    CHECK(jp["width"] == W && jp["lossless"] == true);
    CHECK(fs::exists(g_tmp + "/pkg/image.dzi") && fs::exists(g_tmp + "/pkg/viewer.html") && fs::exists(g_tmp + "/pkg/manifest.json"));
    std::string dzi = readFile(g_tmp + "/pkg/image.dzi");
    CHECK(dzi.find("Width=\"" + std::to_string(W) + "\"") != std::string::npos);
    CHECK(readFile(g_tmp + "/pkg/viewer.html").find("\"maxLevel\":" + std::to_string(pyr.maxLevel)) != std::string::npos);
    cv::Mat t00 = cv::imread(tilePath(g_tmp + "/pkg/image_files", pyr.maxLevel, 0, 0, "png"));
    CHECK(maxAbsDiff(t00, base(cv::Rect(0, 0, 512, 512))) == 0);
    CHECK(fs::exists(tilePath(g_tmp + "/pkg/image_files", 0, 0, 0, "png")));  // down to the 1x1 level
    // edited JPEG tile package has the edited dimensions
    ok("edits.set", {{"dir", F.dir}, {"edits", {{"rot90", 1}, {"crop", nullptr}}}});
    json jp2 = ok("export.tiles", {{"dir", F.dir}, {"outDir", g_tmp + "/pkg2"}, {"format", "jpeg"}});
    CHECK(jp2["width"] == H && jp2["height"] == W && jp2["lossless"] == false);
    // JPEG's hard format limit is reported, not worked around by down-scaling

    try {
        auto w = makeJpegWriter(g_tmp + "/toolarge.jpg", 70000, 10, 90, {});
        CHECK(false);
    } catch (const UserError& e) {
        CHECK(e.code == "too_large");
    }
    // streaming writers on awkward sizes round-trip exactly (PNG/TIFF) or closely (JPEG)
    for (cv::Size sz : {cv::Size(1, 1), cv::Size(17, 13), cv::Size(333, 5), cv::Size(640, 479)}) {
        cv::Mat img = makeScene(std::max(64, sz.width), std::max(64, sz.height), 9)(cv::Rect(0, 0, sz.width, sz.height)).clone();
        for (const char* fmt : {"png", "tif", "jpg"}) {
            std::string path = g_tmp + "/w." + fmt;
            std::unique_ptr<RowWriter> w;
            if (!strcmp(fmt, "png")) w = makePngWriter(path, sz.width, sz.height, {}, 6);
            else if (!strcmp(fmt, "tif")) w = makeTiffWriter(path, sz.width, sz.height, {}, false);
            else w = makeJpegWriter(path, sz.width, sz.height, 97, {});
            for (int y = 0; y < sz.height; y += 7) w->writeRows(img.rowRange(y, std::min(sz.height, y + 7)));
            w->finish();
            cv::Mat back = cv::imread(path, cv::IMREAD_COLOR);
            CHECK(back.size() == img.size());
            if (back.size() != img.size()) continue;
            if (strcmp(fmt, "jpg")) CHECK(maxAbsDiff(back, img) == 0);
            else CHECK(psnr(back, img) > 30);
        }
    }
    // ICC pass-through: a profile given to the PNG writer is found again by the metadata reader
    {
        std::vector<uint8_t> icc(600, 0);
        memcpy(&icc[16], "RGB ", 4);
        icc[131] = 3;
        const char* tags[3] = {"rXYZ", "gXYZ", "bXYZ"};
        const double p3[3][3] = {{0.5151, 0.2412, -0.0011}, {0.2920, 0.6922, 0.0419}, {0.1571, 0.0666, 0.7841}};
        for (int i = 0; i < 3; i++) {
            uint8_t* e = &icc[132 + i * 12];
            memcpy(e, tags[i], 4);
            uint32_t off = 200 + i * 20;
            e[4] = 0; e[5] = 0; e[6] = off >> 8; e[7] = off & 255;
            e[11] = 20;
            memcpy(&icc[off], "XYZ ", 4);
            for (int c = 0; c < 3; c++) {
                int32_t v = (int32_t)std::lround(p3[i][c] * 65536);
                uint8_t* d = &icc[off + 8 + c * 4];
                d[0] = (v >> 24) & 255; d[1] = (v >> 16) & 255; d[2] = (v >> 8) & 255; d[3] = v & 255;
            }
        }
        cv::Mat img = makeScene(64, 64, 2);
        for (const char* fmt : {"png", "jpg"}) {
            std::string path = g_tmp + std::string("/icc.") + fmt;
            auto w = !strcmp(fmt, "png") ? makePngWriter(path, 64, 64, icc, 6) : makeJpegWriter(path, 64, 64, 95, icc);
            w->writeRows(img);
            w->finish();
            ImageMeta m = readMeta(path);
            CHECK(m.hasIcc && m.icc == icc);
            CHECK(m.colorSpace == "Display P3");
        }
        cv::Mat conv = img.clone();
        CHECK(convertColorSpace(conv, "sRGB", "Display P3"));  // sRGB is inside P3: lossless up to rounding
        CHECK(maxAbsDiff(conv, img) > 0);
        cv::Mat back = conv.clone();
        convertColorSpace(back, "Display P3", "sRGB");
        CHECK(maxAbsDiff(back, img) <= 2);
        CHECK(!convertColorSpace(back, "unknown", "sRGB"));
    }
    // measurement: pixels only until an explicit reference with uncertainty is supplied
    json m0 = ok("measure", {{"dir", F.dir}, {"x1", 100}, {"y1", 100}, {"x2", 400}, {"y2", 500}});
    CHECK(m0["calibrated"] == false && !m0.contains("unit"));
    CHECK_NEAR(m0["canvasPx"].get<double>(), 500, 1e-9);
    ok("edits.set", {{"dir", F.dir}, {"calibration", {{"x1", 0}, {"y1", 0}, {"x2", 250}, {"y2", 0}, {"length", 100.0}, {"unit", "mm"}, {"lengthSigma", 0.5}, {"endpointSigmaPx", 1.5}}}});
    json m1 = ok("measure", {{"dir", F.dir}, {"x1", 100}, {"y1", 100}, {"x2", 400}, {"y2", 500}});
    CHECK(m1["calibrated"] == true && m1["unit"] == "mm");
    CHECK_NEAR(m1["value"].get<double>(), 200.0, 1e-6);
    CHECK(m1["sigma"].get<double>() > 1.0 && m1["sigma"].get<double>() < 10.0);
}

int main(int argc, char** argv) {
    g_tmp = (fs::temp_directory_path() / "dcore_tests").string();
    fs::remove_all(g_tmp);
    fs::create_directories(g_tmp);
    std::string filter = argc > 1 ? argv[1] : "";
    struct T {
        const char* name;
        void (*fn)();
    };
    const T tests[] = {{"transform_composition", test_transform_composition}, {"exif_orientation", test_exif_orientation},
                       {"registration_outliers", test_registration_outliers}, {"end_to_end_coverage_provenance", test_end_to_end_and_coverage},
                       {"disconnected_graph_rejections_manual", test_disconnected_graph}, {"tile_boundaries", test_tile_boundaries},
                       {"cancel_restart_resume", test_cancel_restart}, {"persistence_undo", test_persistence_undo}, {"export_formats_edits", test_export}};
    int ran = 0;
    for (auto& t : tests) {
        if (!filter.empty() && std::string(t.name).find(filter) == std::string::npos) continue;
        int f0 = g_fail, c0 = g_checks;
        int64_t t0 = nowMs();
        printf("[ RUN  ] %s\n", t.name);
        fflush(stdout);
        try {
            t.fn();
        } catch (const std::exception& e) {
            g_fail++;
            printf("    EXCEPTION: %s\n", e.what());
        }
        printf("[ %s ] %s (%d checks, %lld ms)\n", g_fail == f0 ? " OK " : "FAIL", t.name, g_checks - c0, (long long)(nowMs() - t0));
        ran++;
    }
    printf("\n%d tests, %d checks, %d failures\n", ran, g_checks, g_fail);
    if (!getenv("DC_KEEP")) fs::remove_all(g_tmp);
    return g_fail ? 1 : 0;
}
