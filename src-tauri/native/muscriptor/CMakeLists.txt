cmake_minimum_required(VERSION 3.24)
project(muscriptor_ggml LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "" FORCE)
endif()

include(FetchContent)

# --- Apple target selection ---------------------------------------------
#
# One architecture per build tree: ggml picks its CPU kernels once per tree, and
# a multi-architecture list silently selects generic scalar code. Use the
# macos-arm64 / macos-x86_64 presets.
if(APPLE AND CMAKE_OSX_ARCHITECTURES)
    list(LENGTH CMAKE_OSX_ARCHITECTURES MUSCRIPTOR_OSX_ARCH_COUNT)

    if(MUSCRIPTOR_OSX_ARCH_COUNT GREATER 1)
        message(FATAL_ERROR
            "CMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES} asks for a universal build. ggml resolves "
            "its CPU architecture once per build tree, and a multi-architecture list makes it fall back to "
            "generic scalar kernels for every slice -- it builds, it just runs many times slower. Configure "
            "one tree per architecture instead.")
    endif()
endif()

# Default the macOS floor to 11.0 unless the consumer set one. The Metal shader
# compiler does not read CMAKE_OSX_DEPLOYMENT_TARGET. A target OS other than
# "macos" makes ggml pass the floor as -mtargetos=macosx<floor>, which the
# -mtargetos=macosx26.0 that ggml-tensor.metallib adds then overrides. The
# compiler rejects that flag next to -mmacosx-version-min.
if(APPLE)
    if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET 11.0 CACHE STRING "Minimum macOS version" FORCE)
    endif()

    set(GGML_METAL_TARGET_OS macosx CACHE STRING "" FORCE)
    set(GGML_METAL_MACOSX_VERSION_MIN "" CACHE STRING "" FORCE)
endif()

# --- ggml ---------------------------------------------------------------
#
# Pinned by full commit. To use a local checkout instead, configure with
#   -DFETCHCONTENT_SOURCE_DIR_GGML=/path/to/ggml
set(MUSCRIPTOR_GGML_COMMIT e91ded11bdcd78c42f9c8d3978ff6686eb4c1226)   # v0.23.0

# No Accelerate/BLAS: ggml-blas is only reached through a backend scheduler, and
# Model runs a single backend.
set(GGML_ACCELERATE  OFF CACHE BOOL "" FORCE)
set(GGML_BLAS        OFF CACHE BOOL "" FORCE)

# OpenMP off: the toolchain links libomp by absolute path, which end users do not
# have; ggml's own threadpool does the same work. Normal variable as well as
# cache (CMP0077, see BUILD_SHARED_LIBS below), and checked after the fetch.
set(GGML_OPENMP      OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP      OFF)

# GGML_NATIVE compiles for the build machine, and the result can fault on older
# CPUs, so it is off unless MUSCRIPTOR_NATIVE. It must also be off for the x86_64
# slice on an Apple Silicon host, where CMAKE_CROSSCOMPILING is false.
option(MUSCRIPTOR_NATIVE "Optimize for the build machine's CPU. Never for a shipped build" OFF)
set(GGML_NATIVE      ${MUSCRIPTOR_NATIVE} CACHE BOOL "" FORCE)
set(GGML_NATIVE      ${MUSCRIPTOR_NATIVE})

# x86 baseline: Ivy Bridge, the oldest CPU in a Mac that boots macOS 11. With
# native off, ggml would otherwise enable AVX2, BMI2 and FMA too. Normal variable
# as well as cache (CMP0077), and checked after the fetch. Ignored on ARM.
foreach(MUSCRIPTOR_X86_FEATURE GGML_SSE42 GGML_AVX GGML_F16C)
    set(${MUSCRIPTOR_X86_FEATURE} ON CACHE BOOL "" FORCE)
    set(${MUSCRIPTOR_X86_FEATURE} ON)
endforeach()

foreach(MUSCRIPTOR_X86_FEATURE GGML_AVX2 GGML_BMI2 GGML_FMA)
    set(${MUSCRIPTOR_X86_FEATURE} OFF CACHE BOOL "" FORCE)
    set(${MUSCRIPTOR_X86_FEATURE} OFF)
