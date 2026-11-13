// JNI bridge: a single generic command entry point into the Detailed Capture core.
#include <jni.h>
#include <android/log.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <map>
#include <mutex>
#include "dc/project.h"

namespace {
struct TokenState {
    std::shared_ptr<std::atomic<bool>> cancel = std::make_shared<std::atomic<bool>>(false);
    std::string stage, detail;
    double fraction = 0;
};
std::mutex g_mu;
std::map<jlong, std::shared_ptr<TokenState>> g_tokens;

std::shared_ptr<TokenState> token(jlong t, bool create) {
    std::lock_guard<std::mutex> lk(g_mu);
    auto it = g_tokens.find(t);
    if (it != g_tokens.end()) return it->second;
    if (!create) return nullptr;
    return g_tokens[t] = std::make_shared<TokenState>();
}
std::string jstr(JNIEnv* env, jstring s) {
    if (!s) return "";
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string r(c);
    env->ReleaseStringUTFChars(s, c);
    return r;
}
}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL Java_com_detailedcapture_app_Core_nativeCall(JNIEnv* env, jobject, jstring jcmd, jstring jargs, jlong jtoken, jint threads, jint memMB) {
    std::string cmd = jstr(env, jcmd), args = jstr(env, jargs);
    dc::Ctx ctx;
    ctx.threads = threads > 0 ? threads : 2;
    ctx.memoryBudgetMB = memMB > 0 ? memMB : 384;
    std::shared_ptr<TokenState> ts;
    if (jtoken != 0) {
        ts = token(jtoken, true);
        ctx.cancel = ts->cancel;
        ctx.progress = [ts](const std::string& stage, double f, const std::string& detail) {
            std::lock_guard<std::mutex> lk(g_mu);
            ts->stage = stage;
            ts->fraction = f;
            ts->detail = detail;
        };
    }
    std::string out = dc::apiCall(cmd, args, ctx);
    if (jtoken != 0) {
        std::lock_guard<std::mutex> lk(g_mu);
        g_tokens.erase(jtoken);
    }
    return env->NewStringUTF(out.c_str());
}

JNIEXPORT void JNICALL Java_com_detailedcapture_app_Core_nativeCancel(JNIEnv*, jobject, jlong jtoken) {
    auto ts = token(jtoken, true);  // create: a cancel may arrive just before the call registers its token
    ts->cancel->store(true);
}

JNIEXPORT jstring JNICALL Java_com_detailedcapture_app_Core_nativeProgress(JNIEnv* env, jobject, jlong jtoken) {
    auto ts = token(jtoken, false);
    if (!ts) return env->NewStringUTF("");
    dc::json j;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        j = {{"stage", ts->stage}, {"fraction", ts->fraction}, {"detail", ts->detail}};
    }
    return env->NewStringUTF(j.dump().c_str());
}

// Live localisation of a camera preview frame (Y plane) on the overview.
JNIEXPORT jstring JNICALL Java_com_detailedcapture_app_Core_nativeLocate(JNIEnv* env, jobject, jstring jdir, jobject buffer, jint w, jint h, jint rowStride, jint rotation) {
    try {
        auto* data = (uint8_t*)env->GetDirectBufferAddress(buffer);
        if (!data) return env->NewStringUTF("{\"found\":false}");
        cv::Mat y(h, w, CV_8UC1, data, (size_t)rowStride), g;
        if (rotation == 90) cv::rotate(y, g, cv::ROTATE_90_CLOCKWISE);
        else if (rotation == 180) cv::rotate(y, g, cv::ROTATE_180);
        else if (rotation == 270) cv::rotate(y, g, cv::ROTATE_90_COUNTERCLOCKWISE);
        else g = y.clone();
        // quick sharpness / exposure numbers for live warnings
        cv::Mat small, lap;
        double f = 480.0 / std::max(g.cols, g.rows);
        cv::resize(g, small, cv::Size(), f, f, cv::INTER_AREA);
        cv::Laplacian(small, lap, CV_32F);
        cv::Scalar mu, sd;
        cv::meanStdDev(lap, mu, sd);
        double clipped = cv::countNonZero(small >= 250) / (double)small.total();
        double dark = cv::countNonZero(small <= 8) / (double)small.total();
        dc::json out = {{"found", false}};
        std::string dir = jstr(env, jdir);
        if (!dir.empty()) {
            try {
                out = dc::locatePreview(dir, g);
            } catch (const std::exception& e) {
                out = {{"found", false}, {"error", e.what()}};
            }
        }
        out["sharpness"] = sd[0];
        out["clipHi"] = clipped;
        out["clipLo"] = dark;
        out["mean"] = cv::mean(small)[0];
        out["w"] = g.cols;
        out["h"] = g.rows;
        return env->NewStringUTF(out.dump().c_str());
    } catch (const std::exception& e) {
        dc::json out = {{"found", false}, {"error", e.what()}};
        return env->NewStringUTF(out.dump().c_str());
    }
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) {
    dc::setLogSink([](const std::string& s) { __android_log_print(ANDROID_LOG_INFO, "dcore", "%s", s.c_str()); });
    cv::setNumThreads(4);
    return JNI_VERSION_1_6;
}
}
