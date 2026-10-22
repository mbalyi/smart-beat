#include "muscriptor/device.hpp"
#include "muscriptor/error.hpp"

#include "device_backend.hpp"
#include "log.hpp"

#include <ggml-backend.h>
#include <ggml-cpu.h>

#include <algorithm>
#include <mutex>
#include <set>
#include <string>

#if defined(MUSCRIPTOR_HAS_METAL)
#include <ggml-metal.h>
#endif

#if defined(MUSCRIPTOR_HAS_VULKAN)
#include <ggml-vulkan.h>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#endif

namespace msl
{

namespace
{

#if defined(MUSCRIPTOR_HAS_VULKAN)
    /**
     * @return True when a Vulkan call is safe to make. On Windows
     *         `vulkan-1.dll` is delay-loaded and a missing loader would raise
     *         a structured exception on the first call.
     */
    bool vulkanLoaderPresent()
    {
#if defined(_WIN32)
        return LoadLibraryW(L"vulkan-1.dll") != nullptr;
#else
        return true;
#endif
    }
#endif

    /** `devices[i]` runs on `handles[i]`; the CPU's handle is null. */
    struct Registry {
        std::vector<Device> devices;
        std::vector<ggml_backend_dev_t> handles;

        void add(ggml_backend_dev_t inHandle, const char* inBackend)
        {
            ggml_backend_dev_props props {};
            ggml_backend_dev_get_props(inHandle, &props);

            // ggml-metal still creates a device when the system has no Metal
            // GPU, and leaves its description empty.
            if (props.description == nullptr || props.description[0] == '\0') {
                return;
            }

            devices.push_back({.name = props.description,
                               .backend = inBackend,
                               .integrated = props.type == GGML_BACKEND_DEVICE_TYPE_IGPU,
                               .memory_total = props.memory_total});
            handles.push_back(inHandle);
        }
    };

    /**
     * Each backend's own registry only: ggml's global one would load every
     * backend, and on Windows that faults without `vulkan-1.dll`.
     */
    Registry enumerate()
    {
        // Before the first ggml call of the process, so enumeration never
        // reaches ggml's own stderr handler.
        installLogHook();

        Registry registry;

#if defined(MUSCRIPTOR_HAS_METAL)
        // Only the physical GPU: GGML_METAL_DEVICES can add virtual devices on
        // top of it.
        if (ggml_backend_reg_t reg = ggml_backend_metal_reg(); reg != nullptr && ggml_backend_reg_dev_count(reg) > 0) {
            registry.add(ggml_backend_reg_dev_get(reg, 0), "Metal");
        }
#endif

#if defined(MUSCRIPTOR_HAS_VULKAN)
        if (vulkanLoaderPresent()) {
            // ggml_backend_vk_reg catches instance-creation failures; the device
            // queries after it are not guarded.
            try {
                if (ggml_backend_reg_t reg = ggml_backend_vk_reg(); reg != nullptr) {
                    const std::size_t count = ggml_backend_reg_dev_count(reg);

                    for (std::size_t i = 0; i < count; ++i) {
                        registry.add(ggml_backend_reg_dev_get(reg, i), "Vulkan");
                    }
                }
            } catch (...) {
            }
        }
#endif

        registry.devices.push_back({.name = "CPU", .backend = "CPU"});
        registry.handles.push_back(nullptr);
        return registry;
    }

    const Registry& registry()
    {
        static const Registry instance = enumerate();
        return instance;
    }

    /**
     * @return The backend for `inHandle`, or null if it cannot be initialised.
     *         Call with initBackend's lock held.
     */
    ggml_backend_t initHandle(ggml_backend_dev_t inHandle)
    {
        if (inHandle == nullptr) {
            return ggml_backend_cpu_init();
        }

        // ggml-vulkan caches a device before creating it, so retrying one that
        // failed would return a half-built device.
        static std::set<ggml_backend_dev_t> failed;

        if (failed.contains(inHandle)) {
            return nullptr;
        }

        // Vulkan's device init has no failure path: a device that refuses
        // creation throws.
        try {
            if (ggml_backend_t backend = ggml_backend_dev_init(inHandle, nullptr); backend != nullptr) {
                return backend;
            }
        } catch (...) {
        }

        failed.insert(inHandle);
        return nullptr;
    }

} // namespace

std::vector<Device> availableDevices()
{
    return registry().devices;
}

std::size_t autoDevice(std::span<const Device> inDevices)
{
    const auto discrete = std::ranges::find_if(
        inDevices, [](const Device& inDevice) { return inDevice.backend != "CPU" && !inDevice.integrated; });

    // GPUs come first, so index 0 is the first GPU, or the CPU when there is none.
    return discrete != inDevices.end() ? static_cast<std::size_t>(discrete - inDevices.begin()) : 0;
}

InitialisedBackend initBackend(std::optional<std::size_t> inDevice)
{
    const Registry& reg = registry();
    const std::size_t cpu = reg.devices.size() - 1;

    // ggml's Vulkan device setup is lazily initialised without a lock, and two
    // models may load at once.
    static std::mutex mutex;
    const std::lock_guard<std::mutex> lock(mutex);

    if (inDevice.has_value()) {
        const std::size_t index = *inDevice;

        if (index >= reg.devices.size()) {
            throw Exception(Error::DeviceUnavailable, "no device at index " + std::to_string(index));
        }

        if (ggml_backend_t backend = initHandle(reg.handles[index]); backend != nullptr) {
            return {backend, reg.devices[index]};
        }

        throw Exception(Error::DeviceUnavailable, "failed to initialise " + reg.devices[index].name);
    }

    if (const std::size_t pick = autoDevice(reg.devices); pick != cpu) {
        if (ggml_backend_t backend = initHandle(reg.handles[pick]); backend != nullptr) {
            return {backend, reg.devices[pick]};
        }
    }

    if (ggml_backend_t backend = initHandle(nullptr); backend != nullptr) {
        return {backend, reg.devices[cpu]};
    }

    throw Exception(Error::OutOfMemory, "failed to initialise the CPU backend");
}

} // namespace msl
