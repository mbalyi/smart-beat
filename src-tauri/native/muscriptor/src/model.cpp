#include "muscriptor/model.hpp"
#include "muscriptor/error.hpp"

#include "device_backend.hpp"
#include "format.hpp"
#include "gguf_file.hpp"
#include "instrument_groups.hpp"
#include "muscriptor/stft.hpp"
#include "muscriptor/transcriber.hpp"
#include "trace.hpp"

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <span>
#include <string>
#include <thread>
#include <utility>

#if defined(__APPLE__)
#include <sys/sysctl.h>
#endif

namespace msl
{

namespace
{

    constexpr const char* ARCH = "muscriptor";

    std::string key(const std::string& suffix)
    {
        return std::string(ARCH) + "." + suffix;
    }

    /**
     * Default thread count: performance cores only, where the platform can say
     * which those are.
     *
     * ggml joins all threads on a barrier at every node, so an efficiency core
     * holds back every op.
     *
     * @return Threads to use when the caller did not choose.
     */
    int defaultThreadCount()
    {
        const int logical = static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));

#if defined(__APPLE__)
        // perflevel0 is the fastest tier; on a Mac with uniform cores the key
        // is absent and the fallback below is already right.
        int performance = 0;
        std::size_t size = sizeof(performance);

        if (sysctlbyname("hw.perflevel0.logicalcpu", &performance, &size, nullptr, 0) == 0 && performance > 0) {
            return std::min(performance, logical);
        }
#endif

        return logical;
    }

    /** Throws `Error::Cancelled` if `inShouldCancel` is set and says so. */
    void throwIfCancelled(const std::function<bool()>& inShouldCancel)
    {
        if (inShouldCancel && inShouldCancel()) {
            throw Exception(Error::Cancelled, "cancelled");
        }
    }

    /**
     * @return `ggml_mul_mat` marked GGML_PREC_F32, so ggml-vulkan's F16
     *         matrix-matrix kernels accumulate in fp32; other backends ignore
     *         the mark.
     */
    ggml_tensor* mulMat(ggml_context* inCtx, ggml_tensor* inA, ggml_tensor* inB)
    {
        ggml_tensor* out = ggml_mul_mat(inCtx, inA, inB);
        ggml_mul_mat_set_prec(out, GGML_PREC_F32);
        return out;
    }

    /**
     * Upper bound on graph nodes for a model of `inNLayer` layers.
     *
     * Both graph shapes are linear in the layer count and independent of the
     * number of tokens or frames: at 24 layers a decode step is 727 nodes and a
     * prefill 732. This leaves a factor of two of margin. It also sizes the
     * graph metadata buffer, rebuilt every decode step. Overrunning it is a
     * GGML_ASSERT abort; test_backend.cpp checks the headroom.
     *
     * @param inNLayer Transformer layers in the model.
     * @return Node capacity to build the graph with.
     */
    std::size_t graphNodeBound(int inNLayer)
    {
        return static_cast<std::size_t>(inNLayer) * 64 + 256;
    }

    struct LayerWeights {
        ggml_tensor* attn_norm_w = nullptr;
        ggml_tensor* attn_norm_b = nullptr;
        ggml_tensor* attn_qkv = nullptr;
        ggml_tensor* attn_out = nullptr;
        ggml_tensor* ffn_norm_w = nullptr;
        ggml_tensor* ffn_norm_b = nullptr;
        ggml_tensor* ffn_up = nullptr;
        ggml_tensor* ffn_down = nullptr;
    };

    struct Weights {
        ggml_tensor* token_embd = nullptr;
        ggml_tensor* output = nullptr;
        ggml_tensor* output_norm_w = nullptr;
        ggml_tensor* output_norm_b = nullptr;
        ggml_tensor* mel_fb = nullptr;
        ggml_tensor* stft_window = nullptr;
        ggml_tensor* proj_w = nullptr;
        ggml_tensor* proj_b = nullptr;
        ggml_tensor* instrument_group = nullptr;
        ggml_tensor* dataset_name = nullptr;

        std::vector<LayerWeights> layers;
    };

    /** @return Bytes of metadata a graph of `inMaxNodes` nodes needs. */
    std::size_t graphBufferSize(std::size_t inMaxNodes)
    {
        return ggml_tensor_overhead() * inMaxNodes + ggml_graph_overhead_custom(inMaxNodes, false);
    }

    /**
     * Scratch context and graph for one evaluation. Holds tensor metadata
     * only; the graph allocator places the actual data afterwards.
     *
     * The buffer belongs to the Model and is reused across evaluations rather
     * than allocated per call -- which is also why an evaluation is not
     * re-entrant, matching what the public API already promises.
     */
    struct GraphScratch {
        ggml_context* ctx = nullptr;
        ggml_cgraph* gf = nullptr;

        GraphScratch(std::span<std::uint8_t> inBuffer, std::size_t inMaxNodes)
        {
            ggml_init_params params {};
            params.mem_size = inBuffer.size();
            params.mem_buffer = inBuffer.data();
            params.no_alloc = true;
            ctx = ggml_init(params);
            gf = ggml_new_graph_custom(ctx, inMaxNodes, false);
        }

        ~GraphScratch()
        {
            if (ctx != nullptr) {
                ggml_free(ctx);
            }
        }

        GraphScratch(const GraphScratch&) = delete;
        GraphScratch& operator=(const GraphScratch&) = delete;
    };

    /**
     * LayerNorm with affine parameters: ggml_norm does the mean/variance
     * part, the scale and shift are separate ops broadcasting over the
     * token axis.
     *
     * @param inCtx Graph context to build the ops in.
     * @param inX Input tensor.
     * @param inWeight Affine scale.
     * @param inBias Affine shift.
     * @param inEps Epsilon added to the variance.
     * @return The normalised tensor.
     */
    ggml_tensor*
        layerNorm(ggml_context* inCtx, ggml_tensor* inX, ggml_tensor* inWeight, ggml_tensor* inBias, float inEps)
    {
        ggml_tensor* cur = ggml_norm(inCtx, inX, inEps);
        cur = ggml_mul(inCtx, cur, inWeight);
        return ggml_add(inCtx, cur, inBias);
    }

    /**
     * create_sin_embedding, evaluated on the host in fp32.
     *
     * Two details here are easy to get wrong and both change every number
     * downstream: the exponent denominator is `half - 1`, not `half`, and
     * the two halves are ordered cosine-then-sine rather than the more
     * common sine-then-cosine. The reference forces fp32 even when the
     * transformer runs in fp16, because fp16 cannot represent odd integers
     * above 2048 and adjacent positions would otherwise collapse onto the
     * same embedding.
     *
     * @param inNCtx Number of positions to build.
     * @param inDim Model dimension; must be even.
     * @param inMaxPeriod Maximum period of the sinusoids.
     * @return The position table, [inNCtx][inDim] row-major.
     */
    std::vector<float> buildPositionTable(int inNCtx, int inDim, float inMaxPeriod)
    {
        if (inDim % 2 != 0) {
            throw Exception(Error::UnsupportedArch, "model dimension must be even for sinusoidal positions");
        }

        const int half = inDim / 2;
        std::vector<float> table(static_cast<std::size_t>(inNCtx) * static_cast<std::size_t>(inDim));

        for (int pos = 0; pos < inNCtx; ++pos) {
            float* row = table.data() + static_cast<std::size_t>(pos) * inDim;

            for (int i = 0; i < half; ++i) {
                const float exponent = static_cast<float>(i) / static_cast<float>(half - 1);
                const float phase = static_cast<float>(pos) / std::pow(inMaxPeriod, exponent);
                row[i] = std::cos(phase);
                row[half + i] = std::sin(phase);
            }
        }

        return table;
    }

} // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

