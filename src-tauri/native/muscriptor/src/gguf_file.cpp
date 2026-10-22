#include "gguf_file.hpp"
#include "muscriptor/error.hpp"

#include "format.hpp"

#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>

#include <filesystem>
#include <fstream>
#include <string>

namespace msl
{

namespace
{

    /**
     * Read a tensor's raw bytes out of the file at `inOffset` and upload them
     * into the backend buffer.
     *
     * The gguf context is opened with no_alloc=true, so tensors live in a
     * backend buffer and every backend shares this path.
     *
     * @param inFile Open stream to read the tensor's bytes from.
     * @param inOffset Byte offset of the tensor's data within the file.
     * @param inTensor Tensor to upload the bytes into.
     */
    void uploadTensorData(std::istream& inFile, std::size_t inOffset, ggml_tensor* inTensor)
    {
        std::vector<std::uint8_t> staging(ggml_nbytes(inTensor));

        // streamoff is 64-bit everywhere; a checkpoint can exceed 2 GiB.
        if (!inFile.seekg(static_cast<std::streamoff>(inOffset), std::ios::beg)) {
            throw Exception(Error::InvalidCheckpoint,
                            msl::format("seek failed for tensor '{}'", ggml_get_name(inTensor)));
        }

        if (!inFile.read(reinterpret_cast<char*>(staging.data()), static_cast<std::streamsize>(staging.size()))) {
            throw Exception(Error::InvalidCheckpoint,
                            msl::format("short read for tensor '{}'", ggml_get_name(inTensor)));
        }

        ggml_backend_tensor_set(inTensor, staging.data(), 0, staging.size());
    }

} // namespace

GgufFile::GgufFile(const std::filesystem::path& inPath, ggml_backend_t inBackend, const UploadObserver& inObserver)
    : mPath(inPath)
{
    // Existence is checked separately because gguf_init_from_file answers null
    // both for a file it cannot open and for one that is not a GGUF, and a
    // caller showing the user why the checkpoint was rejected needs to tell
    // "wrong path" from "wrong file".
    std::error_code ec;

    if (!std::filesystem::is_regular_file(inPath, ec)) {
        throw Exception(Error::FileNotFound, msl::format("checkpoint not found: {}", utf8(inPath)));
    }

    gguf_init_params params {};
    params.no_alloc = true;
    params.ctx = &mCtx;

    mGguf = gguf_init_from_file(utf8(inPath).c_str(), params);

    if (mGguf == nullptr) {
        throw Exception(Error::InvalidCheckpoint, msl::format("not a readable GGUF file: {}", utf8(inPath)));
    }

    // A throwing constructor never runs the destructor, so free what is held.
    try {
        mBuffer = ggml_backend_alloc_ctx_tensors(mCtx, inBackend);

        if (mBuffer == nullptr) {
            throw Exception(Error::OutOfMemory, msl::format("failed to allocate tensors for: {}", utf8(inPath)));
        }

        std::ifstream file(inPath, std::ios::binary);

        if (!file) {
            throw Exception(Error::FileNotFound, msl::format("failed to reopen GGUF file: {}", utf8(inPath)));
        }

        const std::int64_t n_tensors = gguf_get_n_tensors(mGguf);
        std::size_t bytes_total = 0;

        for (std::int64_t i = 0; i < n_tensors; ++i) {
            bytes_total += ggml_nbytes(ggml_get_tensor(mCtx, gguf_get_tensor_name(mGguf, i)));
        }

        std::size_t bytes_done = 0;

        if (inObserver) {
            inObserver(bytes_done, bytes_total);
        }

        for (std::int64_t i = 0; i < n_tensors; ++i) {
            const char* name = gguf_get_tensor_name(mGguf, i);
            ggml_tensor* tensor = ggml_get_tensor(mCtx, name);
            const std::size_t offset = gguf_get_data_offset(mGguf) + gguf_get_tensor_offset(mGguf, i);
            uploadTensorData(file, offset, tensor);

            bytes_done += ggml_nbytes(tensor);

            if (inObserver) {
                inObserver(bytes_done, bytes_total);
            }
        }
    } catch (...) {
        _release();
        throw;
    }
}

GgufFile::~GgufFile()
{
    _release();
}

void GgufFile::_release() noexcept
{
    if (mBuffer != nullptr) {
        ggml_backend_buffer_free(mBuffer);
        mBuffer = nullptr;
    }

    if (mGguf != nullptr) {
        gguf_free(mGguf);
        mGguf = nullptr;
    }

    if (mCtx != nullptr) {
        ggml_free(mCtx);
        mCtx = nullptr;
    }
}

ggml_tensor* GgufFile::find(const std::string& inName) const
{
    return ggml_get_tensor(mCtx, inName.c_str());
}

ggml_tensor* GgufFile::get(const std::string& inName) const
{
    ggml_tensor* tensor = find(inName);

    if (tensor == nullptr) {
        throw Exception(Error::InvalidCheckpoint,
                        msl::format("tensor '{}' not found in {}", inName, utf8(mPath.filename())));
    }

    return tensor;
}

bool GgufFile::has(const std::string& inKey) const
{
    return gguf_find_key(mGguf, inKey.c_str()) >= 0;
}

namespace
{

    std::int64_t requireKey(gguf_context* inGguf, const std::string& inKey, const std::filesystem::path& inPath)
    {
        const std::int64_t id = gguf_find_key(inGguf, inKey.c_str());

        if (id < 0) {
            throw Exception(Error::InvalidCheckpoint,
                            msl::format("metadata key '{}' not found in {}", inKey, utf8(inPath.filename())));
        }

        return id;
    }

} // namespace

std::int32_t GgufFile::i32(const std::string& inKey) const
{
    return gguf_get_val_i32(mGguf, requireKey(mGguf, inKey, mPath));
}

float GgufFile::f32(const std::string& inKey) const
{
    return gguf_get_val_f32(mGguf, requireKey(mGguf, inKey, mPath));
}

std::vector<float> tensorToFloat(const ggml_tensor* inTensor)
{
    const std::size_t count = static_cast<std::size_t>(ggml_nelements(inTensor));
    std::vector<float> out(count);

    if (inTensor->type == GGML_TYPE_F32) {
        ggml_backend_tensor_get(inTensor, out.data(), 0, count * sizeof(float));
        return out;
    }

    if (inTensor->type == GGML_TYPE_F16) {
        std::vector<ggml_fp16_t> staging(count);
        ggml_backend_tensor_get(inTensor, staging.data(), 0, count * sizeof(ggml_fp16_t));
        ggml_fp16_to_fp32_row(staging.data(), out.data(), static_cast<std::int64_t>(count));
        return out;
    }

    throw Exception(Error::InvalidCheckpoint,
                    msl::format("tensor '{}' has unsupported type {} for float readback",
                                ggml_get_name(inTensor),
                                ggml_type_name(inTensor->type)));
}

} // namespace msl