endforeach()

# Metal, on Apple platforms only. Without a Metal device, Auto runs on the CPU.
# How the shaders are shipped: docs/BUILDING.md#metal.
if(APPLE)
    set(MUSCRIPTOR_METAL_DEFAULT ON)
else()
    set(MUSCRIPTOR_METAL_DEFAULT OFF)
endif()

option(MUSCRIPTOR_METAL "Build the ggml Metal backend" ${MUSCRIPTOR_METAL_DEFAULT})

include(CMakeDependentOption)
cmake_dependent_option(MUSCRIPTOR_METAL_PRECOMPILED
    "Precompile the Metal shaders into a .metallib the executable ships" ON "MUSCRIPTOR_METAL" OFF)

if(MUSCRIPTOR_METAL)
    set(GGML_METAL ON CACHE BOOL "" FORCE)

    if(MUSCRIPTOR_METAL_PRECOMPILED)
        set(GGML_METAL_EMBED_LIBRARY OFF CACHE BOOL "" FORCE)

        execute_process(COMMAND xcrun -sdk macosx metal --version
                        RESULT_VARIABLE MUSCRIPTOR_METAL_TOOLCHAIN_RESULT
                        OUTPUT_QUIET ERROR_QUIET)

        if(NOT MUSCRIPTOR_METAL_TOOLCHAIN_RESULT EQUAL 0)
            message(FATAL_ERROR
                "MUSCRIPTOR_METAL_PRECOMPILED needs Xcode's Metal toolchain. Install it with "
                "`xcodebuild -downloadComponent MetalToolchain`, or configure with "
                "-DMUSCRIPTOR_METAL_PRECOMPILED=OFF to compile the shaders at run time instead.")
        endif()
    else()
        set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
    endif()
else()
    set(GGML_METAL OFF CACHE BOOL "" FORCE)
endif()

# Vulkan, everywhere Metal is not. Needs the SDK's headers and glslc at build
# time, so it defaults on only when the SDK is found.
if(APPLE)
    set(MUSCRIPTOR_VULKAN_DEFAULT OFF)
else()
    find_package(Vulkan QUIET COMPONENTS glslc)
    set(MUSCRIPTOR_VULKAN_DEFAULT ${Vulkan_FOUND})
endif()

option(MUSCRIPTOR_VULKAN "Build the ggml Vulkan backend" ${MUSCRIPTOR_VULKAN_DEFAULT})

if(MUSCRIPTOR_VULKAN)
    set(GGML_VULKAN ON  CACHE BOOL "" FORCE)

    # ggml builds its shader generator as a nested project that sees only the
    # environment, so on Windows it needs CC/CXX or a Visual Studio prompt.
    if(WIN32 AND NOT (DEFINED ENV{CC} AND DEFINED ENV{CXX}))
        find_program(MUSCRIPTOR_HOST_CL cl)

        if(NOT MUSCRIPTOR_HOST_CL)
            message(FATAL_ERROR
                "MUSCRIPTOR_VULKAN needs a host compiler discoverable without CMake arguments, for ggml's "
                "nested vulkan-shaders-gen build. Set CC, CXX and RC in the environment (e.g. clang, clang++ "
                "and llvm-rc), or configure and build from a Visual Studio developer prompt. "
                "-DMUSCRIPTOR_VULKAN=OFF builds without the Vulkan backend.")
        endif()
    endif()

    # With clang-cl, ggml-vulkan sets _ITERATOR_DEBUG_LEVEL=0 on itself only. Linked
    # statically, every other object must match or the link fails /failifmismatch.
    # Consumers get it from muscriptor_ggml below.
    if(MSVC AND CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
        add_compile_definitions(_ITERATOR_DEBUG_LEVEL=0)
    endif()
else()
    set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
endif()

set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)

FetchContent_Declare(ggml
    GIT_REPOSITORY https://github.com/ggml-org/ggml.git
    GIT_TAG        ${MUSCRIPTOR_GGML_COMMIT}
    GIT_SHALLOW    FALSE
)