struct Model::Impl {
    Hparams hp;
    Options opts;

    ggml_backend_t backend = nullptr;
    Device device;
    std::unique_ptr<GgufFile> file;
    Weights w;

    // KV cache: K is [dim, n_ctx], V is [n_ctx, head_dim, n_head].
    //
    // K keeps the heads side by side in one row per position: ggml-vulkan's
    // batched matmul needs a packed src0. V is stored transposed, so the
    // attention read is a plain view rather than a per-token copy.
    ggml_context* kv_ctx = nullptr;
    ggml_backend_buffer_t kv_buf = nullptr;
    std::vector<ggml_tensor*> k_cache;
    std::vector<ggml_tensor*> v_cache;

    ggml_gallocr_t alloc = nullptr;

    // The conditioning front-end runs on a CPU backend even when the transformer
    // does not, with CPU copies of the three `cond.*` weights; on the CPU these
    // alias `backend`/`alloc` and the originals. The stage is fp32 in the
    // reference, and ggml's Metal matmul rounds F32 operands to half
    // (`kernel_mul_mm_f32_f32` runs on `simdgroup_half8x8`).
    ggml_backend_t cond_backend = nullptr;
    ggml_gallocr_t cond_alloc = nullptr;
    ggml_context* cond_ctx = nullptr;
    ggml_backend_buffer_t cond_buf = nullptr;
    bool owns_cond_backend = false;
    ggml_tensor* cond_mel_fb = nullptr;
    ggml_tensor* cond_proj_w = nullptr;
    ggml_tensor* cond_proj_b = nullptr;

    // Polled by `generate` and, through `abortRequested`, by the CPU backend.
    // Only the CPU backend gets the abort callback: ggml-metal checks its own
    // only while a GPU capture is running, and ggml-vulkan has none.
    std::function<bool()> should_cancel;

    // Graph metadata scratch, allocated once at load and reused by every
    // evaluation. See GraphScratch.
    std::vector<std::uint8_t> graph_buffer;
    std::size_t max_graph_nodes = 0;
    // Nodes in the graph most recently handed to `execute`. Diagnostic only --
    // it is what lets a test assert the bound above still has margin, since
    // overrunning it aborts inside ggml where nothing can catch it.
    int last_graph_nodes = 0;

    std::vector<float> pos_table;
    std::unique_ptr<Stft> stft;
    int n_past = 0;

    // One prefix row each. A single null-class row is the unconditional path;
    // a selection replaces it with one row per instrument, which is why this
    // changes the prefix length rather than just its contents.
    std::vector<std::int32_t> instrument_rows {InstrumentGroups::NULL_CONDITIONING_ROW};

    // Byte mask over the vocabulary, empty when nothing is forbidden.
    std::vector<std::uint8_t> forbidden_mask;

    struct Allocation {
        ggml_gallocr_t handle = nullptr;
        bool owned = false;
        ~Allocation()
        {
            if (owned && handle != nullptr) {
                ggml_gallocr_free(handle);
            }
        }

        Allocation(const Allocation&) = delete;
        Allocation& operator=(const Allocation&) = delete;
        Allocation(Allocation&& other) noexcept
            : handle(std::exchange(other.handle, nullptr))
            , owned(std::exchange(other.owned, false))
        {
        }

        Allocation& operator=(Allocation&&) = delete;
        Allocation(ggml_gallocr_t h, bool o)
            : handle(h)
            , owned(o)
        {
        }
    };

    /**
     * Allocate `inGf`, using a private allocator when the graph is traced.
     *
     * ggml_gallocr reuses its cached plan for a graph of the same topology,
     * and a traced graph has the same topology (ggml_set_output adds no
     * nodes). That plan recycles intermediates, which would overwrite the
     * captured tensors, so traced graphs get a private allocator.
     *
     * @param inGf Graph to allocate.
     * @param inTraced Whether the graph is being traced.
     * @param inBackend Backend whose buffers the graph is placed in.
     * @param inAlloc Cached allocator for that backend; used when not tracing.
     * @return The allocation, owning a private allocator when `inTraced`.
     */
    Allocation allocateFor(ggml_cgraph* inGf, bool inTraced, ggml_backend_t inBackend, ggml_gallocr_t inAlloc)
    {
        Allocation allocation(inTraced ? ggml_gallocr_new(ggml_backend_get_default_buffer_type(inBackend)) : inAlloc,
                              inTraced);

        if (!ggml_gallocr_alloc_graph(allocation.handle, inGf)) {
            throw Exception(Error::OutOfMemory, "failed to allocate compute graph");
        }

        return allocation;
    }

