// Image metadata (EXIF / ICC), oriented decoding, colour-space normalisation and streaming encoders.
#pragma once
#include "common.h"

namespace dc {

struct ImageMeta {
    std::string format;  // "jpeg", "png", "other"
    int storedW = 0, storedH = 0, bitDepth = 8, orientation = 1;
    std::string colorSpace = "sRGB";  // "sRGB", "Display P3", "Adobe RGB", "unknown"
    bool hasIcc = false;
    std::vector<uint8_t> icc;  // raw embedded profile (may be empty)
    json exif = json::object();  // make, model, lens, focalLength, focalLength35, fNumber, exposureTime, iso, dateTime
    int width() const { return (orientation >= 5 && orientation <= 8) ? storedH : storedW; }
    int height() const { return (orientation >= 5 && orientation <= 8) ? storedW : storedH; }
    json toJson() const;
};

// Parses container metadata without decoding pixels. Throws UserError("unreadable", ...) on failure.
ImageMeta readMeta(const std::string& path);

// True unless the container is visibly truncated (JPEG without an end-of-image marker, PNG without IEND).
// Decoders silently fill the missing part of a truncated JPEG with grey; such a file must not become an "original".
bool fileLooksComplete(const std::string& path, const ImageMeta& meta);

// Decodes to 8-bit BGR in ORIENTED coordinates. `reduce` in {1,2,4,8}: integer down-sampling (exact 1/reduce scale,
// i.e. reduced continuous coordinate = full continuous coordinate / reduce). If `workingSpace` is non-empty and
// differs from the file's (known) colour space the pixels are converted with a matrix in linear light.
cv::Mat loadOriented(const std::string& path, const ImageMeta& meta, int reduce = 1, const std::string& workingSpace = "");
cv::Mat loadOrientedGray(const std::string& path, const ImageMeta& meta, int reduce = 1);

// Colour conversion between known RGB spaces (in place, BGR 8-bit). Returns false if either space is unknown.
bool convertColorSpace(cv::Mat& bgr, const std::string& from, const std::string& to);

// ---- Streaming encoders (bounded memory, row based) -------------------------------------------------------
struct RowWriter {
    virtual ~RowWriter() = default;
    virtual void writeRows(const cv::Mat& bgrRows) = 0;  // CV_8UC3, any number of rows, full width
    virtual void finish() = 0;
};
// 8-bit RGB PNG; embeds `icc` (iCCP) when non-empty, otherwise an sRGB chunk.
std::unique_ptr<RowWriter> makePngWriter(const std::string& path, int w, int h, const std::vector<uint8_t>& icc, int zlevel = 6);
// 8-bit RGB TIFF, deflate strips, BigTIFF automatically when the estimated size requires it.
std::unique_ptr<RowWriter> makeTiffWriter(const std::string& path, int w, int h, const std::vector<uint8_t>& icc, bool forceBig = false);
// Baseline JPEG (4:4:4, quality 1..100), streaming MCU rows. Max 65535 px per side (format limit).
std::unique_ptr<RowWriter> makeJpegWriter(const std::string& path, int w, int h, int quality, const std::vector<uint8_t>& icc);

void atomicWriteFile(const std::string& path, const std::string& data);
std::string readFile(const std::string& path);
bool fileExists(const std::string& path);
uint64_t fnv1a(const void* data, size_t n, uint64_t seed = 1469598103934665603ULL);

}  // namespace dc
