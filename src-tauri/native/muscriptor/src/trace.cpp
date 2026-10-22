#include "trace.hpp"

#include "format.hpp"
#include "gguf_file.hpp"

#include <ggml.h>

#include <stdexcept>

namespace msl
{

ggml_tensor* Trace::capture(const std::string& inName, ggml_tensor* inTensor)
{
    ggml_set_name(inTensor, inName.c_str());
    // Without this the graph allocator is free to hand this tensor's memory to
    // a later node, and the readback after compute would return garbage.
    ggml_set_output(inTensor);

    Entry entry;
    entry.tensor = inTensor;
    entry.materialized = false;
    mEntries[inName] = std::move(entry);
    return inTensor;
}

void Trace::materialize()
{
    for (auto& [name, entry]: mEntries) {
        if (entry.materialized) {
            continue;
        }

        entry.data = tensorToFloat(entry.tensor);
        entry.ne.assign(entry.tensor->ne, entry.tensor->ne + GGML_MAX_DIMS);

        while (entry.ne.size() > 1 && entry.ne.back() == 1) {
            entry.ne.pop_back();
        }

        // The tensor lives in a scratch context that is about to be freed;
        // dropping the pointer turns a later misuse into a clear error instead
        // of a read through dangling memory.
        entry.tensor = nullptr;
        entry.materialized = true;
    }
}

const Trace::Entry& Trace::_lookup(const std::string& inName) const
{
    const auto it = mEntries.find(inName);

    if (it == mEntries.end()) {
        throw std::runtime_error(msl::format("trace has no tensor named '{}'", inName));
    }

    if (!it->second.materialized) {
        throw std::runtime_error(
            msl::format("trace entry '{}' was never materialised; the graph must run first", inName));
    }

    return it->second;
}

const std::vector<float>& Trace::read(const std::string& inName) const
{
    return _lookup(inName).data;
}

const std::vector<std::int64_t>& Trace::shape(const std::string& inName) const
{
    return _lookup(inName).ne;
}

ggml_tensor* capture(Trace* inTrace, const std::string& inName, ggml_tensor* inTensor)
{
    return inTrace != nullptr ? inTrace->capture(inName, inTensor) : inTensor;
}

} // namespace msl
