#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <vector>

namespace msl
{

/** A device the model can run on. */
struct Device {
    /** Human-readable, e.g. `"NVIDIA GeForce RTX 4070"`, `"Apple M1 Pro"`, `"CPU"`. Not unique. */
    std::string name;

    /** `"Metal"`, `"Vulkan"` or `"CPU"`. Stable: a host may branch on it. */
    std::string backend;

    /** ggml reports it as an integrated GPU. Only Vulkan makes the distinction. */
    bool integrated = false;

    /** Bytes of memory the device can use, 0 when unknown (always for the CPU). */
    std::size_t memory_total = 0;
};

/**
 * The devices this build can run on, GPUs first in the backend's own order,
 * the CPU always last, so the list is never empty.
 *
 * The list is built on the first call and fixed for the life of the process:
 * ggml enumerates its GPUs once. The first call can take a noticeable time
 * (Vulkan instance creation, Metal shader compilation); keep it off a UI thread.
 * Thread-safe.
 */
std::vector<Device> availableDevices();

/**
 * The device `LoadOptions::device` left empty resolves to: the first discrete
 * GPU, otherwise the first integrated GPU, otherwise the CPU.
 *
 * @param inDevices A list from `availableDevices`.
 * @return An index into `inDevices`.
 */
std::size_t autoDevice(std::span<const Device> inDevices);

} // namespace msl
