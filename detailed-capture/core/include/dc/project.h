// Project store (single owner of project.json), registration, coverage, composition and export entry points.
#pragma once
#include "common.h"
#include "features.h"
#include "geom.h"
#include "imageio.h"

namespace dc {

struct Project {
    std::string dir;
    json j;

    static Project create(const std::string& dir, const std::string& name);
    static Project load(const std::string& dir);
    void save();  // atomic (tmp + fsync + rename)

    std::string abs(const std::string& rel) const { return dir + "/" + rel; }
    json* frame(const std::string& id);
    const json* frame(const std::string& id) const;
    json* overview();
    std::vector<json*> closeups(bool includeRemoved = false);
    std::string newId(const char* prefix);
    std::string workingSpace() const;  // colour space all sources are normalised to (the overview's)
    std::vector<uint8_t> workingIcc() const;

    // Undo / redo over the user-editable state (view edits, per-frame user flags, manual points, calibration).
    json editable() const;
    void applyEditable(const json& e);
    void pushUndo();
    bool undo();
    bool redo();
    // hash of everything that influences registration / composition inputs
    std::string inputHash() const;
};

ImageMeta metaFromFrame(const json& frame);
std::string framePath(const Project& P, const json& frame);  // decodable file (working copy if present)

// ---- commands (all return JSON; see api.cpp for the dispatcher) -------------------------------------------
json addFrame(Project& P, const json& args, const Ctx& ctx);
json registerProject(Project& P, const json& args, const Ctx& ctx);
json computeCoverage(Project& P, bool writeMap);
json composeProject(Project& P, const json& args, const Ctx& ctx);
json exportFlat(Project& P, const json& args, const Ctx& ctx);
json exportTiles(Project& P, const json& args, const Ctx& ctx);
json inspectPoint(Project& P, const json& args);
json inspectCrop(Project& P, const json& args);
json measure(Project& P, const json& args);
json mapPoints(Project& P, const json& args);
// Live preview localisation against the overview (gray: CV_8U oriented preview frame).
json locatePreview(const std::string& dir, const cv::Mat& gray);
void dropSessionCaches(const std::string& dir = "");

// Generic entry point used by the JNI bridge, the CLI and the tests.
std::string apiCall(const std::string& cmd, const std::string& argsJson, const Ctx& ctx);

// plain-language text for reason / warning codes
std::string reasonText(const std::string& code);

// helpers shared by registrar / compose
struct LoadedFrame {
    std::string id;
    FrameModel model;
    FrameQuality quality;
    std::vector<uint8_t> mask;  // per quality-grid cell: 1 = inconsistent (excluded)
    int mgw = 0, mgh = 0;
    bool maskedAt(double fx, double fy) const {
        if (mask.empty()) return false;
        int cx = std::min(mgw - 1, std::max(0, (int)(fx / model.w * mgw))), cy = std::min(mgh - 1, std::max(0, (int)(fy / model.h * mgh)));
        return mask[cy * mgw + cx] != 0;
    }
};
// accepted + included + not removed frames with their final transforms
std::vector<LoadedFrame> acceptedFrames(Project& P);
Radial overviewRadial(Project& P);

}  // namespace dc
