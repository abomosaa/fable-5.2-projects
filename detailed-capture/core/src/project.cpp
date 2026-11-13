#include "dc/project.h"
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace dc {

static const int kUndoLimit = 60;

Project Project::create(const std::string& dir, const std::string& name) {
    std::error_code ec;
    fs::create_directories(dir + "/originals", ec);
    fs::create_directories(dir + "/work", ec);
    fs::create_directories(dir + "/results", ec);
    if (!fs::exists(dir + "/originals")) throw UserError("io", "Could not create the project folder.");
    Project P;
    P.dir = dir;
    P.j = json{{"version", 1},
               {"coreVersion", kCoreVersion},
               {"id", fs::path(dir).filename().string()},
               {"name", name},
               {"createdAt", nowIso()},
               {"modifiedAt", nowIso()},
               {"overviewId", nullptr},
               {"frames", json::array()},
               {"nextId", 1},
               {"edits",
                {{"rot90", 0}, {"angle", 0.0}, {"crop", nullptr}, {"perspective", nullptr},
                 {"color", {{"exposure", 0.0}, {"contrast", 0.0}, {"saturation", 0.0}, {"temperature", 0.0}, {"tint", 0.0}}},
                 {"overrides", json::array()}}},
               {"calibration", nullptr},
               {"undo", json::array()},
               {"redo", json::array()},
               {"settings", {{"targetGain", 2.0}, {"maxScale", 8.0}, {"maxOutputMP", 400.0}}},
               {"registration", nullptr},
               {"result", nullptr},
               {"job", nullptr}};
    P.save();
    return P;
}

Project Project::load(const std::string& dir) {
    Project P;
    P.dir = dir;
    std::string path = dir + "/project.json";
    if (!fileExists(path)) throw UserError("no_project", "Project not found.");
    try {
        P.j = json::parse(readFile(path));
    } catch (const std::exception&) {
        // a torn write cannot happen (atomic rename), but guard against external damage
        throw UserError("corrupt_project", "The project file is damaged and could not be read.");
    }
    return P;
}

void Project::save() {
    j["modifiedAt"] = nowIso();
    atomicWriteFile(dir + "/project.json", j.dump(1));
}

json* Project::frame(const std::string& id) {
    for (auto& f : j["frames"])
        if (f["id"] == id) return &f;
    return nullptr;
}
const json* Project::frame(const std::string& id) const {
    for (auto& f : j["frames"])
        if (f["id"] == id) return &f;
    return nullptr;
}
json* Project::overview() {
    if (j["overviewId"].is_null()) return nullptr;
    return frame(j["overviewId"].get<std::string>());
}
std::vector<json*> Project::closeups(bool includeRemoved) {
    std::vector<json*> out;
    for (auto& f : j["frames"]) {
        if (f["role"] != "closeup") continue;
        if (!includeRemoved && f["user"].value("removed", false)) continue;
        out.push_back(&f);
    }
    return out;
}
std::string Project::newId(const char* prefix) {
    int n = j.value("nextId", 1);
    j["nextId"] = n + 1;
    char buf[32];
    snprintf(buf, sizeof(buf), "%s%04d", prefix, n);
    return buf;
}
std::string Project::workingSpace() const {
    if (j["overviewId"].is_null()) return "sRGB";
    const json* o = frame(j["overviewId"].get<std::string>());
    return o ? o->at("meta").value("colorSpace", "sRGB") : "sRGB";
}
std::vector<uint8_t> Project::workingIcc() const {
    std::string p = dir + "/work/working.icc";
    if (!fileExists(p)) return {};
    std::string s = readFile(p);
    return std::vector<uint8_t>(s.begin(), s.end());
}

json Project::editable() const {
    json e;
    e["edits"] = j["edits"];
    e["calibration"] = j["calibration"];
    json fu = json::object();
    for (auto& f : j["frames"]) fu[f["id"].get<std::string>()] = f["user"];
    e["frames"] = fu;
    return e;
}
void Project::applyEditable(const json& e) {
    j["edits"] = e["edits"];
    j["calibration"] = e["calibration"];
    for (auto& f : j["frames"]) {
        std::string id = f["id"];
        if (e["frames"].contains(id)) f["user"] = e["frames"][id];
    }
}
void Project::pushUndo() {
    j["undo"].push_back(editable());
    while ((int)j["undo"].size() > kUndoLimit) j["undo"].erase(j["undo"].begin());
    j["redo"] = json::array();
}
bool Project::undo() {
    if (j["undo"].empty()) return false;
    j["redo"].push_back(editable());
    json e = j["undo"].back();
    j["undo"].erase(j["undo"].size() - 1);
    applyEditable(e);
    return true;
}
bool Project::redo() {
    if (j["redo"].empty()) return false;
    j["undo"].push_back(editable());
    json e = j["redo"].back();
    j["redo"].erase(j["redo"].size() - 1);
    applyEditable(e);
    return true;
}

std::string Project::inputHash() const {
    // Everything that changes the composed pixels of the base (un-edited) output.
    json h;
    h["overview"] = j["overviewId"];
    json fr = json::array();
    for (auto& f : j["frames"]) {
        if (f["role"] != "closeup") continue;
        if (f["user"].value("removed", false)) continue;
        json e;
        e["id"] = f["id"];
        e["included"] = f["user"].value("included", true);
        e["status"] = f.contains("reg") ? f["reg"].value("status", "unprocessed") : "unprocessed";
        if (f.contains("reg") && f["reg"].contains("H")) {
            e["H"] = f["reg"]["H"];
            e["k1"] = f["reg"].value("k1", 0.0);
            e["mask"] = f["reg"].value("maskBits", "");
        }
        fr.push_back(e);
    }
    h["frames"] = fr;
    h["overrides"] = j["edits"].value("overrides", json::array());
    h["settings"] = j["settings"];
    h["ovk1"] = j["registration"].is_null() ? 0.0 : j["registration"].value("overviewK1", 0.0);
    std::string s = h.dump();
    char buf[32];
    snprintf(buf, sizeof(buf), "%016llx", (unsigned long long)fnv1a(s.data(), s.size()));
    return buf;
}

ImageMeta metaFromFrame(const json& f) {
    const json& m = f.at("meta");
    ImageMeta im;
    im.format = m.value("format", "other");
    im.storedW = m.value("storedW", 0);
    im.storedH = m.value("storedH", 0);
    im.bitDepth = m.value("bitDepth", 8);
    im.orientation = m.value("orientation", 1);
    im.colorSpace = m.value("colorSpace", "sRGB");
    im.hasIcc = m.value("hasIcc", false);
    im.exif = m.value("exif", json::object());
    return im;
}
std::string framePath(const Project& P, const json& f) {
    if (f.contains("working") && f["working"].is_string()) return P.abs(f["working"].get<std::string>());
    return P.abs(f["file"].get<std::string>());
}

Radial overviewRadial(Project& P) {
    json* o = P.overview();
    if (!o) return Radial();
    double k1 = P.j["registration"].is_null() ? 0.0 : P.j["registration"].value("overviewK1", 0.0);
    return Radial((*o)["meta"]["width"].get<int>(), (*o)["meta"]["height"].get<int>(), k1);
}

std::vector<LoadedFrame> acceptedFrames(Project& P) {
    std::vector<LoadedFrame> out;
    for (json* fp : P.closeups()) {
        json& f = *fp;
        if (!f["user"].value("included", true)) continue;
        if (!f.contains("reg") || f["reg"].value("status", "") != "accepted") continue;
        LoadedFrame L;
        L.id = f["id"];
        L.model = FrameModel(f["meta"]["width"].get<int>(), f["meta"]["height"].get<int>(), H3::fromJson(f["reg"]["H"]), f["reg"].value("k1", 0.0));
        L.quality = FrameQuality::fromJson(f["quality"]);
        L.mgw = f["reg"].value("maskW", 0);
        L.mgh = f["reg"].value("maskH", 0);
        std::string bits = f["reg"].value("maskBits", "");
        if ((int)bits.size() == L.mgw * L.mgh && !bits.empty()) {
            L.mask.resize(bits.size());
            for (size_t i = 0; i < bits.size(); i++) L.mask[i] = bits[i] == '1';
        }
        out.push_back(std::move(L));
    }
    return out;
}

// --------------------------------------------------------------------------------------------- add frame
json addFrame(Project& P, const json& a, const Ctx& ctx) {
    std::string rel = a.at("file");
    std::string role = a.value("role", "closeup");
    if (role == "overview" && !P.j["overviewId"].is_null()) throw UserError("has_overview", "This project already has an overview.");
    if (role == "closeup" && P.j["overviewId"].is_null()) throw UserError("no_overview", "Add an overview photo first.");
    json f;
    f["role"] = role;
    f["file"] = rel;
    if (a.contains("working") && a["working"].is_string()) f["working"] = a["working"];
    f["sidecars"] = a.value("sidecars", json::array());
    f["source"] = a.value("source", "import");
    f["originalName"] = a.value("originalName", "");
    f["addedAt"] = nowIso();
    f["capture"] = a.value("capture", json::object());  // camera-side metadata (lens id, AE/AF lock, calibration…)
    std::string path = framePath(P, f);
    ImageMeta meta = readMeta(path);
    // container metadata of the ORIGINAL is authoritative for EXIF even when a working copy is decoded
    if (f.contains("working")) {
        try {
            ImageMeta om = readMeta(P.abs(rel));
            if (!om.exif.empty()) meta.exif = om.exif;
        } catch (...) {
        }
        if (a.contains("exif") && a["exif"].is_object()) meta.exif.update(a["exif"]);
    }
    if (!fileLooksComplete(path, meta))
        throw UserError("truncated", "This photo file is incomplete (it ends before the image does). It was probably cut off while being copied or downloaded; get the file again and re-import it.");
    cv::Mat img;
    if (meta.storedW == 0 || meta.storedH == 0) {
        // unknown container: let the decoder tell us the size
        img = loadOriented(path, meta, 1, "");
        meta.storedW = img.cols;
        meta.storedH = img.rows;
    }
    double mp = double(meta.storedW) * meta.storedH / 1e6;
    if (mp > 110) throw UserError("too_large", "Photos above 110 megapixels are not supported on-device. Export a smaller copy and import that.");
    if (meta.storedW < 320 || meta.storedH < 320) throw UserError("too_small", "This image is too small to be useful (minimum 320 px per side).");
    ctx.report("Analyzing photo", 0.1);
    if (img.empty()) img = loadOriented(path, meta, 1, "");
    f["meta"] = meta.toJson();
    json warn = json::array();
    if (role == "overview") {
        if (meta.hasIcc) {
            std::string icc((const char*)meta.icc.data(), meta.icc.size());
            atomicWriteFile(P.abs("work/working.icc"), icc);
        }
        if (meta.colorSpace == "unknown") warn.push_back("color_profile_unknown");
    } else {
        std::string ws = P.workingSpace();
        if (meta.colorSpace != ws) {
            if (meta.colorSpace == "unknown" || ws == "unknown") warn.push_back("color_profile_unknown");
            else warn.push_back("color_converted");
        }
    }
    if (meta.bitDepth > 8) warn.push_back("bit_depth_reduced");
    FrameQuality q = analyzeQuality(img);
    f["quality"] = q.toJson();
    if (q.bestSigma > 2.2) warn.push_back("blurry");
    if (q.clipHi > 0.05) warn.push_back("overexposed");
    if (q.clipLo > 0.30) warn.push_back("underexposed");
    if (q.glareFrac > 0.004) warn.push_back("glare");
    if (q.texturedFrac < 0.15) warn.push_back("textureless");
    f["warnings"] = warn;
    // lens group: frames sharing optics share one radial distortion parameter
    {
        const json& e = meta.exif;
        std::string sig = e.value("make", "") + "|" + e.value("model", "") + "|" + e.value("lens", "") + "|";
        if (e.contains("focalLength")) sig += std::to_string((int)std::lround(e["focalLength"].get<double>() * 100));
        sig += "|" + std::to_string(std::max(meta.storedW, meta.storedH)) + "x" + std::to_string(std::min(meta.storedW, meta.storedH));
        if (f["capture"].contains("lensId")) sig += "|" + f["capture"]["lensId"].dump();
        f["lensGroup"] = sig;
    }
    if (a.contains("hint") && a["hint"].is_object()) f["hint"] = a["hint"];
    f["user"] = {{"included", true}, {"removed", false}, {"forceAccept", false}, {"manualPoints", json::array()}};
    f["reg"] = {{"status", role == "overview" ? "anchor" : "unprocessed"}};
    std::string id = a.contains("_id") ? a["_id"].get<std::string>() : P.newId(role == "overview" ? "ov" : "f");
    f["id"] = id;
    ctx.report("Analyzing photo", 0.7);
    // thumbnail for lists (not used by any processing)
    {
        double s = 512.0 / std::max(img.cols, img.rows);
        cv::Mat th;
        if (s < 1) cv::resize(img, th, cv::Size(), s, s, cv::INTER_AREA);
        else th = img;
        cv::imwrite(P.abs("work/" + id + "_thumb.jpg"), th, {cv::IMWRITE_JPEG_QUALITY, 88});
        f["thumb"] = "work/" + id + "_thumb.jpg";
    }
    P.j["frames"].push_back(f);
    if (role == "overview") P.j["overviewId"] = id;
    if (!a.value("_noSave", false)) P.save();
    ctx.report("Analyzing photo", 1.0);
    return f;
}

std::string reasonText(const std::string& c) {
    static const std::map<std::string, std::string> t = {
        {"no_match", "Not enough reliable matching detail was found between this photo and the overview or its neighbours. Take an intermediate photo from a little further back that shows this area plus some surrounding context."},
        {"disconnected", "This photo matches other close-ups but none of them is connected to the overview, so its position would be a guess. Add an intermediate-distance photo linking this area to the overview."},
        {"ambiguous_repeat", "The subject repeats here (pattern, tiles, similar text), so more than one position fits equally well. Capture a wider intermediate frame that includes a unique landmark, or place this photo manually with reference points."},
        {"bad_geometry", "No consistent flat alignment was found: the best candidate would fold, mirror or collapse the photo. It may show a different subject or area, a repeating pattern, or a very oblique view. Retake it more squarely with more surrounding context."},
        {"weak_match", "Only a few matches support this position and they cover a small part of the photo. Retake with more overlap with already-verified areas."},
        {"content_mismatch", "After alignment the photo does not look like the overview at that position. It may show a different area, or the scene changed."},
        {"low_similarity", "The aligned photo only partly resembles the overview (different lighting, glare, or a moved object). Check it before including it."},
        {"no_detail_gain", "This photo is not closer or sharper than what is already available, so it adds no real detail."},
        {"blurry", "This photo is blurred (focus or motion), so it adds no real detail. Hold steady, let focus settle, and retake."},
        {"inconsistent", "Large parts of this photo do not agree with a flat subject (parallax from depth, reflections or movement). It was left out."},
        {"parallax", "Parts of this photo shift relative to its neighbours in a way a flat surface cannot: the subject has depth, or the camera moved around a 3D object. Those parts are masked; planar stitching cannot represent them."},
        {"high_residual", "This photo could not be aligned as precisely as a flat subject allows (lens distortion, a curved or uneven surface, or depth). Edges may break or double at its border, so it is left out unless you choose to use it."},
        {"chain_only", "This photo is positioned only through neighbouring close-ups and could not be checked against the overview (no texture there)."},
        {"conflict", "This photo's match to the overview disagrees with its neighbours. One of them is wrong (often a repeating pattern)."},
        {"partial_mask", "Some regions of this photo were masked because they did not agree with the rest (reflection, depth or movement)."},
        {"soft_regions", "Parts of this photo are blurrier than the overview (focus fall-off or motion). The overview is used in those parts."},
        {"user_forced", "Included at your request although automatic checks were not confident."},
        {"manual", "Placed using your reference points."},
        {"overexposed", "Bright areas are clipped to white. Clipped highlights contain no detail and cannot be recovered; lower the exposure and retake."},
        {"underexposed", "Large areas are nearly black; detail there is lost in noise."},
        {"glare", "A reflection or glare patch was detected. Change the angle of the light or camera; glare hides real detail."},
        {"textureless", "Most of this photo has no visible texture, which makes reliable alignment impossible there."},
        {"color_profile_unknown", "The colour profile is not recognised; colours are used as-is."},
        {"color_converted", "Converted to the overview's colour space."},
        {"bit_depth_reduced", "Source has more than 8 bits per channel; processing uses 8 bits."},
        {"exposure_mismatch", "Exposure or white balance differs noticeably from the overview; colours were matched at low frequency only."},
        {"lens_distortion", "A lens distortion correction estimated from the overlaps was applied."},
        {"excluded", "Excluded by you."},
    };
    auto it = t.find(c);
    return it == t.end() ? c : it->second;
}

}  // namespace dc