# ggml defaults BUILD_SHARED_LIBS to ON; ggml is linked statically here. Saved and
# restored around the fetch so a consumer's own libraries are unaffected. Forced
# as a normal variable as well as in the cache: a consumer's normal variable would
# shadow the cache entry, and ggml's option() reads it under CMP0077. Checked
# below.
if(DEFINED BUILD_SHARED_LIBS)
    set(MUSCRIPTOR_SAVED_BUILD_SHARED_LIBS ${BUILD_SHARED_LIBS})
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF)
FetchContent_MakeAvailable(ggml)

# Restore the normal variable too; it is the one that wins on read.
unset(BUILD_SHARED_LIBS)

if(DEFINED MUSCRIPTOR_SAVED_BUILD_SHARED_LIBS)
    set(BUILD_SHARED_LIBS ${MUSCRIPTOR_SAVED_BUILD_SHARED_LIBS} CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS ${MUSCRIPTOR_SAVED_BUILD_SHARED_LIBS})
else()
    unset(BUILD_SHARED_LIBS CACHE)
endif()

# Fail at configure time if any ggml target is not static.
foreach(MUSCRIPTOR_GGML_TARGET ggml ggml-base ggml-cpu ggml-metal ggml-vulkan)
    if(TARGET ${MUSCRIPTOR_GGML_TARGET})
        get_target_property(MUSCRIPTOR_GGML_TARGET_TYPE ${MUSCRIPTOR_GGML_TARGET} TYPE)

        if(NOT MUSCRIPTOR_GGML_TARGET_TYPE STREQUAL "STATIC_LIBRARY")
            message(FATAL_ERROR
                "ggml target '${MUSCRIPTOR_GGML_TARGET}' built as ${MUSCRIPTOR_GGML_TARGET_TYPE}, "
                "not STATIC_LIBRARY. muscriptor.cpp links ggml statically; something re-enabled "
                "BUILD_SHARED_LIBS for the fetch.")
        endif()
    endif()
endforeach()

# The same check for OpenMP, which ggml links into ggml-base and ggml-cpu only,
# as OpenMP:: targets.
foreach(MUSCRIPTOR_OMP_TARGET ggml-base ggml-cpu)
    if(TARGET ${MUSCRIPTOR_OMP_TARGET})
        get_target_property(MUSCRIPTOR_OMP_LIBS ${MUSCRIPTOR_OMP_TARGET} LINK_LIBRARIES)

        if(MUSCRIPTOR_OMP_LIBS MATCHES "OpenMP::")
            message(FATAL_ERROR
                "ggml target '${MUSCRIPTOR_OMP_TARGET}' links OpenMP (${MUSCRIPTOR_OMP_LIBS}). "
                "muscriptor.cpp builds without OpenMP; something re-enabled GGML_OPENMP for the fetch.")
        endif()
    endif()
endforeach()

# And for the x86 instruction set, read from the compile line. No match on ARM.
if(TARGET ggml-cpu)
    get_target_property(MUSCRIPTOR_CPU_FLAGS ggml-cpu COMPILE_OPTIONS)

    if(MUSCRIPTOR_CPU_FLAGS MATCHES "-mavx2|-mfma|-mbmi2")
        message(FATAL_ERROR
            "ggml-cpu compiles with ${MUSCRIPTOR_CPU_FLAGS}. The x86_64 build targets Ivy Bridge, the "
            "oldest CPU in a Mac that boots macOS 11, and AVX2, BMI2 and FMA all fault there.")
    endif()
endif()

# On ARM with fp16 vector arithmetic, ggml's F16 matmul kernels sum in fp16
# (GGML_F16_VEC is float16x8_t); the CPU test tolerances assume fp32 sums.
# Undefining the feature macro selects the fp32 fallbacks. Under
# MUSCRIPTOR_NATIVE the -U has to land after ggml's -mcpu=native+fp16;
# ggml_cpu_has_fp16_va() returns 0 when it took.
option(MUSCRIPTOR_GGML_FP32_ACCUM "Accumulate F16 matmuls in fp32 on ARM" ON)
if(MUSCRIPTOR_GGML_FP32_ACCUM AND TARGET ggml-cpu)
    target_compile_options(ggml-cpu PRIVATE -U__ARM_FEATURE_FP16_VECTOR_ARITHMETIC)
