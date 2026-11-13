// Detailed Capture core — common types.
//
// COORDINATE CONVENTIONS (used everywhere in the core, the project file and the app):
//  * All stored coordinates are CONTINUOUS: pixel (i, j) of a raster covers [i, i+1) x [j, j+1) and its
//    centre is (i + 0.5, j + 0.5). OpenCV index coordinates (centre == integer) are converted at the call
//    boundary only (see geom.h: toIndexConvention()).
//  * "stored" coordinates: the raster as encoded in the file.
//  * "oriented" coordinates: after applying the EXIF orientation (what a person sees). All frame coordinates in
//    the project file are oriented, full-resolution, continuous.
//  * "canvas" coordinates: the oriented overview after (optional) radial undistortion. Unit = one overview pixel.
//  * "output" coordinates: canvas * S (S = output scale chosen from source sampling).
//  * "export" coordinates: output after the reversible view edits (rot90, fine rotation, perspective, crop).
#pragma once
#include <opencv2/core.hpp>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "../../third_party/json.hpp"

namespace dc {

using json = nlohmann::json;

constexpr const char* kCoreVersion = "1.0.0";

struct Pt {
    double x = 0, y = 0;
};

// 3x3 homography, row-major, continuous coordinates.
struct H3 {
    std::array<double, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
    static H3 identity() { return H3{}; }
    static H3 scale(double sx, double sy) { return H3{{sx, 0, 0, 0, sy, 0, 0, 0, 1}}; }
    static H3 translate(double tx, double ty) { return H3{{1, 0, tx, 0, 1, ty, 0, 0, 1}}; }
    Pt apply(double x, double y) const {
        double X = m[0] * x + m[1] * y + m[2], Y = m[3] * x + m[4] * y + m[5], Z = m[6] * x + m[7] * y + m[8];
        return {X / Z, Y / Z};
    }
    Pt apply(Pt p) const { return apply(p.x, p.y); }
    double w(double x, double y) const { return m[6] * x + m[7] * y + m[8]; }
    H3 operator*(const H3& o) const {
        H3 r;
        for (int i = 0; i < 3; i++)
            for (int j = 0; j < 3; j++) {
                double s = 0;
                for (int k = 0; k < 3; k++) s += m[i * 3 + k] * o.m[k * 3 + j];
                r.m[i * 3 + j] = s;
            }
        return r;
    }
    double det() const {
        return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    }
    H3 inverse() const;
    H3 normalized() const;  // m[8] == 1 when possible
    cv::Mat toCv() const { return cv::Mat(3, 3, CV_64F, const_cast<double*>(m.data())).clone(); }
    static H3 fromCv(const cv::Mat& M);
    json toJson() const { return json(m); }
    static H3 fromJson(const json& j) {
        H3 h;
        for (int i = 0; i < 9; i++) h.m[i] = j.at(i).get<double>();
        return h;
    }
};

struct CancelledError : std::runtime_error {
    CancelledError() : std::runtime_error("cancelled") {}
};
struct UserError : std::runtime_error {  // error with a plain-language message that is safe to show
    std::string code;
    UserError(const std::string& c, const std::string& msg) : std::runtime_error(msg), code(c) {}
};

// Progress + cancellation context handed through long operations.
struct Ctx {
    std::function<void(const std::string& stage, double fraction, const std::string& detail)> progress;
    std::shared_ptr<std::atomic<bool>> cancel;
    int threads = 2;          // worker threads for block rendering (thermal / memory bound)
    int memoryBudgetMB = 512; // soft bound for decode caches + render buffers
    void report(const std::string& stage, double f, const std::string& detail = "") const {
        if (progress) progress(stage, f, detail);
    }
    bool cancelled() const { return cancel && cancel->load(); }
    void check() const {
        if (cancelled()) throw CancelledError();
    }
};

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

std::string nowIso();
int64_t nowMs();
void logf(const char* fmt, ...);
void setLogSink(std::function<void(const std::string&)> sink);

}  // namespace dc
