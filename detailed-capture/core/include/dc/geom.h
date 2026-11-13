// Geometry: orientation, distortion, frame models, homography validation.
#pragma once
#include "common.h"

namespace dc {

// EXIF orientation (1..8). Returns the transform from STORED continuous coordinates to ORIENTED continuous
// coordinates, and the oriented size.
H3 orientationTransform(int exifOrientation, int storedW, int storedH);
void orientedSize(int exifOrientation, int storedW, int storedH, int& w, int& h);
// Applies the orientation to a raster (exact pixel permutation, no resampling).
void applyOrientation(const cv::Mat& stored, cv::Mat& oriented, int exifOrientation);

// Continuous-convention homography (src->dst)  ->  OpenCV index-convention homography (src->dst).
cv::Mat toIndexConvention(const H3& H);
H3 fromIndexConvention(const cv::Mat& Hcv);

// One-parameter radial model around the image centre, radius normalised by the half diagonal:
//   undistorted = c + (p - c) * (1 + k1 * r^2),  r = |p - c| / R
struct Radial {
    double cx = 0, cy = 0, R = 1, k1 = 0;
    Radial() = default;
    Radial(int w, int h, double k) : cx(w * 0.5), cy(h * 0.5), R(0.5 * std::sqrt(double(w) * w + double(h) * h)), k1(k) {}
    Pt undistort(Pt p) const {
        if (k1 == 0) return p;
        double dx = (p.x - cx) / R, dy = (p.y - cy) / R, f = 1 + k1 * (dx * dx + dy * dy);
        return {cx + (p.x - cx) * f, cy + (p.y - cy) * f};
    }
    Pt distort(Pt u) const;  // inverse of undistort (Newton iterations)
};

// A registered frame: oriented frame coords --undistort--> --H--> canvas coords.
struct FrameModel {
    int w = 0, h = 0;
    Radial rad;
    H3 H;     // undistorted frame -> canvas
    H3 Hinv;  // canvas -> undistorted frame
    FrameModel() = default;
    FrameModel(int w_, int h_, const H3& H_, double k1) : w(w_), h(h_), rad(w_, h_, k1), H(H_), Hinv(H_.inverse()) {}
    Pt toCanvas(Pt p) const { return H.apply(rad.undistort(p)); }
    Pt toFrame(Pt c) const { return rad.distort(Hinv.apply(c)); }
    // frame pixels per canvas unit at canvas point c (sqrt |det J| of canvas->frame)
    double scaleAt(Pt c) const;
    std::array<Pt, 4> footprint() const;  // canvas coords of the 4 frame corners (TL, TR, BR, BL)
};

struct HCheck {
    bool ok = false;
    std::string reason;      // machine code when !ok
    double scale = 0;        // src pixels per dst pixel at the src centre (sqrt|det| of dst->src Jacobian)
    double anisotropy = 0;   // max singular value ratio of the Jacobian over the frame
    double scaleSpread = 0;  // max/min local scale over the frame corners
};
// Validates a homography mapping a (w x h) source frame into a destination. Rejects mirrored, folded,
// near-singular, extremely anisotropic or extreme-perspective transforms.
HCheck validateHomography(const H3& H, int srcW, int srcH);

// local Jacobian (2x2) of H at (x, y): returns {a,b,c,d} = d(x',y')/d(x,y)
std::array<double, 4> jacobian(const H3& H, double x, double y);
double polygonArea(const std::vector<Pt>& poly);
bool pointInQuad(const std::array<Pt, 4>& q, Pt p);
// Convex hull area of points (fraction helper for inlier spatial coverage).
double hullArea(const std::vector<Pt>& pts);

}  // namespace dc
