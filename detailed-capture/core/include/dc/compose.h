// Composition internals shared between compose.cpp and export.cpp.
#pragma once
#include "project.h"
#include <list>
#include <mutex>

namespace dc {

// LRU cache of decoded images with a byte budget (thread safe; decoding is serialised).
class ImageCache {
   public:
    explicit ImageCache(size_t budgetBytes) : budget_(budgetBytes) {}
    std::shared_ptr<cv::Mat> get(const std::string& key, const std::function<cv::Mat()>& loader);
    void clear();

   private:
    struct Entry {
        std::string key;
        std::shared_ptr<cv::Mat> img;
        size_t bytes;
    };
    std::list<Entry> lru_;
    size_t budget_, used_ = 0;
    std::mutex mu_;
};

// Deep-Zoom (DZI) pyramid geometry: level `maxLevel` is full resolution, each lower level halves (ceil).
struct Pyramid {
    int w = 0, h = 0, tile = 512, maxLevel = 0;
    Pyramid() = default;
    Pyramid(int w_, int h_, int tile_ = 512) : w(w_), h(h_), tile(tile_) {
        maxLevel = 0;
        while ((1LL << maxLevel) < std::max(w, h)) maxLevel++;
    }
    int levelW(int L) const { return std::max(1, (int)(((long long)w + (1LL << (maxLevel - L)) - 1) >> (maxLevel - L))); }
    int levelH(int L) const { return std::max(1, (int)(((long long)h + (1LL << (maxLevel - L)) - 1) >> (maxLevel - L))); }
    int cols(int L) const { return (levelW(L) + tile - 1) / tile; }
    int rows(int L) const { return (levelH(L) + tile - 1) / tile; }
};
std::string tilePath(const std::string& root, int level, int col, int row, const std::string& ext);
// Builds all lower levels from an existing full-resolution level (2x2 area averaging). Skips tiles that exist.
void buildLowerLevels(const std::string& root, const Pyramid& pyr, const std::string& ext, const Ctx& ctx, const std::string& stage, double p0, double p1);
void writeDzi(const std::string& path, const Pyramid& pyr, const std::string& ext);
// Reads an arbitrary rectangle of a pyramid level from tiles (8-bit BGR). Outside pixels are replicated.
cv::Mat readPyramidRect(const std::string& root, const Pyramid& pyr, int level, cv::Rect r, const std::string& ext, ImageCache& cache);

// View edits: output coordinates -> export coordinates.
struct EditTransform {
    H3 M;          // base output px -> export px (continuous)
    int w = 0, h = 0;
    bool identity = true;   // pure copy (no resampling at all)
    bool integerOnly = true; // crop / 90-degree rotation only: exact pixel permutation
    float color[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};  // affine on encoded RGB in [0,1]: rows R,G,B ; cols r,g,b,offset
    bool hasColor = false;
};
EditTransform makeEditTransform(const json& edits, int outW, int outH);
void colorMatrixFromEdits(const json& color, float m[12]);

}  // namespace dc
