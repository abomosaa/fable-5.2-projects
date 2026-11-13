// Reversible view edits, flat export (streaming), tile-pyramid package, source inspection and measurement.
#include "dc/compose.h"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace dc {

extern const char* kViewerHtml;

// ---------------------------------------------------------------------------------------------- edits
void colorMatrixFromEdits(const json& c, float m[12]) {
    double ev = c.value("exposure", 0.0), con = c.value("contrast", 0.0), sat = c.value("saturation", 0.0), temp = c.value("temperature", 0.0),
           tint = c.value("tint", 0.0);
    // Defined on ENCODED values so that the on-screen preview (a colour matrix) and the export are identical.
    double g = std::pow(2.0, ev / 2.2);
    double gr = g * (1 + 0.25 * temp) * (1 + 0.10 * tint), gg = g * (1 - 0.20 * tint), gb = g * (1 - 0.25 * temp) * (1 + 0.10 * tint);
    double k = con >= 0 ? 1 + con : 1 + 0.6 * con;
    double s = 1 + sat;
    const double lr = 0.2126, lg = 0.7152, lb = 0.0722;
    // saturation matrix S, contrast (v-0.5)*k+0.5, gains G:  out = S * (k * (G*in) + (0.5 - 0.5k))
    double S[9] = {lr + (1 - lr) * s, lg * (1 - s), lb * (1 - s), lr * (1 - s), lg + (1 - lg) * s, lb * (1 - s), lr * (1 - s), lg * (1 - s), lb + (1 - lb) * s};
    double G[3] = {gr, gg, gb};
    double off = 0.5 - 0.5 * k;
    for (int r = 0; r < 3; r++) {
        for (int cI = 0; cI < 3; cI++) m[r * 4 + cI] = (float)(S[r * 3 + cI] * k * G[cI]);
        m[r * 4 + 3] = (float)((S[r * 3] + S[r * 3 + 1] + S[r * 3 + 2]) * off);
    }
}

