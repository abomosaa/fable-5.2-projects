#include "dc/ba.h"

namespace dc {

namespace {
struct Norm {
    double cx, cy, R;
};
struct Problem {
    const std::vector<BAFrame>& frames;
    const std::vector<BAObs>& obs;
    const BAOptions& opt;
    std::vector<Norm> nf;
    Norm n0;
    int nF, nG;

    Problem(const std::vector<BAFrame>& f, const std::vector<BAObs>& o, const BAOptions& op, int groups) : frames(f), obs(o), opt(op) {
        nF = (int)f.size();
        nG = groups;
        for (auto& fr : f) nf.push_back({fr.w * 0.5, fr.h * 0.5, 0.5 * std::hypot((double)fr.w, (double)fr.h)});
        n0 = {op.ovW * 0.5, op.ovH * 0.5, 0.5 * std::hypot((double)op.ovW, (double)op.ovH)};
    }
    // normalised undistorted frame coordinate
    inline void nrm(int i, const Pt& p, double k1, double& x, double& y) const {
        const Norm& n = nf[i];
        double dx = (p.x - n.cx) / n.R, dy = (p.y - n.cy) / n.R;
        double f = 1 + k1 * (dx * dx + dy * dy);
        x = dx * f;
        y = dy * f;
    }
    inline double k1Of(int group, const std::vector<double>& par) const { return group >= 0 ? par[8 * nF + group] : 0.0; }
    // residual (2 values, scaled px, unweighted) + analytic jacobian blocks wrt the homography params
    void eval(const BAObs& o, const std::vector<double>& par, double r[2], double Ji[2][8], double Jj[2][8]) const {
        double xi, yi;
        nrm(o.i, o.pi, k1Of(frames[o.i].group, par), xi, yi);
        const double* h = &par[8 * o.i];
        double X = h[0] * xi + h[1] * yi + h[2], Y = h[3] * xi + h[4] * yi + h[5], Z = h[6] * xi + h[7] * yi + 1;
        double s = n0.R * o.scale;
        double ax = X / Z, ay = Y / Z;
        if (Ji) {
            double a[8] = {xi / Z, yi / Z, 1 / Z, 0, 0, 0, -X * xi / (Z * Z), -X * yi / (Z * Z)};
            double b[8] = {0, 0, 0, xi / Z, yi / Z, 1 / Z, -Y * xi / (Z * Z), -Y * yi / (Z * Z)};
            for (int k = 0; k < 8; k++) {
                Ji[0][k] = a[k] * s;
                Ji[1][k] = b[k] * s;
            }
        }
        double bx, by;
        if (o.j < 0) {
            double k0 = k1Of(opt.ovGroup, par);
            double dx = (o.pj.x - n0.cx) / n0.R, dy = (o.pj.y - n0.cy) / n0.R, f = 1 + k0 * (dx * dx + dy * dy);
            bx = dx * f;
            by = dy * f;
        } else {
            double xj, yj;
            nrm(o.j, o.pj, k1Of(frames[o.j].group, par), xj, yj);
            const double* g = &par[8 * o.j];
            double X2 = g[0] * xj + g[1] * yj + g[2], Y2 = g[3] * xj + g[4] * yj + g[5], Z2 = g[6] * xj + g[7] * yj + 1;
            bx = X2 / Z2;
            by = Y2 / Z2;
            if (Jj) {
                double a[8] = {xj / Z2, yj / Z2, 1 / Z2, 0, 0, 0, -X2 * xj / (Z2 * Z2), -X2 * yj / (Z2 * Z2)};
                double b[8] = {0, 0, 0, xj / Z2, yj / Z2, 1 / Z2, -Y2 * xj / (Z2 * Z2), -Y2 * yj / (Z2 * Z2)};
                for (int k = 0; k < 8; k++) {
                    Jj[0][k] = -a[k] * s;
                    Jj[1][k] = -b[k] * s;
                }
            }
        }
        r[0] = (ax - bx) * s;
        r[1] = (ay - by) * s;
    }
    double cost(const std::vector<double>& par, std::vector<double>* res = nullptr) const {
        double c = 0;
        if (res) res->assign(obs.size(), 0);
        for (size_t n = 0; n < obs.size(); n++) {
            double r[2];
            eval(obs[n], par, r, nullptr, nullptr);
            double e = std::hypot(r[0], r[1]);
            if (res) (*res)[n] = e;
            double ew = e * obs[n].w, d = opt.huber;
            c += ew <= d ? 0.5 * ew * ew : d * (ew - 0.5 * d);
        }
        return c;
    }
};
}  // namespace

BAResult bundleAdjust(std::vector<BAFrame>& frames, const std::vector<BAObs>& obs, int nGroups, std::vector<double> k1Init, const BAOptions& opt) {
    BAResult R;
    Problem pb(frames, obs, opt, nGroups);
    const int nF = pb.nF, P = 8 * nF + nGroups;
    k1Init.resize(nGroups, 0.0);
    R.k1 = k1Init;
    if (nF == 0) return R;
    std::vector<double> par(P, 0.0);
    // H~ = N0 * H * Ni^-1 , normalised so that h33 == 1
    for (int i = 0; i < nF; i++) {
        const Norm& n = pb.nf[i];
        H3 N0{{1 / pb.n0.R, 0, -pb.n0.cx / pb.n0.R, 0, 1 / pb.n0.R, -pb.n0.cy / pb.n0.R, 0, 0, 1}};
        H3 NiInv{{n.R, 0, n.cx, 0, n.R, n.cy, 0, 0, 1}};
        H3 Ht = (N0 * frames[i].H * NiInv).normalized();
        for (int k = 0; k < 8; k++) par[8 * i + k] = Ht.m[k];
    }
    for (int g = 0; g < nGroups; g++) par[8 * nF + g] = k1Init[g];

    double cur = pb.cost(par);
    R.cost0 = cur;
    double lambda = 1e-3;
    const int nK = opt.solveK1 ? nGroups : 0;
    const int Pact = 8 * nF + nK;
    cv::Mat A(Pact, Pact, CV_64F), g(Pact, 1, CV_64F);
    for (int it = 0; it < opt.maxIters; it++) {
        A.setTo(0);
        g.setTo(0);
        for (const BAObs& o : obs) {
            double r[2], Ji[2][8], Jj[2][8];
            pb.eval(o, par, r, Ji, Jj);
            double e = std::hypot(r[0], r[1]) * o.w;
            double hw = (e <= opt.huber ? 1.0 : opt.huber / e) * o.w * o.w;  // IRLS weight incl. 1/sigma^2
            // collect sparse row entries
            int idx[18];
            double d0[18], d1[18];
            int n = 0;
            for (int k = 0; k < 8; k++) {
                idx[n] = 8 * o.i + k;
                d0[n] = Ji[0][k];
                d1[n] = Ji[1][k];
                n++;
            }
            if (o.j >= 0)
                for (int k = 0; k < 8; k++) {
                    idx[n] = 8 * o.j + k;
                    d0[n] = Jj[0][k];
                    d1[n] = Jj[1][k];
                    n++;
                }
            if (nK) {
                int gs[2] = {frames[o.i].group, o.j >= 0 ? frames[o.j].group : opt.ovGroup};
                if (gs[1] == gs[0]) gs[1] = -1;
                for (int q = 0; q < 2; q++) {
                    if (gs[q] < 0) continue;
                    const double eps = 1e-4;
                    std::vector<double>& pp = par;
                    double keep = pp[8 * nF + gs[q]], rp[2], rm[2];
                    pp[8 * nF + gs[q]] = keep + eps;
                    pb.eval(o, pp, rp, nullptr, nullptr);
                    pp[8 * nF + gs[q]] = keep - eps;
                    pb.eval(o, pp, rm, nullptr, nullptr);
                    pp[8 * nF + gs[q]] = keep;
                    idx[n] = 8 * nF + gs[q];
                    d0[n] = (rp[0] - rm[0]) / (2 * eps);
                    d1[n] = (rp[1] - rm[1]) / (2 * eps);
                    n++;
                }
            }
            for (int a = 0; a < n; a++) {
                double* Ar = A.ptr<double>(idx[a]);
                for (int b = 0; b < n; b++) Ar[idx[b]] += hw * (d0[a] * d0[b] + d1[a] * d1[b]);
                g.at<double>(idx[a]) += hw * (d0[a] * r[0] + d1[a] * r[1]);
            }
        }
        bool improved = false;
        for (int tries = 0; tries < 8; tries++) {
            cv::Mat Ad = A.clone();
            for (int k = 0; k < Pact; k++) Ad.at<double>(k, k) += lambda * std::max(A.at<double>(k, k), 1e-9) + 1e-12;
            cv::Mat delta;
            if (!cv::solve(Ad, g, delta, cv::DECOMP_CHOLESKY)) {
                lambda *= 10;
                continue;
            }
            std::vector<double> cand = par;
            for (int k = 0; k < Pact; k++) cand[k] -= delta.at<double>(k);
            double c = pb.cost(cand);
            if (std::isfinite(c) && c < cur) {
                double rel = (cur - c) / std::max(cur, 1e-12);
                par = cand;
                cur = c;
                lambda = std::max(1e-9, lambda * 0.3);
                improved = true;
                R.iters = it + 1;
                if (rel < 1e-7) it = opt.maxIters;
                break;
            }
            lambda *= 10;
        }
        if (!improved) break;
    }
    R.cost = pb.cost(par, &R.obsRes);
    for (int i = 0; i < nF; i++) {
        const Norm& n = pb.nf[i];
        H3 Ht;
        for (int k = 0; k < 8; k++) Ht.m[k] = par[8 * i + k];
        Ht.m[8] = 1;
        H3 N0inv{{pb.n0.R, 0, pb.n0.cx, 0, pb.n0.R, pb.n0.cy, 0, 0, 1}};
        H3 Ni{{1 / n.R, 0, -n.cx / n.R, 0, 1 / n.R, -n.cy / n.R, 0, 0, 1}};
        frames[i].H = (N0inv * Ht * Ni).normalized();
    }
    for (int gI = 0; gI < nGroups; gI++) R.k1[gI] = par[8 * nF + gI];
    return R;
}

}  // namespace dc
