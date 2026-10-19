#pragma once

#include "muscriptor/device.hpp"

#include <ggml-backend.h>

#include <cstddef>
#include <optional>

namespace msl
{

struct InitialisedBackend {
    ggml_backend_t backend = nullptr;
    Device device;
};

/**
 * Initialises the backend for one of `availableDevices()`, as described at
 * `LoadOptions::device`.
 *
 * @return A backend the caller owns, and the device it runs on.
 */
InitialisedBackend initBackend(std::optional<std::size_t> inDevice);

} // namespace msl