endif()

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ggml_metal.cmake)

# ggml finds default.metallib through the bundle of an Objective-C class, and
# class names are process-wide: another ggml in the same host (a second plugin)
# could win the name and point the lookup at its own bundle.
if(MUSCRIPTOR_METAL_PRECOMPILED)
    target_compile_definitions(ggml-metal PRIVATE GGMLMetalClass=MuscriptorGGMLMetalClass)

    set(MUSCRIPTOR_GGML_METAL_DIR ${ggml_SOURCE_DIR}/src/ggml-metal)
    get_directory_property(MUSCRIPTOR_METAL_LIBRARY_DIR
        DIRECTORY ${MUSCRIPTOR_GGML_METAL_DIR} DEFINITION CMAKE_RUNTIME_OUTPUT_DIRECTORY)
    get_directory_property(MUSCRIPTOR_METAL_HAS_TENSOR_LIBRARY
        DIRECTORY ${MUSCRIPTOR_GGML_METAL_DIR} DEFINITION GGML_METAL_HAS_TENSOR_LIB)

    set(MUSCRIPTOR_METAL_LIBRARIES ${MUSCRIPTOR_METAL_LIBRARY_DIR}/default.metallib)

    # The tensor API kernels, used on M5-class GPUs only. ggml builds them with
    # the macOS 26 SDK or later; without them it runs its other kernels.
    if(MUSCRIPTOR_METAL_HAS_TENSOR_LIBRARY)
        list(APPEND MUSCRIPTOR_METAL_LIBRARIES ${MUSCRIPTOR_METAL_LIBRARY_DIR}/ggml-tensor.metallib)
    else()
        message(WARNING
            "The Metal SDK is older than 26, so ggml-tensor.metallib is not built and M5-class GPUs "
            "will not use the tensor API.")
    endif()

    set_property(GLOBAL PROPERTY MUSCRIPTOR_METAL_LIBRARIES ${MUSCRIPTOR_METAL_LIBRARIES})
endif()

# --- pffft --------------------------------------------------------------
#
# The STFT's real-to-complex transform, since ggml has no FFT op. Its own target
# because the vendored C does not build clean under the library's warning flags.
add_library(pffft STATIC third_party/pffft/pffft.c)
target_include_directories(pffft PUBLIC third_party/pffft)
target_compile_options(pffft PRIVATE -w)
# PIC, so the archive can be linked into a shared object on ELF targets.
set_target_properties(pffft PROPERTIES POSITION_INDEPENDENT_CODE ON)

# --- library ------------------------------------------------------------
#
# STATIC explicitly, so a consumer's BUILD_SHARED_LIBS does not make it shared.