EditTransform makeEditTransform(const json& e, int W, int H) {
    EditTransform T;
    H3 M = H3::identity();
    double w = W, h = H;
    bool resample = false;
    if (e.contains("perspective") && e["perspective"].is_array() && e["perspective"].size() == 4) {
        std::vector<cv::Point2f> src, dst = {{0, 0}, {(float)w, 0}, {(float)w, (float)h}, {0, (float)h}};
        for (auto& p : e["perspective"]) src.emplace_back((float)(p[0].get<double>() * w), (float)(p[1].get<double>() * h));
        cv::Mat P = cv::getPerspectiveTransform(src, dst);
        H3 Hp = H3::fromCv(P).normalized();
        if (validateHomography(Hp, W, H).ok || true) {
            M = Hp * M;
            resample = true;
        }
    }
    int k = ((e.value("rot90", 0) % 4) + 4) % 4;
    if (k == 1) {
        M = H3{{0, -1, h, 1, 0, 0, 0, 0, 1}} * M;
        std::swap(w, h);
    } else if (k == 2) {
        M = H3{{-1, 0, w, 0, -1, h, 0, 0, 1}} * M;
    } else if (k == 3) {
        M = H3{{0, 1, 0, -1, 0, w, 0, 0, 1}} * M;
        std::swap(w, h);
    }
    double ang = e.value("angle", 0.0);
    if (std::abs(ang) > 1e-6) {
        double t = ang * CV_PI / 180, c = std::cos(t), s = std::sin(t);
        double a = std::max(w / h, h / w);
        double kk = 1.0 / (std::abs(c) + a * std::abs(s));  // largest inscribed rectangle of the same aspect ratio
        double nw = std::floor(w * kk), nh = std::floor(h * kk);
        H3 R = H3::translate(nw / 2, nh / 2) * H3{{c, -s, 0, s, c, 0, 0, 0, 1}} * H3::translate(-w / 2, -h / 2);
        M = R * M;
        w = nw;
        h = nh;
        resample = true;
    }
    if (e.contains("crop") && e["crop"].is_object()) {
        const json& cr = e["crop"];
        double cx = std::round(clampd(cr.value("x", 0.0), 0, 1) * w), cy = std::round(clampd(cr.value("y", 0.0), 0, 1) * h);
        double cw = std::round(clampd(cr.value("w", 1.0), 0, 1) * w), ch = std::round(clampd(cr.value("h", 1.0), 0, 1) * h);
        cw = std::max(1.0, std::min(cw, w - cx));
        ch = std::max(1.0, std::min(ch, h - cy));
        M = H3::translate(-cx, -cy) * M;
        w = cw;
        h = ch;
    }
    T.M = M;
    T.w = (int)std::lround(w);
    T.h = (int)std::lround(h);
    T.integerOnly = !resample;
    bool isId = true;
    H3 I;
    for (int i = 0; i < 9; i++)
        if (std::abs(M.m[i] - I.m[i]) > 1e-12) isId = false;
    T.identity = isId && T.w == W && T.h == H;
    if (e.contains("color") && e["color"].is_object()) {
        colorMatrixFromEdits(e["color"], T.color);
        const float id[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
        for (int i = 0; i < 12; i++)
            if (std::abs(T.color[i] - id[i]) > 1e-6f) T.hasColor = true;
    }
    return T;
}

namespace {
struct ResultInfo {
    std::string dir, root;
    json manifest;
    Pyramid pyr;
};
ResultInfo loadResult(Project& P) {
    if (P.j["result"].is_null()) throw UserError("no_result", "There is no fused result yet. Run Fuse first.");
    ResultInfo R;
    R.dir = P.abs("results/" + P.j["result"]["runId"].get<std::string>());
    if (!fileExists(R.dir + "/manifest.json")) throw UserError("no_result", "The fused result is missing. Run Fuse again.");
    R.manifest = json::parse(readFile(R.dir + "/manifest.json"));
    R.root = R.dir + "/tiles";
    R.pyr = Pyramid(R.manifest["width"], R.manifest["height"], R.manifest["tileSize"]);
    return R;
}

void applyColor(cv::Mat& bgr, const float m[12]) {
    cv::Mat f;
    bgr.convertTo(f, CV_32FC3, 1.0 / 255);
    // matrix is defined on RGB; pixels are BGR
    cv::Matx34f K(m[10], m[9], m[8], m[11], m[6], m[5], m[4], m[7], m[2], m[1], m[0], m[3]);
    cv::transform(f, f, K);
    f.convertTo(bgr, CV_8UC3, 255.0);
}

// Renders rows [y0, y0+rows) of the edited export image.
cv::Mat renderExportStrip(const ResultInfo& R, const EditTransform& T, double scale, int level, int y0, int rows, int outW, ImageCache& cache) {
    const double lv = double(1 << (R.pyr.maxLevel - level));  // base px per level px
    // export px (scaled) -> base output px -> level px
    H3 toBase = T.M.inverse() * H3::scale(1.0 / scale, 1.0 / scale);
    H3 toLevel = H3::scale(1.0 / lv, 1.0 / lv) * toBase;
    cv::Mat out;
    if (T.identity && scale == 1.0 && level == R.pyr.maxLevel) {
        out = readPyramidRect(R.root, R.pyr, level, cv::Rect(0, y0, outW, rows), "png", cache);
    } else {
        double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
        for (int i = 0; i <= 16; i++)
            for (int j = 0; j < 2; j++) {
                Pt p = toLevel.apply(outW * i / 16.0, y0 + j * rows);
                minx = std::min(minx, p.x);
                miny = std::min(miny, p.y);
                maxx = std::max(maxx, p.x);
                maxy = std::max(maxy, p.y);
            }
        const int pad = 6;
        cv::Rect src((int)std::floor(minx) - pad, (int)std::floor(miny) - pad, (int)std::ceil(maxx) - (int)std::floor(minx) + 2 * pad + 1,
                     (int)std::ceil(maxy) - (int)std::floor(miny) + 2 * pad + 1);
        cv::Mat s = readPyramidRect(R.root, R.pyr, level, src, "png", cache);
        cv::Mat mx(rows, outW, CV_32F), my(rows, outW, CV_32F);
        cv::parallel_for_(cv::Range(0, rows), [&](const cv::Range& rg) {
            for (int y = rg.start; y < rg.end; y++) {
                float* px = mx.ptr<float>(y);
                float* py = my.ptr<float>(y);
                for (int x = 0; x < outW; x++) {
                    Pt p = toLevel.apply(x + 0.5, y0 + y + 0.5);
                    px[x] = (float)(p.x - 0.5 - src.x);
                    py[x] = (float)(p.y - 0.5 - src.y);
                }
            }
        });
        bool exact = T.integerOnly && scale == 1.0 && level == R.pyr.maxLevel;
        cv::remap(s, out, mx, my, exact ? cv::INTER_NEAREST : cv::INTER_LANCZOS4, cv::BORDER_REPLICATE);
    }
    if (T.hasColor) applyColor(out, T.color);
    return out;
}
}  // namespace

// ---------------------------------------------------------------------------------------------- flat
json exportFlat(Project& P, const json& a, const Ctx& ctx) {
    ResultInfo R = loadResult(P);
    std::string fmt = a.value("format", "png"), path = a.at("path");
    bool applyEdits = a.value("applyEdits", true);
    EditTransform T = makeEditTransform(applyEdits ? P.j["edits"] : json::object(), R.pyr.w, R.pyr.h);
    double scale = clampd(a.value("scale", 1.0), 0.01, 1.0);
    int level = R.pyr.maxLevel;
    double resid = scale;
    while (resid <= 0.5 && level > 0) {
        resid *= 2;
        level--;
    }
    int outW = std::max(1, (int)std::lround(T.w * scale)), outH = std::max(1, (int)std::lround(T.h * scale));
    json notes = json::array();
    if (fmt == "jpeg" || fmt == "jpg") {
        fmt = "jpeg";
        if (outW > 65535 || outH > 65535)
            throw UserError("too_large", "JPEG cannot store more than 65,535 pixels per side (this image is " + std::to_string(outW) + " x " + std::to_string(outH) +
                                             "). Use PNG, TIFF or the tile package.");
        notes.push_back("JPEG is lossy (8-bit, 4:4:4, quality " + std::to_string(a.value("quality", 95)) + "); use PNG or TIFF for a lossless master.");
    } else if (fmt != "png" && fmt != "tiff") {
        throw UserError("bad_format", "Unsupported export format.");
    }
    if ((double)outW * outH > 250e6) notes.push_back("Very large flat image: many apps cannot open images above ~250 MP. The tile package opens at any size.");
    {
        std::error_code ec;
        auto sp = fs::space(fs::path(path).parent_path(), ec);
        double need = double(outW) * outH * (fmt == "jpeg" ? 0.6 : 2.2);
        if (!ec && (double)sp.available < need * 0.5 + 16e6) throw UserError("storage_full", "Not enough free storage to export this image.");
    }
    std::vector<uint8_t> icc = P.workingIcc();
    std::string tmp = path + ".part";
    std::unique_ptr<RowWriter> wr;
    if (fmt == "png") wr = makePngWriter(tmp, outW, outH, icc, a.value("pngLevel", 6));
    else if (fmt == "tiff") wr = makeTiffWriter(tmp, outW, outH, icc, a.value("bigTiff", false));
    else wr = makeJpegWriter(tmp, outW, outH, a.value("quality", 95), icc);
    ImageCache cache((size_t)std::max(64, ctx.memoryBudgetMB / 3) << 20);
    try {
        const int strip = 256;
        for (int y = 0; y < outH; y += strip) {
            ctx.check();
            int rows = std::min(strip, outH - y);
            cv::Mat s = renderExportStrip(R, T, scale, level, y, rows, outW, cache);
            wr->writeRows(s);
            ctx.report("Exporting", double(y + rows) / outH, fmt);
        }
        wr->finish();
    } catch (...) {
        wr.reset();
        std::error_code ec;
        fs::remove(tmp, ec);
        throw;
    }
    std::error_code ec;
    fs::rename(tmp, path, ec);
    if (ec) throw UserError("io", "Could not write the export file.");
    json out = {{"path", path}, {"format", fmt}, {"width", outW}, {"height", outH}, {"bytes", (uint64_t)fs::file_size(path, ec)}, {"bitDepth", 8},
                {"colorSpace", R.manifest.value("colorSpace", "sRGB")}, {"iccEmbedded", !icc.empty()}, {"notes", notes},
                {"resampled", !(T.integerOnly && scale == 1.0)}, {"editsApplied", applyEdits && !(T.identity && !T.hasColor)}};
    return out;
}

// ---------------------------------------------------------------------------------------------- tiles
json exportTiles(Project& P, const json& a, const Ctx& ctx) {
    ResultInfo R = loadResult(P);
    std::string outDir = a.at("outDir"), fmt = a.value("format", "png");
    if (fmt == "jpg") fmt = "jpeg";
    std::string ext = fmt == "jpeg" ? "jpg" : "png";
    bool applyEdits = a.value("applyEdits", true);
    EditTransform T = makeEditTransform(applyEdits ? P.j["edits"] : json::object(), R.pyr.w, R.pyr.h);
    std::error_code ec;
    fs::remove_all(outDir, ec);
    fs::create_directories(outDir + "/image_files", ec);
    Pyramid pyr(T.w, T.h, R.pyr.tile);
    std::string root = outDir + "/image_files";
    fs::create_directories(root + "/" + std::to_string(pyr.maxLevel), ec);
    bool direct = T.identity && !T.hasColor && ext == "png";
    long files = 0;
    if (direct) {
        // unedited lossless pyramid: copy tiles verbatim
        for (int L = 0; L <= pyr.maxLevel; L++) {
            fs::create_directories(root + "/" + std::to_string(L), ec);
            for (int r = 0; r < pyr.rows(L); r++)
                for (int c = 0; c < pyr.cols(L); c++) {
                    ctx.check();
                    fs::copy_file(tilePath(R.root, L, c, r, "png"), tilePath(root, L, c, r, "png"), fs::copy_options::overwrite_existing, ec);
                    if (ec) throw UserError("storage_full", "Could not write the tile package (storage full?).");
                    files++;
                }
            ctx.report("Exporting tiles", double(L + 1) / (pyr.maxLevel + 1));
        }
    } else {
        ImageCache cache((size_t)std::max(64, ctx.memoryBudgetMB / 3) << 20);
        for (int ty = 0; ty < pyr.rows(pyr.maxLevel); ty++) {
            ctx.check();
            int rows = std::min(pyr.tile, T.h - ty * pyr.tile);
            cv::Mat s = renderExportStrip(R, T, 1.0, R.pyr.maxLevel, ty * pyr.tile, rows, T.w, cache);
            for (int tx = 0; tx < pyr.cols(pyr.maxLevel); tx++) {
                cv::Rect t(tx * pyr.tile, 0, std::min(pyr.tile, T.w - tx * pyr.tile), rows);
                std::string p = tilePath(root, pyr.maxLevel, tx, ty, ext);
                if (!cv::imwrite(p, s(t), ext == "png" ? std::vector<int>{cv::IMWRITE_PNG_COMPRESSION, 3} : std::vector<int>{cv::IMWRITE_JPEG_QUALITY, a.value("quality", 92)}))
                    throw UserError("storage_full", "Could not write the tile package (storage full?).");
            }
            ctx.report("Exporting tiles", 0.8 * (ty + 1) / pyr.rows(pyr.maxLevel));
        }
        buildLowerLevels(root, pyr, ext, ctx, "Exporting tiles", 0.8, 1.0);
        for (int L = 0; L <= pyr.maxLevel; L++) files += (long)pyr.cols(L) * pyr.rows(L);
    }
    writeDzi(outDir + "/image.dzi", pyr, ext);
    // self-contained offline viewer (no network, no external libraries)
    std::string html = kViewerHtml;
    json cfg = {{"width", pyr.w}, {"height", pyr.h}, {"tileSize", pyr.tile}, {"maxLevel", pyr.maxLevel}, {"format", ext}, {"title", P.j.value("name", "Detailed Capture")},
                {"scale", R.manifest["scale"]}, {"estimatedDetailMP", R.manifest["stats"]["estimatedDetailMP"]}, {"outputMP", double(pyr.w) * pyr.h / 1e6}};
    size_t pos = html.find("/*CONFIG*/");
    if (pos != std::string::npos) html.replace(pos, 10, cfg.dump());
    atomicWriteFile(outDir + "/viewer.html", html);
    json man = R.manifest;
    man["exportWidth"] = pyr.w;
    man["exportHeight"] = pyr.h;
    man["exportFormat"] = ext;
    man["editsApplied"] = !direct;
    man["editTransform"] = T.M.toJson();
    atomicWriteFile(outDir + "/manifest.json", man.dump(1));
    atomicWriteFile(outDir + "/README.txt",
                    "Detailed Capture tile package\n\nOpen viewer.html in any browser (works offline from disk).\nimage.dzi + image_files/ is a standard "
                    "Deep Zoom (DZI) pyramid readable by OpenSeadragon, libvips, QuPath and similar tools.\nmanifest.json records which source photographs "
                    "contribute to each tile (provenance) and the estimated genuine detail.\nTiles are 8-bit RGB (" +
                        std::string(ext == "png" ? "lossless PNG" : "JPEG quality 92") + "), colour space: " + R.manifest.value("colorSpace", "sRGB") + ".\n");
    return {{"outDir", outDir}, {"width", pyr.w}, {"height", pyr.h}, {"format", ext}, {"files", files + 4}, {"maxLevel", pyr.maxLevel}, {"lossless", ext == "png"}};
}

// ---------------------------------------------------------------------------------------------- inspect
json inspectPoint(Project& P, const json& a) {
    ResultInfo R = loadResult(P);
    double x = a.at("x"), y = a.at("y");  // base output px
    const json& M = R.manifest;
    cv::Mat labels = cv::imread(R.dir + "/labels.png", cv::IMREAD_UNCHANGED);
    int q = M["seamScale"];
    int u = std::min(labels.cols - 1, std::max(0, (int)(x / q))), v = std::min(labels.rows - 1, std::max(0, (int)(y / q)));
    int label = labels.empty() ? 0 : labels.at<uchar>(v, u);
    Pt c{x / M["scaleX"].get<double>(), y / M["scaleY"].get<double>()};
    json out = {{"label", label}, {"canvas", {c.x, c.y}}};
    json cands = json::array();
    for (const json& f : M["frames"]) {
        FrameModel fm(f["width"], f["height"], H3::fromJson(f["H"]), f.value("k1", 0.0));
        Pt p = fm.toFrame(c);
        bool inside = p.x >= 0 && p.y >= 0 && p.x < fm.w && p.y < fm.h;
        if (!inside) continue;
        json e = {{"id", f["id"]}, {"label", f["label"]}, {"fx", p.x}, {"fy", p.y}, {"scale", fm.scaleAt(c)}, {"used", f["label"].get<int>() == label}};
        cands.push_back(e);
        if (f["label"].get<int>() == label) out["source"] = e;
    }
    out["candidates"] = cands;
    out["isOverviewOnly"] = label == 0;
    return out;
}

json inspectCrop(Project& P, const json& a) {
    // Writes actual, un-resampled source pixels around a frame coordinate (oriented, native resolution).
    std::string id = a.at("frameId");
    const json* f = P.frame(id);
    if (!f) throw UserError("no_frame", "Frame not found.");
    ImageMeta meta = metaFromFrame(*f);
    cv::Mat img = loadOriented(framePath(P, *f), meta, 1, "");
    int size = a.value("size", 512);
    int cx = (int)std::floor(a.value("fx", img.cols / 2.0)), cy = (int)std::floor(a.value("fy", img.rows / 2.0));
    cv::Rect r(cx - size / 2, cy - size / 2, size, size);
    r &= cv::Rect(0, 0, img.cols, img.rows);
    if (r.empty()) throw UserError("bad_args", "Point outside the frame.");
    std::string out = a.at("out");
    cv::imwrite(out, img(r));
    return {{"out", out}, {"x", r.x}, {"y", r.y}, {"w", r.width}, {"h", r.height}};
}

// Matched crops for inspection / evaluation: fused result vs. overview enlarged to identical dimensions.
json debugCrops(Project& P, const json& a) {
    ResultInfo R = loadResult(P);
    cv::Rect r(a.at("x"), a.at("y"), a.at("w"), a.at("h"));
    ImageCache cache(256u << 20);
    cv::Mat res = readPyramidRect(R.root, R.pyr, R.pyr.maxLevel, r, "png", cache);
    std::string prefix = a.at("prefix");
    cv::imwrite(prefix + "_result.png", res);
    // overview through the same canvas mapping, bicubic
    json* ov = P.overview();
    ImageMeta meta = metaFromFrame(*ov);
    cv::Mat o = loadOriented(framePath(P, *ov), meta, 1, "");
    Radial rad(o.cols, o.rows, R.manifest.value("overviewK1", 0.0));
    double sx = R.manifest["scaleX"], sy = R.manifest["scaleY"];
    cv::Mat mx(r.height, r.width, CV_32F), my(r.height, r.width, CV_32F);
    for (int y = 0; y < r.height; y++)
        for (int x = 0; x < r.width; x++) {
            Pt p = rad.distort({(r.x + x + 0.5) / sx, (r.y + y + 0.5) / sy});
            mx.at<float>(y, x) = (float)(p.x - 0.5);
            my.at<float>(y, x) = (float)(p.y - 0.5);
        }
    cv::Mat up;
    cv::remap(o, up, mx, my, cv::INTER_CUBIC, cv::BORDER_REPLICATE);
    cv::imwrite(prefix + "_overview.png", up);
    json out = {{"result", prefix + "_result.png"}, {"overview", prefix + "_overview.png"}};
    json ip = inspectPoint(P, {{"x", r.x + r.width / 2.0}, {"y", r.y + r.height / 2.0}});
    out["inspect"] = ip;
    if (ip.contains("source") && ip["source"]["label"].get<int>() > 0) {
        json c = inspectCrop(P, {{"frameId", ip["source"]["id"]}, {"fx", ip["source"]["fx"]}, {"fy", ip["source"]["fy"]},
                                 {"size", (int)std::lround(std::max(r.width, r.height) * ip["source"]["scale"].get<double>() / sx)}, {"out", prefix + "_source.png"}});
        out["source"] = c;
    }
    return out;
}

json mapPoints(Project& P, const json& a) {
    std::string from = a.at("from"), to = a.at("to");
    json* ov = P.overview();
    if (!ov) throw UserError("no_overview", "Add an overview photo first.");
    Radial rad = overviewRadial(P);
    double S = 1, sx = 1, sy = 1;
    if (!P.j["result"].is_null()) {
        S = P.j["result"].value("scale", 1.0);
        int ovW = (*ov)["meta"]["width"], ovH = (*ov)["meta"]["height"];
        sx = P.j["result"].value("width", ovW) / double(ovW);
        sy = P.j["result"].value("height", ovH) / double(ovH);
    }
    (void)S;
    auto model = [&](const std::string& spec) -> FrameModel {
        std::string id = spec.substr(6);
        const json* f = P.frame(id);
        if (!f || !f->contains("reg") || !(*f)["reg"].contains("H")) throw UserError("not_registered", "That photo has no position yet.");
        return FrameModel((*f)["meta"]["width"], (*f)["meta"]["height"], H3::fromJson((*f)["reg"]["H"]), (*f)["reg"].value("k1", 0.0));
    };
    json out = json::array();
    for (auto& p : a.at("pts")) {
        Pt c{p[0].get<double>(), p[1].get<double>()};
        if (from == "overview") c = rad.undistort(c);
        else if (from == "output") c = {c.x / sx, c.y / sy};
        else if (from.rfind("frame:", 0) == 0) c = model(from).toCanvas(c);
        Pt r = c;
        if (to == "overview") r = rad.distort(c);
        else if (to == "output") r = {c.x * sx, c.y * sy};
        else if (to.rfind("frame:", 0) == 0) r = model(to).toFrame(c);
        out.push_back({r.x, r.y});
    }
    return {{"pts", out}};
}

json measure(Project& P, const json& a) {
    // Distances are in pixels unless the user supplied an explicit reference length on the same plane.
    json* ov = P.overview();
    if (!ov) throw UserError("no_overview", "Add an overview photo first.");
    double x1 = a.at("x1"), y1 = a.at("y1"), x2 = a.at("x2"), y2 = a.at("y2");  // canvas (overview px) coords
    double d = std::hypot(x2 - x1, y2 - y1);
    json out = {{"canvasPx", d}, {"calibrated", false},
                {"note", "Pixel distance in overview pixels. Visual detail is not certified measurement accuracy; set a reference length to get real units."}};
    const json& cal = P.j["calibration"];
    if (cal.is_object() && cal.contains("length") && cal.value("length", 0.0) > 0) {
        double rd = std::hypot(cal.value("x2", 0.0) - cal.value("x1", 0.0), cal.value("y2", 0.0) - cal.value("y1", 0.0));
        if (rd > 1) {
            double len = cal["length"], lenSigma = cal.value("lengthSigma", 0.0), ep = cal.value("endpointSigmaPx", 1.5);
            // registration contributes local position noise; use the mean anchor residual when available
            double reg = 0.5;
            int n = 0;
            double acc = 0;
            for (json* f : P.closeups())
                if (f->contains("reg") && (*f)["reg"].contains("anchorResidualPx")) {
                    acc += (*f)["reg"]["anchorResidualPx"].get<double>();
                    n++;
                }
            if (n) reg = std::max(0.5, acc / n);
            double e2 = ep * ep + reg * reg;  // per endpoint variance (canvas px^2)
            double value = d * len / rd;
            double rel = std::sqrt((lenSigma / len) * (lenSigma / len) + 2 * e2 / (rd * rd) + 2 * e2 / std::max(1.0, d * d));
            out["calibrated"] = true;
            out["value"] = value;
            out["unit"] = cal.value("unit", "mm");
            out["sigma"] = value * rel;
            out["relativeSigma"] = rel;
            out["note"] = "Estimate from your reference length, valid only on the same flat plane as the reference and assuming a fronto-parallel, "
                          "distortion-free overview. Uncertainty (1 sigma) combines endpoint placement (" +
                          std::to_string(ep).substr(0, 4) + " px), registration residual and the reference's stated uncertainty. Not a certified measurement.";
        }
    }
    return out;
}

}  // namespace dc