    ~Impl()
    {
        if (alloc != nullptr) {
            ggml_gallocr_free(alloc);
        }

        if (owns_cond_backend && cond_alloc != nullptr) {
            ggml_gallocr_free(cond_alloc);
        }

        if (cond_buf != nullptr) {
            ggml_backend_buffer_free(cond_buf);
        }

        if (cond_ctx != nullptr) {
            ggml_free(cond_ctx);
        }

        if (kv_buf != nullptr) {
            ggml_backend_buffer_free(kv_buf);
        }

        if (kv_ctx != nullptr) {
            ggml_free(kv_ctx);
        }

        file.reset();

        if (owns_cond_backend && cond_backend != nullptr) {
            ggml_backend_free(cond_backend);
        }

        if (backend != nullptr) {
            ggml_backend_free(backend);
        }
    }

    /** ggml abort callback: `inData` is the `Impl`. */
    static bool abortRequested(void* inData)
    {
        const Impl& impl = *static_cast<const Impl*>(inData);
        return impl.should_cancel && impl.should_cancel();
    }

    void execute(ggml_cgraph* inGf, ggml_backend_t inBackend)
    {
        last_graph_nodes = ggml_graph_n_nodes(inGf);

        if (ggml_backend_is_cpu(inBackend)) {
            ggml_backend_cpu_set_n_threads(inBackend, opts.n_threads);
        }

        const ggml_status status = ggml_backend_graph_compute(inBackend, inGf);

        if (status == GGML_STATUS_ABORTED) {
            throw Exception(Error::Cancelled, "graph computation cancelled");
        }

        if (status != GGML_STATUS_SUCCESS) {
            throw Exception(Error::Internal, "ggml graph computation failed");
        }
    }

    /**
     * @param outDst Destination for the position rows.
     * @param inN Number of positions to copy.
     *
     * Copies the position rows for [n_past, n_past + inN) into `outDst`.
     */
    void fillPositions(float* outDst, int inN) const
    {
        if (n_past + inN > opts.n_ctx) {
            throw Exception(
                Error::ContextOverflow,
                msl::format("sequence of {} positions exceeds n_ctx={} (already at {})", inN, opts.n_ctx, n_past));
        }

        std::copy_n(pos_table.data() + static_cast<std::size_t>(n_past) * hp.dim,
                    static_cast<std::size_t>(inN) * hp.dim,
                    outDst);
    }

    /**
     * @param inNNew Number of new query positions.
     * @param inNKv Number of key/value positions to attend over.
     * @return Bottom-right aligned causal mask, [inNKv, inNNew] row-major.
     *
     * Query row i sits at absolute position n_past + i and may attend to
     * every key up to and including it. PyTorch's `is_causal=True` is
     * top-left aligned, which is only equivalent when n_new == n_kv; the
     * reference works around that by special-casing single-token decode,
     * and this mask covers both shapes uniformly.
     */
    std::vector<float> buildMask(int inNNew, int inNKv) const
    {
        std::vector<float> mask(static_cast<std::size_t>(inNNew) * inNKv);

        for (int i = 0; i < inNNew; ++i) {
            const int last = n_past + i;

            for (int j = 0; j < inNKv; ++j) {
                mask[static_cast<std::size_t>(i) * inNKv + j] = j <= last ? 0.0f : -INFINITY;
            }
        }

        return mask;
    }

