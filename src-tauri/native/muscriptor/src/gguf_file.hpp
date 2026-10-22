#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

struct ggml_context;
struct ggml_tensor;
struct gguf_context;
typedef struct ggml_backend_buffer* ggml_backend_buffer_t;
typedef struct ggml_backend* ggml_backend_t;

namespace msl
{

/**
 * A GGUF file loaded into a backend buffer, keeping its metadata queryable.
 *
 * Used for both the converted weights and the reference dumps: the C++ side
 * therefore needs exactly one file parser, and reference floats reach the
 * tests as the same bits Python wrote.
 */
class GgufFile
{
public:
    /**
     * Called with the tensor bytes uploaded so far and their total: once before
     * the first tensor, then after each one. It may throw to abandon the load.
     */
    using UploadObserver = std::function<void(std::size_t inBytesDone, std::size_t inBytesTotal)>;

    GgufFile(const std::filesystem::path& inPath, ggml_backend_t inBackend, const UploadObserver& inObserver = {});
    ~GgufFile();

    GgufFile(GgufFile&&) = delete;
    GgufFile& operator=(GgufFile&&) = delete;
    GgufFile(const GgufFile&) = delete;
    GgufFile& operator=(const GgufFile&) = delete;

    /**
     * Look up a tensor by name.
     *
     * @param inName Tensor name to look up.
     * @return The tensor. Throws with the file name and the missing key if
     *         `inName` is absent.
     */
    ggml_tensor* get(const std::string& inName) const;

    /**
     * Look up a tensor by name, for callers that need to probe for optional
     * tensors.
     *
     * @param inName Tensor name to look up.
     * @return The tensor, or nullptr if `inName` is absent.
     */
    ggml_tensor* find(const std::string& inName) const;

    /**
     * @param inKey Metadata key to look up.
     * @return The key's value as an int32.
     *
     * Throws if the key is absent or holds another type, so a stale GGUF
     * fails loudly at load rather than silently defaulting.
     */
    std::int32_t i32(const std::string& inKey) const;

    /** @see i32 */
    float f32(const std::string& inKey) const;

    /** @return Whether metadata key `inKey` is present. */
    bool has(const std::string& inKey) const;

private:
    void _release() noexcept;

    std::filesystem::path mPath;
    ggml_context* mCtx = nullptr;
    gguf_context* mGguf = nullptr;
    ggml_backend_buffer_t mBuffer = nullptr;
};

/**
 * Read any tensor's contents as float32, converting from F16 if needed, in the
 * layout GGUF stores it (row-major, last ggml axis fastest).
 *
 * @param inTensor Tensor to read.
 * @return The tensor's contents as float32.
 */
std::vector<float> tensorToFloat(const ggml_tensor* inTensor);

} // namespace msl
