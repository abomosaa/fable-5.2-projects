// Command dispatcher: the single entry point used by the Android JNI bridge, the CLI and the tests.
#include "dc/compose.h"
#include <filesystem>
#include <mutex>

namespace fs = std::filesystem;

namespace dc {

json debugCrops(Project& P, const json& a);
json debugPair(Project& P, const json& a);

std::recursive_mutex& projectMutex() {
    static std::recursive_mutex m;
    return m;
}

namespace {
json okResult(const json& data) { return json{{"ok", true}, {"data", data}}; }
json errResult(const std::string& code, const std::string& message) { return json{{"ok", false}, {"error", {{"code", code}, {"message", message}}}}; }

void setJob(const std::string& dir, const json& job) {
    std::lock_guard<std::recursive_mutex> lk(projectMutex());
    try {
        Project P = Project::load(dir);
        P.j["job"] = job;
        P.save();
    } catch (...) {
    }
}

// Long-running command wrapper: records job state so that an interrupted job is visible after a restart.
template <class Fn>
json runJob(const std::string& dir, const std::string& type, Fn fn) {
    setJob(dir, {{"type", type}, {"state", "running"}, {"startedAt", nowIso()}});
    try {
        json r = fn();
        setJob(dir, {{"type", type}, {"state", "done"}, {"finishedAt", nowIso()}});
        return r;
    } catch (const CancelledError&) {
        setJob(dir, {{"type", type}, {"state", "cancelled"}, {"finishedAt", nowIso()}, {"resumable", type == "compose"}});
        throw;
    } catch (const UserError& e) {
        setJob(dir, {{"type", type}, {"state", "failed"}, {"finishedAt", nowIso()}, {"error", e.what()}, {"code", e.code}});
        throw;
    } catch (const std::exception& e) {
        setJob(dir, {{"type", type}, {"state", "failed"}, {"finishedAt", nowIso()}, {"error", e.what()}});
        throw;
    }
}

json dispatch(const std::string& cmd, const json& a, const Ctx& ctx) {
    std::string dir = a.value("dir", "");
    auto lock = [] { return std::unique_lock<std::recursive_mutex>(projectMutex()); };

    if (cmd == "version") return {{"core", kCoreVersion}, {"opencv", CV_VERSION}};
    if (cmd == "project.create") {
        auto lk = lock();
        return Project::create(dir, a.value("name", "Untitled")).j;
    }
    if (cmd == "project.load") {
        auto lk = lock();
        Project P = Project::load(dir);
        // a job that still claims to be running after a (re)load in a fresh process was interrupted
        if (a.value("recover", false) && P.j["job"].is_object() && P.j["job"].value("state", "") == "running") {
            P.j["job"]["state"] = "interrupted";
            P.j["job"]["resumable"] = P.j["job"].value("type", "") == "compose";
            P.save();
        }
        return P.j;
    }
    if (cmd == "project.rename") {
        auto lk = lock();
        Project P = Project::load(dir);
        P.j["name"] = a.at("name");
        P.save();
        return P.j;
    }
    if (cmd == "project.settings") {
        auto lk = lock();
        Project P = Project::load(dir);
        P.j["settings"].update(a.at("settings"));
        if (!P.j["result"].is_null()) P.j["result"]["stale"] = P.j["result"].value("inputHash", "") != P.inputHash();
        P.save();
        return P.j;
    }
    if (cmd == "frame.add") {
        // the id is reserved under the lock, the (slow) analysis runs outside it, the append is merged under it
        Project work;
        json args = a;
        {
            auto lk = lock();
            Project cur = Project::load(dir);
            args["_id"] = cur.newId(a.value("role", "closeup") == "overview" ? "ov" : "f");
            cur.save();
            work = cur;
        }
        args["_noSave"] = true;
        json f = addFrame(work, args, ctx);
        auto lk = lock();
        Project cur = Project::load(dir);
        if (f["role"] == "overview" && !cur.j["overviewId"].is_null()) throw UserError("has_overview", "This project already has an overview.");
        cur.j["frames"].push_back(f);
        if (f["role"] == "overview") cur.j["overviewId"] = f["id"];
        if (!cur.j["result"].is_null()) cur.j["result"]["stale"] = cur.j["result"].value("inputHash", "") != cur.inputHash();
        cur.save();
        return f;
    }
    if (cmd == "frame.update") {  // user-editable per-frame state (undoable)
        auto lk = lock();
        Project P = Project::load(dir);
        json* f = P.frame(a.at("id").get<std::string>());
        if (!f) throw UserError("no_frame", "Photo not found.");
        P.pushUndo();
        (*f)["user"].update(a.at("user"));
        if (a.contains("hint")) (*f)["hint"] = a["hint"];
        if (!P.j["result"].is_null()) P.j["result"]["stale"] = P.j["result"].value("inputHash", "") != P.inputHash();
        P.save();
        return P.j;
    }
    if (cmd == "frame.purge") {  // permanent deletion of removed frames (not undoable; originals are deleted)
        auto lk = lock();
        Project P = Project::load(dir);
        json keep = json::array();
        std::error_code ec;
        int n = 0;
        for (auto& f : P.j["frames"]) {
            if (f["role"] == "closeup" && f["user"].value("removed", false)) {
                fs::remove(P.abs(f["file"].get<std::string>()), ec);
                if (f.contains("working") && f["working"].is_string()) fs::remove(P.abs(f["working"].get<std::string>()), ec);
                for (auto& s : f.value("sidecars", json::array())) fs::remove(P.abs(s.get<std::string>()), ec);
                fs::remove(P.abs("work/" + f["id"].get<std::string>() + ".feat"), ec);
                fs::remove(P.abs("work/" + f["id"].get<std::string>() + "_thumb.jpg"), ec);
                n++;
            } else keep.push_back(f);
        }
        P.j["frames"] = keep;
        P.j["undo"] = json::array();
        P.j["redo"] = json::array();
        P.save();
        return {{"purged", n}};
    }
    if (cmd == "edits.set") {
        auto lk = lock();
        Project P = Project::load(dir);
        if (a.value("pushUndo", true)) P.pushUndo();
        if (a.contains("edits")) P.j["edits"].update(a["edits"]);
        if (a.contains("calibration")) P.j["calibration"] = a["calibration"];
        if (!P.j["result"].is_null()) P.j["result"]["stale"] = P.j["result"].value("inputHash", "") != P.inputHash();
        P.save();
        return P.j;
    }
    if (cmd == "undo" || cmd == "redo") {
        auto lk = lock();
        Project P = Project::load(dir);
        bool did = cmd == "undo" ? P.undo() : P.redo();
        if (did) {
            if (!P.j["result"].is_null()) P.j["result"]["stale"] = P.j["result"].value("inputHash", "") != P.inputHash();
            P.save();
        }
        json out = P.j;
        out["_changed"] = did;
        return out;
    }
    if (cmd == "edit.transform") {
        int W = a.at("width"), H = a.at("height");
        EditTransform T = makeEditTransform(a.at("edits"), W, H);
        json col = json::array();
        for (float v : T.color) col.push_back(v);
        return {{"M", T.M.toJson()}, {"width", T.w}, {"height", T.h}, {"color", col}, {"hasColor", T.hasColor}, {"identity", T.identity}, {"exact", T.integerOnly}};
    }
    if (cmd == "register") {
        Project P;
        {
            auto lk = lock();
            P = Project::load(dir);
        }
        return runJob(dir, "register", [&] {
            Project W = P;
            // work on a snapshot; merge the per-frame results into the freshest stored project afterwards
            json args = a;
            args["_noSave"] = true;
            json r = registerProject(W, args, ctx);
            auto lk = lock();
            Project cur = Project::load(dir);
            for (auto& f : W.j["frames"]) {
                json* cf = cur.frame(f["id"].get<std::string>());
                if (cf && f.contains("reg")) (*cf)["reg"] = f["reg"];
            }
            cur.j["registration"] = W.j["registration"];
            if (!cur.j["result"].is_null()) cur.j["result"]["stale"] = cur.j["result"].value("inputHash", "") != cur.inputHash();
            cur.save();
            return r;
        });
    }
    if (cmd == "coverage") {
        auto lk = lock();
        Project P = Project::load(dir);
        return computeCoverage(P, a.value("writeMap", true));
    }
    if (cmd == "compose") {
        Project P;
        {
            auto lk = lock();
            P = Project::load(dir);
        }
        return runJob(dir, "compose", [&] { return composeProject(P, a, ctx); });
    }
    if (cmd == "export.flat") {
        Project P = Project::load(dir);
        return exportFlat(P, a, ctx);
    }
    if (cmd == "export.tiles") {
        Project P = Project::load(dir);
        return exportTiles(P, a, ctx);
    }
    if (cmd == "inspect.point") {
        Project P = Project::load(dir);
        return inspectPoint(P, a);
    }
    if (cmd == "inspect.crop") {
        Project P = Project::load(dir);
        return inspectCrop(P, a);
    }
    if (cmd == "debug.crops") {
        Project P = Project::load(dir);
        return debugCrops(P, a);
    }
    if (cmd == "debug.pair") {
        Project P = Project::load(dir);
        return debugPair(P, a);
    }
    if (cmd == "map.points") {
        Project P = Project::load(dir);
        return mapPoints(P, a);
    }
    if (cmd == "measure") {
        Project P = Project::load(dir);
        return measure(P, a);
    }
    if (cmd == "result.manifest") {
        Project P = Project::load(dir);
        if (P.j["result"].is_null()) throw UserError("no_result", "There is no fused result yet.");
        std::string rd = P.abs("results/" + P.j["result"]["runId"].get<std::string>());
        json m = json::parse(readFile(rd + "/manifest.json"));
        if (!a.value("full", false)) {
            m.erase("provenance");
            m.erase("blocks");
        }
        m["dir"] = rd;
        return m;
    }
    if (cmd == "session.drop") {
        dropSessionCaches(dir);
        return json::object();
    }
    throw UserError("unknown_command", "Unknown command: " + cmd);
}
}  // namespace

std::string apiCall(const std::string& cmd, const std::string& argsJson, const Ctx& ctx) {
    try {
        json a = argsJson.empty() ? json::object() : json::parse(argsJson);
        return okResult(dispatch(cmd, a, ctx)).dump();
    } catch (const CancelledError&) {
        return errResult("cancelled", "Cancelled.").dump();
    } catch (const UserError& e) {
        return errResult(e.code, e.what()).dump();
    } catch (const json::exception& e) {
        return errResult("bad_args", std::string("Invalid arguments: ") + e.what()).dump();
    } catch (const cv::Exception& e) {
        return errResult("internal", std::string("Image processing error: ") + e.what()).dump();
    } catch (const std::bad_alloc&) {
        return errResult("out_of_memory", "Not enough memory for this operation. Close other apps or lower the maximum output size.").dump();
    } catch (const std::exception& e) {
        return errResult("internal", e.what()).dump();
    }
}

}  // namespace dc