    /**
     * Forces reserved and forbidden token ids to -inf in `ioLogits`.
     *
     * Both masks, in this order, because that is what `_compute_logits` does --
     * and it does it on every forward pass, not only inside the sampling loop,
     * so prefill and decode mask too.
     */
    void applyLogitMask(std::vector<float>& ioLogits) const
    {
        for (int i = hp.logit_mask_start; i < static_cast<int>(ioLogits.size()); ++i) {
            ioLogits[static_cast<std::size_t>(i)] = -INFINITY;
        }

        for (std::size_t i = 0; i < forbidden_mask.size() && i < ioLogits.size(); ++i) {
            if (forbidden_mask[i] != 0) {
                ioLogits[i] = -INFINITY;
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

Model::Model()
    : mImpl(std::make_unique<Impl>())
{
}

Model::~Model() = default;
Model::Model(Model&&) noexcept = default;
Model& Model::operator=(Model&&) noexcept = default;

Model Model::load(const std::filesystem::path& inGgufPath, Options inOptions)
{
    Model model;
    Impl& impl = *model.mImpl;

    if (inOptions.n_threads <= 0) {
        inOptions.n_threads = defaultThreadCount();
    }

    // The load-time callbacks are not kept: nothing may call them once `load`
    // has returned.
    impl.opts = inOptions;
    impl.opts.should_cancel = {};
    impl.opts.on_progress = {};

    // Not interruptible: on a GPU this can include compiling shaders.
    InitialisedBackend initialised = initBackend(inOptions.device);
    impl.backend = initialised.backend;
    impl.device = std::move(initialised.device);

    throwIfCancelled(inOptions.should_cancel);

    impl.file = std::make_unique<GgufFile>(
        inGgufPath, impl.backend, [&inOptions](std::size_t inBytesDone, std::size_t inBytesTotal) {
            throwIfCancelled(inOptions.should_cancel);

            if (inOptions.on_progress) {
                inOptions.on_progress(inBytesTotal > 0 ? static_cast<float>(inBytesDone) / inBytesTotal : 1.0f);
            }
        });

    const GgufFile& f = *impl.file;

    // Before anything else is read: every key below is part of the contract
    // this number names.
    const std::string version_key = key("format_version");
    const int version = f.has(version_key) ? f.i32(version_key) : 0;

    if (version != CHECKPOINT_FORMAT_VERSION) {
        throw Exception(Error::UnsupportedCheckpointVersion,
                        msl::format("{} is checkpoint format version {}; this build reads {}",
                                    utf8(inGgufPath.filename()),
                                    version,
                                    CHECKPOINT_FORMAT_VERSION));
    }

    Hparams& hp = impl.hp;
    hp.dim = f.i32(key("embedding_length"));
    hp.n_layer = f.i32(key("block_count"));
    hp.n_head = f.i32(key("attention.head_count"));
    hp.head_dim = f.i32(key("attention.head_dim"));
    hp.ffn_dim = f.i32(key("feed_forward_length"));
    hp.vocab_size = f.i32(key("vocab_size"));
    hp.initial_token_id = f.i32(key("initial_token_id"));
    hp.logit_mask_start = f.i32(key("logit_mask_start"));
    hp.layer_norm_eps = f.f32(key("attention.layer_norm_epsilon"));
    hp.max_period = f.f32(key("position_embedding.max_period"));
    hp.sample_rate = f.i32(key("audio.sample_rate"));
    hp.n_fft = f.i32(key("audio.n_fft"));
    hp.hop_length = f.i32(key("audio.hop_length"));
    hp.frame_rate = f.i32(key("audio.frame_rate"));
    hp.n_mels = f.i32(key("audio.n_mels"));
    hp.log_eps = f.f32(key("audio.log_eps"));

    if (hp.head_dim * hp.n_head != hp.dim) {
        throw Exception(Error::UnsupportedArch,
                        msl::format("inconsistent head geometry: {} heads x {} != {}", hp.n_head, hp.head_dim, hp.dim));
    }

    Weights& w = impl.w;
    w.token_embd = f.get("token_embd.weight");
    w.output = f.get("output.weight");
    w.output_norm_w = f.get("output_norm.weight");
    w.output_norm_b = f.get("output_norm.bias");
    w.mel_fb = f.get("cond.mel_fb.weight");
    w.stft_window = f.get("cond.stft_window");
    w.proj_w = f.get("cond.proj.weight");
    w.proj_b = f.get("cond.proj.bias");
    w.instrument_group = f.get("cond.instrument_group.weight");
    w.dataset_name = f.get("cond.dataset_name.weight");
    w.layers.resize(static_cast<std::size_t>(hp.n_layer));

    for (int il = 0; il < hp.n_layer; ++il) {
        LayerWeights& l = w.layers[static_cast<std::size_t>(il)];
        const auto p = [il](const char* part) { return msl::format("blk.{}.{}", il, part); };
        l.attn_norm_w = f.get(p("attn_norm.weight"));
        l.attn_norm_b = f.get(p("attn_norm.bias"));
        l.attn_qkv = f.get(p("attn_qkv.weight"));
        l.attn_out = f.get(p("attn_out.weight"));
        l.ffn_norm_w = f.get(p("ffn_norm.weight"));
        l.ffn_norm_b = f.get(p("ffn_norm.bias"));
        l.ffn_up = f.get(p("ffn_up.weight"));
        l.ffn_down = f.get(p("ffn_down.weight"));
    }

    // KV cache, F32 whatever the weight dtype: an F16 cache would add rounding
    // the fp32 reference does not have.
    {
        ggml_init_params params {};
        params.mem_size = ggml_tensor_overhead() * static_cast<std::size_t>(hp.n_layer) * 2 + 1024;
        params.no_alloc = true;
        impl.kv_ctx = ggml_init(params);
        impl.k_cache.resize(static_cast<std::size_t>(hp.n_layer));
        impl.v_cache.resize(static_cast<std::size_t>(hp.n_layer));

        for (int il = 0; il < hp.n_layer; ++il) {
            impl.k_cache[static_cast<std::size_t>(il)] = ggml_format_name(
                ggml_new_tensor_2d(impl.kv_ctx, GGML_TYPE_F32, hp.dim, inOptions.n_ctx), "cache_k.%d", il);
            impl.v_cache[static_cast<std::size_t>(il)] = ggml_format_name(
                ggml_new_tensor_3d(impl.kv_ctx, GGML_TYPE_F32, inOptions.n_ctx, hp.head_dim, hp.n_head),
                "cache_v.%d",
                il);
        }

        impl.kv_buf = ggml_backend_alloc_ctx_tensors(impl.kv_ctx, impl.backend);

        if (impl.kv_buf == nullptr) {
            throw Exception(Error::OutOfMemory, "failed to allocate the KV cache");
        }
    }

    impl.max_graph_nodes = graphNodeBound(hp.n_layer);
    impl.graph_buffer.resize(graphBufferSize(impl.max_graph_nodes));

    impl.alloc = ggml_gallocr_new(ggml_backend_get_default_buffer_type(impl.backend));

    // The CPU mirror of the conditioning weights. See Impl for why.
    if (ggml_backend_is_cpu(impl.backend)) {
        impl.cond_backend = impl.backend;
        impl.cond_alloc = impl.alloc;
        impl.cond_mel_fb = w.mel_fb;
        impl.cond_proj_w = w.proj_w;
        impl.cond_proj_b = w.proj_b;
    }

    else {
        impl.cond_backend = ggml_backend_cpu_init();

        if (impl.cond_backend == nullptr) {
            throw Exception(Error::OutOfMemory, "failed to initialise the CPU backend for the conditioning front-end");
        }

        impl.owns_cond_backend = true;

        ggml_init_params params {};
        params.mem_size = ggml_tensor_overhead() * 3 + 256;
        params.no_alloc = true;
        impl.cond_ctx = ggml_init(params);

        const auto declare = [&](const ggml_tensor* src) {
            ggml_tensor* dst = ggml_new_tensor(impl.cond_ctx, src->type, GGML_MAX_DIMS, src->ne);
            ggml_set_name(dst, ggml_get_name(src));
            return dst;
        };

        impl.cond_mel_fb = declare(w.mel_fb);
        impl.cond_proj_w = declare(w.proj_w);
        impl.cond_proj_b = declare(w.proj_b);

        impl.cond_buf = ggml_backend_alloc_ctx_tensors(impl.cond_ctx, impl.cond_backend);

        if (impl.cond_buf == nullptr) {
            throw Exception(Error::OutOfMemory, "failed to allocate the conditioning weights");
        }

        // Raw bytes rather than a float conversion, so the mirror is the same
        // dtype and the same values as the tensor it shadows.
        const auto mirror = [](const ggml_tensor* src, ggml_tensor* dst) {
            std::vector<std::uint8_t> staging(ggml_nbytes(src));
            ggml_backend_tensor_get(src, staging.data(), 0, staging.size());
            ggml_backend_tensor_set(dst, staging.data(), 0, staging.size());
        };

        mirror(w.mel_fb, impl.cond_mel_fb);
        mirror(w.proj_w, impl.cond_proj_w);
        mirror(w.proj_b, impl.cond_proj_b);

        impl.cond_alloc = ggml_gallocr_new(ggml_backend_get_default_buffer_type(impl.cond_backend));
    }
    impl.pos_table = buildPositionTable(inOptions.n_ctx, hp.dim, hp.max_period);
    impl.stft = std::make_unique<Stft>(hp.n_fft, hp.hop_length, tensorToFloat(w.stft_window));
    model.reset();

    // `cond_backend` is always a CPU backend, and is `backend` itself on the CPU.
    ggml_backend_cpu_set_abort_callback(impl.cond_backend, &Impl::abortRequested, &impl);

    throwIfCancelled(inOptions.should_cancel);
    return model;
}

const Hparams& Model::hparams() const
{
    return mImpl->hp;
}

const Device& Model::device() const
{
    return mImpl->device;
}

int Model::graphNodeCount() const
{
    return mImpl->last_graph_nodes;
}

int Model::graphNodeCapacity() const
{
    return static_cast<int>(mImpl->max_graph_nodes);
}

int Model::nPast() const
{
    return mImpl->n_past;
}

int Model::contextSize() const
{
    return mImpl->opts.n_ctx;
}

std::span<const float> Model::positionEmbeddings() const
{
    return mImpl->pos_table;
}

void Model::reset()
{
    mImpl->n_past = 0;

    // The reference allocates a fresh NaN-filled cache per generate() call and
    // never reads past `offset`, so stale contents are unobservable. Zeroing is
    // still worth it: it turns an off-by-one in the mask into an obviously
    // wrong number instead of a plausible one.
    for (std::size_t il = 0; il < mImpl->k_cache.size(); ++il) {
        ggml_backend_tensor_memset(mImpl->k_cache[il], 0, 0, ggml_nbytes(mImpl->k_cache[il]));
        ggml_backend_tensor_memset(mImpl->v_cache[il], 0, 0, ggml_nbytes(mImpl->v_cache[il]));
    }
}

// ---------------------------------------------------------------------------
// Conditioning
// ---------------------------------------------------------------------------

const Stft& Model::stft() const
{
    return *mImpl->stft;
}

std::vector<float> Model::encodeAudio(std::span<const float> inSamples, Trace* inTrace) const
{
    const Stft& s = *mImpl->stft;
    const int n_samples = static_cast<int>(inSamples.size());
    std::vector<float> spectrum = s.magnitudes(inSamples);
    return encodeConditioning(spectrum, s.nFrames(n_samples), n_samples, inTrace);
}

std::vector<float>
    Model::encodeConditioning(std::span<const float> inSpectrum, int inNFrames, int inNSamples, Trace* inTrace) const
{
    const Impl& impl = *mImpl;
    const Hparams& hp = impl.hp;

    const std::size_t expected = static_cast<std::size_t>(inNFrames) * static_cast<std::size_t>(hp.n_freq());

    if (inSpectrum.size() != expected) {
        throw Exception(Error::Internal,
                        msl::format("spectrum has {} values, expected {} ({} frames x {})",
                                    inSpectrum.size(),
                                    expected,
                                    inNFrames,
                                    hp.n_freq()));
    }

    GraphScratch scratch(mImpl->graph_buffer, mImpl->max_graph_nodes);
    ggml_context* ctx = scratch.ctx;

    ggml_tensor* inp = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, hp.n_freq(), inNFrames);
    ggml_set_name(inp, "spectrum");
    ggml_set_input(inp);

    ggml_tensor* eps = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
    ggml_set_name(eps, "log_eps");
    ggml_set_input(eps);

    // Zeroes the frames that fall outside the audio. The reference derives this
    // from the waveform length rather than the frame count -- centre-padded
    // STFT always yields one frame more than length/hop, so the final frame is
    // always masked away.
    ggml_tensor* mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 1, inNFrames);
    ggml_set_name(mask, "frame_mask");
    ggml_set_input(mask);

    ggml_tensor* mel = capture(inTrace, "cond.mel", mulMat(ctx, impl.cond_mel_fb, inp));
    ggml_tensor* logmel = capture(inTrace, "cond.logmel", ggml_log(ctx, ggml_add(ctx, mel, eps)));
    ggml_tensor* proj = ggml_add(ctx, mulMat(ctx, impl.cond_proj_w, logmel), impl.cond_proj_b);
    capture(inTrace, "cond.proj", proj);
    ggml_tensor* embed = capture(inTrace, "cond.embed", ggml_mul(ctx, proj, mask));

    ggml_build_forward_expand(scratch.gf, embed);
    const Impl::Allocation allocation =
        mImpl->allocateFor(scratch.gf, inTrace != nullptr, mImpl->cond_backend, mImpl->cond_alloc);

    ggml_backend_tensor_set(inp, inSpectrum.data(), 0, inSpectrum.size_bytes());
    ggml_backend_tensor_set(eps, &hp.log_eps, 0, sizeof(float));

    const int n_valid = inNSamples / hp.hop_length;
    std::vector<float> mask_data(static_cast<std::size_t>(inNFrames));
    for (int i = 0; i < inNFrames; ++i) {
        mask_data[static_cast<std::size_t>(i)] = i < n_valid ? 1.0f : 0.0f;
    }
    ggml_backend_tensor_set(mask, mask_data.data(), 0, mask_data.size() * sizeof(float));

    mImpl->execute(scratch.gf, mImpl->cond_backend);

    std::vector<float> out(static_cast<std::size_t>(inNFrames) * hp.dim);
    ggml_backend_tensor_get(embed, out.data(), 0, out.size() * sizeof(float));

    // `scratch` owns the tensor metadata and dies at the end of this scope, so
    // the trace has to take its copies now.
    if (inTrace != nullptr) {
        inTrace->materialize();
    }

    return out;
}

// ---------------------------------------------------------------------------
// Transformer
// ---------------------------------------------------------------------------

namespace
{

    /**
     * What `buildEvalGraph` hands back so the caller can fill inputs after
     * the allocator has placed them.
     */
    struct EvalGraph {
        ggml_tensor* tokens = nullptr;
        ggml_tensor* dataset_idx = nullptr; // one row, always the null class
        ggml_tensor* instrument_idx = nullptr; // one row per selected instrument
        ggml_tensor* cond = nullptr; // null on decode steps
        ggml_tensor* positions = nullptr;
        ggml_tensor* mask = nullptr;
        ggml_tensor* logits = nullptr;
        int n_new = 0;
    };

} // namespace

/**
 * Builds one forward pass.
 *
 * @param inImpl Model state (weights, KV cache, hparams).
 * @param ioScratch Scratch context and graph to build into.
 * @param inNCondFrames Number of conditioning frames to prepend; 0 marks a
 *        decode step (no conditioning prefix), otherwise this is a chunk's
 *        prefill.
 * @param inNTokens Number of tokens to feed at this step.
 * @param inTrace Optional trace to capture layer-0 intermediates into.
 * @return The graph's input/output tensors.
 */
static EvalGraph
    buildEvalGraph(Model::Impl& inImpl, GraphScratch& ioScratch, int inNCondFrames, int inNTokens, Trace* inTrace)
{
    const Hparams& hp = inImpl.hp;
    ggml_context* ctx = ioScratch.ctx;
    EvalGraph eg;

    const bool is_prefill = inNCondFrames > 0;
    const int n_instrument = static_cast<int>(inImpl.instrument_rows.size());
    // The class embeddings ride along with the mel frames on the first pass:
    // one dataset row, and one row per selected instrument -- so this is
    // n_cond_frames + 2 only in the unconditional case.
    const int n_prepend = is_prefill ? inNCondFrames + 1 + n_instrument : 0;
    const int n_new = n_prepend + inNTokens;
    const int n_kv = inImpl.n_past + n_new;
    eg.n_new = n_new;

    eg.tokens = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, inNTokens);
    ggml_set_name(eg.tokens, "tokens");
    ggml_set_input(eg.tokens);

    // Every id fed here is >= 0 (the initial token, a forced prologue token or an
    // argmax), so ScaledEmbedding's negative zero_idx path never applies.
    ggml_tensor* tok_embed = ggml_get_rows(ctx, inImpl.w.token_embd, eg.tokens);
    capture(inTrace, "pre.tok_embed", tok_embed);
    ggml_tensor* x = tok_embed;

    if (is_prefill) {
        // Two index tensors, not one shared with both lookups: the dataset
        // conditioner is always unconditional here (one null row), while the
        // instrument one carries a row per selection.
        eg.dataset_idx = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, 1);
        ggml_set_name(eg.dataset_idx, "dataset_idx");
        ggml_set_input(eg.dataset_idx);

        eg.instrument_idx = ggml_new_tensor_1d(ctx, GGML_TYPE_I32, n_instrument);
        ggml_set_name(eg.instrument_idx, "instrument_idx");
        ggml_set_input(eg.instrument_idx);

        eg.cond = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, hp.dim, inNCondFrames);
        ggml_set_name(eg.cond, "conditioning");
        ggml_set_input(eg.cond);

