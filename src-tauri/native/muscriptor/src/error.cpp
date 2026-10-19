#include "muscriptor/error.hpp"

namespace msl
{

const char* describe(Error inError)
{
    switch (inError) {
        case Error::FileNotFound:
            return "checkpoint file not found";
        case Error::InvalidCheckpoint:
            return "not a valid muscriptor GGUF checkpoint";
        case Error::UnsupportedArch:
            return "checkpoint architecture is not supported";
        case Error::UnsupportedCheckpointVersion:
            return "checkpoint format version is not the one this build reads";
        case Error::OutOfMemory:
            return "out of memory";
        case Error::DeviceUnavailable:
            return "the selected compute device is not available";
        case Error::ContextOverflow:
            return "a chunk did not fit in the model context";
        case Error::Cancelled:
            return "cancelled by the caller";
        case Error::InvalidArgument:
            return "invalid transcribe options";
        case Error::Internal:
            return "internal error";
        case Error::InvalidResumePoint:
            return "the resume point does not match this transcription";
    }

    return "unknown error";
}

Exception::Exception(Error inError, const std::string& inMessage)
    : std::runtime_error(inMessage)
    , mError(inError)
{
}

} // namespace msl
