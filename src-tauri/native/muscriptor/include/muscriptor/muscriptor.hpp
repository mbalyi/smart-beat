#pragma once

/**
 * @file
 * The public surface of muscriptor.cpp for transcription. `model.hpp` is the
 * layer below it (docs/API.md).
 *
 * 16 kHz mono float32 in, note events out:
 *
 *     auto transcriber = msl::Transcriber::load("muscriptor-medium-f16.gguf");
 *
 *     if (!transcriber) {
 *         return report(msl::describe(transcriber.error()));
 *     }
 *
 *     const auto notes = transcriber->transcribe(samples);
 *
 * Requires C++23. Decoding audio files, resampling to 16 kHz and writing MIDI
 * are the caller's -- docs/API.md explains why the seam sits there.
 *
 * Nothing is written to stdout or stderr unless the host asks for it with
 * `setLogCallback` -- log.hpp.
 */

#include "muscriptor/device.hpp"
#include "muscriptor/error.hpp"
#include "muscriptor/log.hpp"
#include "muscriptor/note.hpp"
#include "muscriptor/transcriber.hpp"