        ggml_tensor* dataset = ggml_get_rows(ctx, inImpl.w.dataset_name, eg.dataset_idx);
        ggml_tensor* instrument = ggml_get_rows(ctx, inImpl.w.instrument_group, eg.instrument_idx);
        capture(inTrace, "cond.dataset_name", dataset);
        capture(inTrace, "cond.instrument_group", instrument);

        // ConditioningProvider iterates {instrument_group, dataset_name,
        // self_wav} and each step prepends in front of what came before, so the
        // emitted order is the reverse of the iteration order. Getting this
        // backwards is the single easiest mistake in the port.
        x = ggml_concat(ctx, eg.cond, dataset, 1);
        x = ggml_concat(ctx, x, instrument, 1);
        x = ggml_concat(ctx, x, tok_embed, 1);
        capture(inTrace, "pre.prefix", x);
    }

    eg.positions = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, hp.dim, n_new);
    ggml_set_name(eg.positions, "positions");
    ggml_set_input(eg.positions);
    capture(inTrace, "pre.pos_emb", eg.positions);

    x = ggml_add(ctx, x, eg.positions);
    capture(inTrace, "pre.layer_in", x);

    eg.mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, n_kv, n_new);
    ggml_set_name(eg.mask, "kq_mask");
    ggml_set_input(eg.mask);

    const float kq_scale = 1.0f / std::sqrt(static_cast<float>(hp.head_dim));
    const std::size_t float_size = sizeof(float);

    for (int il = 0; il < hp.n_layer; ++il) {
        const LayerWeights& l = inImpl.w.layers[static_cast<std::size_t>(il)];
        ggml_tensor* k_cache = inImpl.k_cache[static_cast<std::size_t>(il)];
        ggml_tensor* v_cache = inImpl.v_cache[static_cast<std::size_t>(il)];
        const bool tracing = inTrace != nullptr && il == 0;

        ggml_tensor* residual = x;
        ggml_tensor* cur = layerNorm(ctx, x, l.attn_norm_w, l.attn_norm_b, hp.layer_norm_eps);

        if (tracing) {
            inTrace->capture("blk.0.norm1", cur);
        }

        // in_proj packs (q, k, v) with q outermost and head_dim innermost --
        // rearrange "(p h d)" with p=3 -- which is exactly ggml's layout, so
        // each of the three is a plain strided view, no copy.
        ggml_tensor* qkv = mulMat(ctx, l.attn_qkv, cur);
        const auto part = [&](int index) {
            return ggml_view_3d(ctx,
                                qkv,
                                hp.head_dim,
                                hp.n_head,
                                n_new,
                                hp.head_dim * float_size,
                                qkv->nb[1],
                                static_cast<std::size_t>(index) * hp.dim * float_size);
        };

        ggml_tensor* q = part(0);
        ggml_tensor* k = part(1);
        ggml_tensor* v = part(2);

        // Append this step's keys and values to the cache. Expanding the copies
        // into the graph here (rather than letting them fall out of the final
        // expand) is what orders them before the reads below.
        {
            // K goes in the way it comes out of the projection: one row per
            // position, the heads side by side within it, so this is a plain
            // copy with no permute.
            ggml_tensor* k_dst = ggml_view_3d(ctx,
                                              k_cache,
                                              hp.head_dim,
                                              hp.n_head,
                                              n_new,
                                              static_cast<std::size_t>(hp.head_dim) * float_size,
                                              k_cache->nb[1],
                                              static_cast<std::size_t>(inImpl.n_past) * k_cache->nb[1]);
            // V goes in transposed, so this destination runs along n_ctx rather
            // than head_dim and the source is permuted to match.
            ggml_tensor* v_dst = ggml_view_3d(ctx,
                                              v_cache,
                                              n_new,
                                              hp.head_dim,
                                              hp.n_head,
                                              v_cache->nb[1],
                                              v_cache->nb[2],
                                              static_cast<std::size_t>(inImpl.n_past) * float_size);
            ggml_build_forward_expand(ioScratch.gf, ggml_cpy(ctx, k, k_dst));
            ggml_build_forward_expand(ioScratch.gf, ggml_cpy(ctx, ggml_permute(ctx, v, 1, 2, 0, 3), v_dst));
        }

        ggml_tensor* k_all = ggml_view_3d(ctx,
                                          k_cache,
                                          hp.head_dim,
                                          n_kv,
                                          hp.n_head,
                                          k_cache->nb[1],
                                          static_cast<std::size_t>(hp.head_dim) * float_size,
                                          0);
        ggml_tensor* v_t = ggml_view_3d(ctx, v_cache, n_kv, hp.head_dim, hp.n_head, v_cache->nb[1], v_cache->nb[2], 0);

        ggml_tensor* q_heads = ggml_permute(ctx, q, 0, 2, 1, 3); // [head_dim, n_new, n_head]
        ggml_tensor* kq = mulMat(ctx, k_all, q_heads); // [n_kv, n_new, n_head]
        kq = ggml_soft_max_ext(ctx, kq, eg.mask, kq_scale, 0.0f);

        if (tracing) {
            inTrace->capture("blk.0.attn_probs", kq);
        }

        ggml_tensor* kqv = mulMat(ctx, v_t, kq); // [head_dim, n_new, n_head]
        ggml_tensor* merged = ggml_permute(ctx, kqv, 0, 2, 1, 3); // [head_dim, n_head, n_new]
        cur = ggml_cont_2d(ctx, merged, hp.dim, n_new);
        if (tracing) {
            inTrace->capture("blk.0.attn_ctx", cur);
        }

        cur = mulMat(ctx, l.attn_out, cur);

        if (tracing) {
            inTrace->capture("blk.0.attn_out", cur);
        }

        x = ggml_add(ctx, residual, cur);

        if (tracing) {
            inTrace->capture("blk.0.res1", x);
        }

        ggml_tensor* ffn = layerNorm(ctx, x, l.ffn_norm_w, l.ffn_norm_b, hp.layer_norm_eps);

        if (tracing) {
            inTrace->capture("blk.0.norm2", ffn);
        }

        ffn = mulMat(ctx, l.ffn_up, ffn);

        if (tracing) {
            inTrace->capture("blk.0.ffn_pre_gelu", ffn);
        }

        // F.gelu defaults to the exact erf formulation; ggml_gelu is the tanh
        // approximation, which differs by up to ~1e-3 and compounds over layers.
        ffn = ggml_gelu_erf(ctx, ffn);

        if (tracing) {
            inTrace->capture("blk.0.ffn_gelu", ffn);
        }

        ffn = mulMat(ctx, l.ffn_down, ffn);

        if (tracing) {
            inTrace->capture("blk.0.ffn_out", ffn);
        }

        x = ggml_add(ctx, x, ffn);
        capture(inTrace, msl::format("blk.{}.out", il), x);
    }

    x = layerNorm(ctx, x, inImpl.w.output_norm_w, inImpl.w.output_norm_b, hp.layer_norm_eps);
    capture(inTrace, "post.out_norm", x);

    // Only the final position is ever sampled, so the head runs on one row.
    ggml_tensor* last = ggml_view_2d(ctx, x, hp.dim, 1, x->nb[1], static_cast<std::size_t>(n_new - 1) * x->nb[1]);
    eg.logits = mulMat(ctx, inImpl.w.output, last);
    capture(inTrace, "post.logits_raw", eg.logits);

    ggml_build_forward_expand(ioScratch.gf, eg.logits);
    return eg;
}

