#include "log.hpp"

#include <ggml.h>

#include <mutex>
#include <utility>

namespace msl
{

namespace
{

    LogCallback gCallback;
    LogLevel gMaxLevel = LogLevel::Warn;
    std::once_flag gInstalled;

    LogLevel translate(ggml_log_level inLevel)
    {
        switch (inLevel) {
            case GGML_LOG_LEVEL_NONE:
                return LogLevel::Info;
            case GGML_LOG_LEVEL_DEBUG:
                return LogLevel::Debug;
            case GGML_LOG_LEVEL_INFO:
                return LogLevel::Info;
            case GGML_LOG_LEVEL_WARN:
                return LogLevel::Warn;
            case GGML_LOG_LEVEL_ERROR:
                return LogLevel::Error;
            // Resolved by `forward` to the level of the message it continues.
            case GGML_LOG_LEVEL_CONT:
                return LogLevel::Info;
        }

        return LogLevel::Info;
    }

    void forward(ggml_log_level inLevel, const char* inText, void*)
    {
        if (!gCallback) {
            return;
        }

        // Per thread: ggml may log from its worker threads.
        thread_local LogLevel tLastLevel = LogLevel::Info;

        const LogLevel level = inLevel == GGML_LOG_LEVEL_CONT ? tLastLevel : translate(inLevel);
        tLastLevel = level;

        if (level > gMaxLevel) {
            return;
        }

        gCallback(level, inText);
    }

} // namespace

void setLogCallback(LogCallback inCallback, LogLevel inMaxLevel)
{
    gCallback = std::move(inCallback);
    gMaxLevel = inMaxLevel;

    installLogHook();
}

void installLogHook()
{
    // ggml_log_set writes a global with no synchronization of its own, and
    // two threads may load a model at the same time.
    std::call_once(gInstalled, [] { ggml_log_set(forward, nullptr); });
}

} // namespace msl
