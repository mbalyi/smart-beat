cmake_minimum_required(VERSION 3.24)
project(smart_beat_muscriptor LANGUAGES C CXX)

# The vendored muscriptor.cpp (MIT, see muscriptor/LICENSE) plus a small C wrapper that Rust
# links (build.rs). Static libraries only; no Accelerate/OpenMP, so nothing extra is bundled.
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(muscriptor)

add_library(sb_muscriptor STATIC shim.cpp)
target_link_libraries(sb_muscriptor PUBLIC muscriptor_ggml)
set_target_properties(sb_muscriptor PROPERTIES POSITION_INDEPENDENT_CODE ON)