std::vector<float> Model::prefill(std::span<const float> inConditioning,
                                  int inNFrames,
                                  std::span<const std::int32_t> inTokens,
                                  Trace* inTrace)
{
    Impl& impl = *mImpl;
    const Hparams& hp = impl.hp;

    if (inConditioning.size() != static_cast<std::size_t>(inNFrames) * hp.dim) {
        throw Exception(Error::Internal,
                        msl::format("conditioning has {} values, expected {}",
                                    inConditioning.size(),
                                    static_cast<std::size_t>(inNFrames) * hp.dim));
    }

    if (inTokens.empty()) {
        throw Exception(Error::Internal, "prefill needs at least one token");
    }

    if (inNFrames <= 0) {
        throw Exception(Error::Internal, "prefill needs at least one conditioning frame");
    }

    GraphScratch scratch(mImpl->graph_buffer, mImpl->max_graph_nodes);
    EvalGraph eg = buildEvalGraph(impl, scratch, inNFrames, static_cast<int>(inTokens.size()), inTrace);
    const Impl::Allocation allocation = impl.allocateFor(scratch.gf, inTrace != nullptr, impl.backend, impl.alloc);

    ggml_backend_tensor_set(eg.tokens, inTokens.data(), 0, inTokens.size_bytes());
    ggml_backend_tensor_set(eg.dataset_idx, &InstrumentGroups::NULL_CONDITIONING_ROW, 0, sizeof(std::int32_t));
    ggml_backend_tensor_set(
        eg.instrument_idx, impl.instrument_rows.data(), 0, impl.instrument_rows.size() * sizeof(std::int32_t));
    ggml_backend_tensor_set(eg.cond, inConditioning.data(), 0, inConditioning.size_bytes());

    std::vector<float> positions(static_cast<std::size_t>(eg.n_new) * hp.dim);
    impl.fillPositions(positions.data(), eg.n_new);
    ggml_backend_tensor_set(eg.positions, positions.data(), 0, positions.size() * sizeof(float));

    const std::vector<float> mask = impl.buildMask(eg.n_new, impl.n_past + eg.n_new);
    ggml_backend_tensor_set(eg.mask, mask.data(), 0, mask.size() * sizeof(float));

    impl.execute(scratch.gf, impl.backend);
    impl.n_past += eg.n_new;

    std::vector<float> logits(static_cast<std::size_t>(hp.vocab_size));
    ggml_backend_tensor_get(eg.logits, logits.data(), 0, logits.size() * sizeof(float));

    if (inTrace != nullptr) {
        inTrace->materialize();
    }

    impl.applyLogitMask(logits);
    return logits;
}