add_library(muscriptor_ggml STATIC
    src/device.cpp
    src/error.cpp
    src/gguf_file.cpp
    src/instrument_groups.cpp
    src/log.cpp
    src/note_assembler.cpp
    src/open_note_tracker.cpp
    src/resume_point.cpp
    src/trace.cpp
    src/transcriber.cpp
    src/model.cpp
    src/stft.cpp
    src/vocabulary.cpp
)
target_include_directories(muscriptor_ggml
    PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(muscriptor_ggml PUBLIC ggml PRIVATE pffft)
# clang-cl reads the MSVC spellings first, and there /Wall means -Weverything.
if(MSVC)
    target_compile_options(muscriptor_ggml PRIVATE /W4)
else()
    target_compile_options(muscriptor_ggml PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(MUSCRIPTOR_METAL)
    target_compile_definitions(muscriptor_ggml PRIVATE MUSCRIPTOR_HAS_METAL)
endif()

if(MUSCRIPTOR_VULKAN)
    target_compile_definitions(muscriptor_ggml PRIVATE MUSCRIPTOR_HAS_VULKAN)

    if(MSVC AND CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
        target_compile_definitions(muscriptor_ggml INTERFACE _ITERATOR_DEBUG_LEVEL=0)
    endif()

    # Delay-load vulkan-1.dll so a binary still loads on a machine without Vulkan;
    # device.cpp checks for the DLL before its first Vulkan call. INTERFACE so
    # the flags reach the consuming executable. MinGW has no delay-load.
    if(WIN32 AND NOT MINGW)
        target_link_libraries(muscriptor_ggml INTERFACE delayimp)

        # CMAKE_CXX_COMPILER_FRONTEND_VARIANT is only set for cl.exe from
        # CMake 3.26; MSVC covers it (and clang-cl) on the 3.24 minimum.
        if(MSVC OR CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
            target_link_options(muscriptor_ggml INTERFACE /DELAYLOAD:vulkan-1.dll)
        else()
            target_link_options(muscriptor_ggml INTERFACE -Wl,/DELAYLOAD:vulkan-1.dll)
        endif()
    endif()
endif()

set_target_properties(muscriptor_ggml PROPERTIES POSITION_INDEPENDENT_CODE ON)

# The public headers need C++23 (std::expected); CMAKE_CXX_STANDARD alone does
# not reach a consumer's targets.
target_compile_features(muscriptor_ggml PUBLIC cxx_std_23)

# --- tests --------------------------------------------------------------
#
# Off for a nested build, and when BUILD_TESTING is OFF.

if(DEFINED BUILD_TESTING AND NOT BUILD_TESTING)
    set(MUSCRIPTOR_BUILD_TESTS_DEFAULT OFF)
else()
    set(MUSCRIPTOR_BUILD_TESTS_DEFAULT ${PROJECT_IS_TOP_LEVEL})
endif()

option(MUSCRIPTOR_BUILD_TESTS "Build the muscriptor.cpp test suite" ${MUSCRIPTOR_BUILD_TESTS_DEFAULT})
option(MUSCRIPTOR_BUILD_BENCH "Build the muscriptor.cpp benchmark" ${PROJECT_IS_TOP_LEVEL})

# Defaults for the --size, --device and --weight-dtype options of the tests and
# the bench (docs/TESTING.md). Size and device may be `all` for the tests.
if(MUSCRIPTOR_BUILD_TESTS OR MUSCRIPTOR_BUILD_BENCH)
    set(MUSCRIPTOR_TEST_SIZE         medium CACHE STRING "Default --size for the tests and bench: all|small|medium|large")
    set(MUSCRIPTOR_TEST_DEVICE       gpu    CACHE STRING "Default --device for the tests and bench: all|cpu|gpu")
    set(MUSCRIPTOR_TEST_WEIGHT_DTYPE f16    CACHE STRING "Default --weight-dtype for the tests and bench: f16|f32")
    set_property(CACHE MUSCRIPTOR_TEST_SIZE         PROPERTY STRINGS all small medium large)
    set_property(CACHE MUSCRIPTOR_TEST_DEVICE       PROPERTY STRINGS all cpu gpu)
    set_property(CACHE MUSCRIPTOR_TEST_WEIGHT_DTYPE PROPERTY STRINGS f16 f32)

    foreach(MUSCRIPTOR_TEST_VAR MUSCRIPTOR_TEST_SIZE MUSCRIPTOR_TEST_DEVICE MUSCRIPTOR_TEST_WEIGHT_DTYPE)
        get_property(MUSCRIPTOR_TEST_ALLOWED CACHE ${MUSCRIPTOR_TEST_VAR} PROPERTY STRINGS)

        if(NOT ${MUSCRIPTOR_TEST_VAR} IN_LIST MUSCRIPTOR_TEST_ALLOWED)
            message(FATAL_ERROR "${MUSCRIPTOR_TEST_VAR}=${${MUSCRIPTOR_TEST_VAR}}; must be one of: ${MUSCRIPTOR_TEST_ALLOWED}")
        endif()
    endforeach()
endif()

if(MUSCRIPTOR_BUILD_TESTS)
    add_subdirectory(tests)
endif()

# --- bench --------------------------------------------------------------
#
# Needs only the weights and the audio fixture, no reference dump.

if(MUSCRIPTOR_BUILD_BENCH)
    add_subdirectory(bench)
endif()
