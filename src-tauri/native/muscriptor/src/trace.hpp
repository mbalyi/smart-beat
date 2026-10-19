#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

struct ggml_tensor;

namespace msl
{

/**
 * Captures named intermediate tensors from a compute graph.
 *
 * The port is debugged by bisection against the PyTorch dumps, so every
 * stage with a reference counterpart must be readable after the graph runs.
 * Marking a tensor via `capture` names it, flags it as a graph output (so the
 * graph allocator will not recycle its memory) and remembers it for readback.
 *
 * Capture happens in two phases because a graph's tensor metadata lives in a
 * scratch ggml_context that is destroyed as soon as the evaluation returns:
 * `capture` records the tensor while the graph is being built, and
 * `materialize` copies the values into host memory afterwards. Reading a
 * trace before it is materialised is a programming error and throws rather
 * than dereferencing a dangling tensor.
 *
 * A null Trace* is the production path: nothing is marked, nothing is kept
 * alive, and the allocator is free to reuse every intermediate.
 */
class Trace
{
public:
    /**
     * Mark `inTensor` for readback under `inName`.
     *
     * @param inName Name the tensor will be readable under after `materialize`.
     * @param inTensor Tensor to capture.
     * @return `inTensor`, so the call can be dropped into an expression
     *         without breaking the chain.
     */
    ggml_tensor* capture(const std::string& inName, ggml_tensor* inTensor);

    /**
     * Copy every captured tensor out of the backend. Called by the model
     * once the graph has run and before the scratch context goes away.
     */
    void materialize();

    /** @return Contents of a captured tensor as float32, in GGUF/row-major order. */
    const std::vector<float>& read(const std::string& inName) const;

    /** @return ggml shape (ne) of a captured tensor, trailing 1s trimmed. */
    const std::vector<std::int64_t>& shape(const std::string& inName) const;

    bool contains(const std::string& inName) const { return mEntries.count(inName) > 0; }

private:
    struct Entry {
        // Non-null only between `capture` and `materialize`.
        ggml_tensor* tensor = nullptr;
        std::vector<float> data;
        std::vector<std::int64_t> ne;
        bool materialized = false;
    };

    const Entry& _lookup(const std::string& inName) const;

    std::map<std::string, Entry> mEntries;
};

/** Convenience for the common `trace ? trace->capture(name, t) : t` pattern. */
ggml_tensor* capture(Trace* inTrace, const std::string& inName, ggml_tensor* inTensor);

} // namespace msl
