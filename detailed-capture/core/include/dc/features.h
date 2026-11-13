// Quality analysis, scale-robust features, matching and robust pairwise geometry.
#pragma once
#include "common.h"
#include "geom.h"

namespace dc {

// ---- per-frame quality ---------------------------------------------------------------------------------
struct FrameQuality {
    int gw = 0, gh = 0;
    std::vector<float> sigmaMap;  // estimated optical blur sigma (native px) per cell; <0 where not measurable
    double sharpSigma = -1;       // median over measurable cells (-1: no texture to measure)
    double bestSigma = -1;        // 10th percentile (sharpest areas)
    double texturedFrac = 0;      // fraction of cells with measurable texture
    double clipHi = 0, clipLo = 0, meanLuma = 0, glareFrac = 0, noise = 0;
    json toJson() const;
    static FrameQuality fromJson(const json& j);
    // blur sigma for a point in oriented frame coords (falls back to the frame median)
    double sigmaAt(double x, double y, int w, int h) const;
};
FrameQuality analyzeQuality(const cv::Mat& bgr);
// Effective-resolution factor in (0,1]: 1 for a critically sharp frame, lower when blur limits real detail.
double sharpFactor(double sigma);
constexpr double kSigmaRef = 0.9;
// Effective detail of a close-up relative to the overview at one place: sampling ratio `s` (close-up px per
// overview px) reduced by how much blurrier the close-up measures than the overview does there. Comparing with
// the overview's own measurement makes the estimate independent of how soft the SUBJECT is.
double detailGain(double s, double sigmaCloseup, double sigmaOverview);

// ---- features --------------------------------------------------------------------------------------------
struct Features {
    int imgW = 0, imgH = 0;          // full-resolution oriented size the coordinates refer to
    double workScale = 1;            // working px per full-res px used for extraction
    std::vector<cv::Point2f> pts;    // continuous full-res oriented coords
    std::vector<float> size, angle;  // keypoint diameter (full-res px), orientation (deg)
    cv::Mat desc;                    // N x 128 CV_32F RootSIFT (unit L2 norm)
    size_t count() const { return pts.size(); }
    void save(const std::string& path) const;
    static bool load(const std::string& path, Features& f);
};
// Tiled multi-level SIFT with bounded memory. gray: CV_8U full-resolution oriented image.
Features extractFeatures(const cv::Mat& gray, int maxWorkDim, int maxFeatures, const Ctx* ctx = nullptr);

struct PairOptions {
    bool restrict = false;  // restrict B features to rectangle (B coords)
    cv::Rect2d restrictB;
    bool havePrior = false;  // prior A->B homography: guided matching only
    H3 prior;
    double priorRadius = 12;  // px in B
    bool checkAmbiguity = true;
    bool requireAinsideB = false;  // overview case: inlier hull judged against whole frame area
    double ratio = 0.8;
    int minInliers = 14;
};
struct PairResult {
    bool ok = false;
    std::string fail;  // "few_matches", "no_model", "degenerate", "mirrored", "folded", "stretch", "perspective",
                       // "low_spread", "high_residual", "repetitive"
    H3 H;              // A -> B (continuous, full-res oriented, no distortion model)
    int nPutative = 0, nInliers = 0;
    double rms = 0;           // inlier RMS in B px
    double thr = 0;           // inlier threshold used (B px)
    double hullFrac = 0;      // inlier convex hull area / A frame area
    double scale = 0;         // A px per B px at A centre
    std::vector<Pt> inA, inB; // inlier correspondences (subset, spatially spread)
    bool ambiguous = false;   // a second, distinct placement has comparable support (repeating pattern)
    H3 Halt;
    int nAlt = 0;
    // parallax diagnostics (matches consistent with epipolar geometry but not with the plane)
    int nEpipolar = 0;
    double planarRatio = 1;   // H inliers / F inliers
    std::vector<Pt> offPlaneA, offPlaneB;  // matches that fit an epipolar geometry but not the plane (A and B coords)
    json toJson() const;
    static PairResult fromJson(const json& j);
};
PairResult estimatePair(const Features& A, const Features& B, const PairOptions& opt);
// Homography from manual correspondences (>= 4 pairs). Returns false if degenerate.
bool homographyFromPoints(const std::vector<Pt>& a, const std::vector<Pt>& b, H3& H, double& rms);

}  // namespace dc
