#pragma once

#include <functional>
#include <string_view>

namespace msl
{

/** Ordered most severe first, so a threshold compares as `<=`. */
enum class LogLevel {
    Off,
    Error,
    Warn,
    Info,
    Debug,
};

/**
 * @param inLevel Severity of this message.
 * @param inText One log line, newline included. Valid only for the duration of
 *        the call.
 */
using LogCallback = std::function<void(LogLevel inLevel, std::string_view inText)>;

/**
 * Install the sink ggml's log messages are written to. The library emits none
 * of its own, and the default is silence.
 *
 * Process-global, like ggml's log hook: the last call wins for every instance.
 * Not synchronised; call it before loading a model. ggml's Vulkan backend
 * writes some errors and warnings straight to `std::cerr`, bypassing it.
 *
 * @param inCallback Where messages go. Empty restores silence.
 * @param inMaxLevel How far down to report. Anything less severe than this is
 *        dropped before the callback sees it, so `Warn` passes warnings and
 *        errors, and `Debug` passes everything.
 */
void setLogCallback(LogCallback inCallback, LogLevel inMaxLevel = LogLevel::Warn);

} // namespace msl
