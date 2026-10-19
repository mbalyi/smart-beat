#pragma once

#include <stdexcept>
#include <string>

namespace msl
{

/** What can go wrong between loading a checkpoint and returning notes. */
enum class Error {
    FileNotFound,
    // Not a GGUF, or a GGUF missing tensors or metadata this architecture needs.
    InvalidCheckpoint,
    UnsupportedArch,
    // A muscriptor GGUF whose `muscriptor.format_version` this build does not read.
    UnsupportedCheckpointVersion,
    OutOfMemory,
    // The device `LoadOptions::device` names does not exist or failed to
    // initialise.
    DeviceUnavailable,
    // A chunk's conditioning prefix plus its teacher-forced prologue does not
    // fit in the KV cache. Generation itself is clamped rather than overflowing.
    ContextOverflow,
    // A `should_cancel` predicate returned true, or a `NoteCallback` returned
    // false.
    Cancelled,
    // Something in `TranscribeOptions` is not usable, e.g. an instrument that is
    // not one of the named groups.
    InvalidArgument,
    // A bug in the library, not a problem with the input.
    Internal,
    // `TranscribeOptions::resume_from` is malformed, or was made for another
    // signal, instrument selection or prelude setting.
    InvalidResumePoint,
};

/** @return A short, stable description of `inError`, for logs. */
const char* describe(Error inError);

/**
 * Carries an `Error` through the library's internals, which throw.
 * `Transcriber` catches it and returns the `Error` as a value.
 */
class Exception : public std::runtime_error
{
public:
    Exception(Error inError, const std::string& inMessage);

    Error error() const { return mError; }

private:
    Error mError;
};

} // namespace msl
