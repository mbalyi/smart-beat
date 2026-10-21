// C interface to muscriptor.cpp for Rust (src/recording/muscriptor_ffi.rs). Exceptions never
// cross it: every failure comes back as a message.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "muscriptor/muscriptor.hpp"

extern "C" {

struct sb_note {
    double onset;
    double offset;
    int pitch;
    int program;
    int is_drum;
};

struct sb_ms {
    msl::Transcriber transcriber;
};

typedef void (*sb_progress_fn)(float fraction, void* user);
typedef int (*sb_cancel_fn)(void* user);

static void put(char* err, size_t len, const std::string& text) {
    if (err == nullptr || len == 0) return;
    std::snprintf(err, len, "%s", text.c_str());
}

int sb_ms_load(const char* path, sb_ms** out, sb_cancel_fn cancel, void* user, char* err, size_t err_len) {
    try {
        msl::LoadOptions options;
        // A diagnostic override for the benchmark (examples/muscriptor_bench.rs): run on the CPU
        // although a GPU is available. Unset, the engine picks the best device itself.
        if (const char* wanted = std::getenv("SMART_BEAT_MUSCRIPTOR_DEVICE");
            wanted != nullptr && std::string(wanted) == "cpu") {
            options.device = msl::availableDevices().size() - 1;
        }
        if (cancel != nullptr) options.should_cancel = [=] { return cancel(user) != 0; };
        auto loaded = msl::Transcriber::load(path, std::move(options));
        if (!loaded) {
            put(err, err_len, msl::describe(loaded.error()));
            return static_cast<int>(loaded.error()) + 1;
        }
        *out = new sb_ms{std::move(*loaded)};
        return 0;
    } catch (const std::exception& e) {
        put(err, err_len, e.what());
        return -1;
    }
}

void sb_ms_free(sb_ms* model) { delete model; }

const char* sb_ms_device(const sb_ms* model) {
    static thread_local std::string name;
    name = model->transcriber.device().name;
    return name.c_str();
}

// 0 = ok, 8 = cancelled (msl::Error::Cancelled + 1).
int sb_ms_transcribe(sb_ms* model, const float* samples, size_t count, const int* groups,
                     size_t group_count, sb_progress_fn progress, sb_cancel_fn cancel, void* user,
                     sb_note** notes_out, size_t* notes_len, char* err, size_t err_len) {
    try {
        msl::TranscribeOptions options;
        for (size_t i = 0; i < group_count; ++i) {
            options.instruments.push_back(static_cast<msl::InstrumentGroup>(groups[i]));
        }
        if (cancel != nullptr) options.should_cancel = [=] { return cancel(user) != 0; };
        msl::NoteCallback callback;
        if (progress != nullptr) {
            callback = [=](const msl::TranscriptionUpdate& update) {
                progress(update.progress, user);
                return true;
            };
        }
        auto result = model->transcriber.transcribe(std::span<const float>(samples, count), options, callback);
        if (!result) {
            put(err, err_len, msl::describe(result.error()));
            return static_cast<int>(result.error()) + 1;
        }
        auto* array = new sb_note[result->size() == 0 ? 1 : result->size()];
        for (size_t i = 0; i < result->size(); ++i) {
            const auto& n = (*result)[i];
            array[i] = {n.onset, n.offset, n.pitch, n.program, n.is_drum ? 1 : 0};
        }
        *notes_out = array;
        *notes_len = result->size();
        return 0;
    } catch (const std::exception& e) {
        put(err, err_len, e.what());
        return -1;
    }
}

void sb_ms_free_notes(sb_note* notes) { delete[] notes; }

}  // extern "C"
