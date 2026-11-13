// Global refinement of the registration graph (homographies + optional shared radial distortion).
#pragma once
#include "common.h"
#include "geom.h"

namespace dc {

struct BAFrame {
    int w = 0, h = 0;
    H3 H;           // undistorted frame -> canvas (initial value in, refined value out)
    int group = -1; // lens group index (-1: no distortion parameter)
};
struct BAObs {
    int i = -1, j = -1;  // frame indices; j == -1: anchor observation against the overview (pj in overview coords)
    Pt pi, pj;
    double w = 1;        // 1/sigma in the residual's pixel unit
    double scale = 1;    // multiplies the canvas-space difference (pair obs: frame px per canvas px)
};
struct BAOptions {
    int ovW = 0, ovH = 0;
    int ovGroup = -1;       // lens group of the overview (-1: overview assumed distortion free)
    bool solveK1 = false;
    double huber = 2.0;
    int maxIters = 40;
};
struct BAResult {
    std::vector<double> k1;        // per group
    double cost0 = 0, cost = 0;    // robust cost before / after
    int iters = 0;
    std::vector<double> obsRes;    // per observation residual norm (scaled px, unweighted)
};
// Minimises   sum_anchor rho(|H_i U_i(p) - U_0(q)|) + sum_pairs rho(scale * |H_i U_i(p) - H_j U_j(q)|)
// with Levenberg-Marquardt. The overview is the fixed gauge (H_0 = I).
BAResult bundleAdjust(std::vector<BAFrame>& frames, const std::vector<BAObs>& obs, int nGroups, std::vector<double> k1Init, const BAOptions& opt);

}  // namespace dc
