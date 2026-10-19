#pragma once

#include "muscriptor/log.hpp"

namespace msl
{

/**
 * Point ggml's global log hook at this library's sink, replacing ggml's own
 * handler -- which writes every message to stderr and ignores its level.
 *
 * Idempotent. Called before device enumeration, the library's first ggml call,
 * so the default is silence whether or not the host ever calls
 * `setLogCallback`.
 */
void installLogHook();

} // namespace msl