std::vector<float> Model::decode(std::int32_t inToken, Trace* inTrace)
{
    Impl& impl = *mImpl;
    const Hparams& hp = impl.hp;

    GraphScratch scratch(mImpl->graph_buffer, mImpl->max_graph_nodes);
    EvalGraph eg = buildEvalGraph(impl, scratch, 0, 1, inTrace);
    const Impl::Allocation allocation = impl.allocateFor(scratch.gf, inTrace != nullptr, impl.backend, impl.alloc);

    ggml_backend_tensor_set(eg.tokens, &inToken, 0, sizeof(std::int32_t));

    std::vector<float> positions(static_cast<std::size_t>(hp.dim));
    impl.fillPositions(positions.data(), 1);
    ggml_backend_tensor_set(eg.positions, positions.data(), 0, positions.size() * sizeof(float));

    const std::vector<float> mask = impl.buildMask(1, impl.n_past + 1);
    ggml_backend_tensor_set(eg.mask, mask.data(), 0, mask.size() * sizeof(float));

    impl.execute(scratch.gf, impl.backend);
    impl.n_past += 1;

    std::vector<float> logits(static_cast<std::size_t>(hp.vocab_size));
    ggml_backend_tensor_get(eg.logits, logits.data(), 0, logits.size() * sizeof(float));

    if (inTrace != nullptr) {
        inTrace->materialize();
    }

    impl.applyLogitMask(logits);
    return logits;
}

