cmake_minimum_required(VERSION 3.18)
project(dcore CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# OpenCV: Android builds use the OpenCV Android SDK package (OpenCV_DIR); host builds link the minimal static
# build produced by scripts/build_opencv_host.sh directly.
find_package(ZLIB REQUIRED)
if(ANDROID)
  find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs features2d flann calib3d)
else()
  set(OCV_HOST "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/opencv-host")
  set(OpenCV_INCLUDE_DIRS "${OCV_HOST}/include/opencv4")
  set(OpenCV_LIBS
    ${OCV_HOST}/lib/libopencv_calib3d.a ${OCV_HOST}/lib/libopencv_features2d.a ${OCV_HOST}/lib/libopencv_flann.a
    ${OCV_HOST}/lib/libopencv_imgcodecs.a ${OCV_HOST}/lib/libopencv_imgproc.a ${OCV_HOST}/lib/libopencv_core.a
    ${OCV_HOST}/lib/opencv4/3rdparty/liblibjpeg-turbo.a ${OCV_HOST}/lib/opencv4/3rdparty/liblibpng.a
    ${OCV_HOST}/lib/opencv4/3rdparty/liblibtiff.a ${OCV_HOST}/lib/opencv4/3rdparty/liblibwebp.a dl pthread)
endif()

add_library(dcore STATIC
  src/geom.cpp src/meta.cpp src/imageio.cpp src/features.cpp src/ba.cpp src/project.cpp
  src/registrar.cpp src/compose.cpp src/export.cpp src/viewer_html.cpp src/api.cpp)
target_include_directories(dcore PUBLIC include ${OpenCV_INCLUDE_DIRS})
target_link_libraries(dcore PUBLIC ${OpenCV_LIBS} ZLIB::ZLIB)
target_compile_options(dcore PRIVATE -Wall -Wno-unused-function -Wno-sign-compare)

if(NOT ANDROID)
  find_package(Threads REQUIRED)
  add_executable(dcap cli/main.cpp)
  target_link_libraries(dcap dcore Threads::Threads)
  add_executable(dcore_tests tests/tests.cpp)
  target_link_libraries(dcore_tests dcore Threads::Threads)
endif()