std::vector<std::int32_t>
    Model::generate(std::span<const float> inConditioning, int inNFrames, int inMaxTokens, std::int32_t inEosId)
{
    return generate(inConditioning, inNFrames, inMaxTokens, inEosId, {});
}

std::vector<std::int32_t> Model::generate(std::span<const float> inConditioning,
                                          int inNFrames,
                                          int inMaxTokens,
                                          std::int32_t inEosId,
                                          std::span<const std::int32_t> inPrompt)
{
    reset();

    // [initial_token, prompt...] in one square-causal prefill, which is what
    // the reference does: it writes the prompt into gen_sequence and starts
    // decoding from the end of it rather than stepping through it.
    std::vector<std::int32_t> prefill_tokens;
    prefill_tokens.reserve(inPrompt.size() + 1);
    prefill_tokens.push_back(mImpl->hp.initial_token_id);
    prefill_tokens.insert(prefill_tokens.end(), inPrompt.begin(), inPrompt.end());

    std::vector<float> logits = prefill(inConditioning, inNFrames, prefill_tokens);

    // The prompt is part of the answer: the decode state machine has to see it
    // to leave the tie prologue, and upstream yields it into the same stream.
    std::vector<std::int32_t> out(inPrompt.begin(), inPrompt.end());
    out.reserve(static_cast<std::size_t>(inMaxTokens));

    for (int step = static_cast<int>(inPrompt.size()); step < inMaxTokens; ++step) {
        const auto best = std::max_element(logits.begin(), logits.end());
        const std::int32_t next = static_cast<std::int32_t>(std::distance(logits.begin(), best));
        out.push_back(next);

        if (next == inEosId) {
            break;
        }

        // Skip the last forward pass once the budget is spent: nothing reads its
        // logits, and it would take one more KV position.
        if (step + 1 < inMaxTokens) {
            throwIfCancelled(mImpl->should_cancel);
            logits = decode(next);
        }
    }

    return out;
}

void Model::setInstrumentRows(std::span<const std::int32_t> inRows)
{
    if (inRows.empty()) {
        mImpl->instrument_rows = {InstrumentGroups::NULL_CONDITIONING_ROW};
        return;
    }

    mImpl->instrument_rows.assign(inRows.begin(), inRows.end());
}

std::span<const std::int32_t> Model::instrumentRows() const
{
    return mImpl->instrument_rows;
}

void Model::setForbiddenTokens(std::span<const std::int32_t> inTokenIds)
{
    if (inTokenIds.empty()) {
        mImpl->forbidden_mask.clear();
        return;
    }

    mImpl->forbidden_mask.assign(static_cast<std::size_t>(mImpl->hp.vocab_size), 0);

    for (const std::int32_t id: inTokenIds) {
        if (id >= 0 && id < mImpl->hp.vocab_size) {
            mImpl->forbidden_mask[static_cast<std::size_t>(id)] = 1;
        }
    }
}

bool Model::hasForbiddenTokens() const
{
    return !mImpl->forbidden_mask.empty();
}

void Model::setNumThreads(int inNThreads)
{
    mImpl->opts.n_threads = inNThreads > 0 ? inNThreads : defaultThreadCount();
}

int Model::numThreads() const
{
    return mImpl->opts.n_threads;
}

void Model::setShouldCancel(std::function<bool()> inShouldCancel)
{
    mImpl->should_cancel = std::move(inShouldCancel);
}

} // namespace msl
