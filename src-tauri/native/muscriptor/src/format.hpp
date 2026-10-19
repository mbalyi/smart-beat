#pragma once

#include <algorithm>
#include <filesystem>
#include <locale>
#include <sstream>
#include <string>
#include <string_view>

namespace msl
{

namespace detail
{
    /**
     * Copy literal text up to the next `{}`, unescaping `{{` to `{`.
     *
     * @return true when a placeholder was consumed and a value should follow,
     *         false when the format string ran out first.
     */
    inline bool nextPlaceholder(std::ostringstream& outStream, std::string_view& ioFormat)
    {
        while (!ioFormat.empty()) {
            const std::size_t brace = ioFormat.find('{');

            if (brace == std::string_view::npos) {
                outStream << ioFormat;
                ioFormat = {};
                return false;
            }

            outStream << ioFormat.substr(0, brace);

            if (ioFormat.substr(brace, 2) == "{{") {
                outStream << '{';
                ioFormat.remove_prefix(brace + 2);
                continue;
            }

            // A '{' at the very end has no second character to skip past.
            ioFormat.remove_prefix(std::min(brace + 2, ioFormat.size()));
            return true;
        }

        return false;
    }
} // namespace detail

/**
 * Substitute each `{}` in `inFormat` with the next argument, streamed.
 *
 * Stands in for `std::format`, which this library cannot use: libc++
 * instantiates its floating-point formatter on every call regardless of the
 * argument types, and that formatter is gated on a macOS 13.3 deployment
 * target. Using it would raise the minimum macOS of anything embedding this
 * library from 11.0 to 13.3.
 *
 * Only `{}` is understood -- no indices, no format specs. `{{` is a literal
 * brace. Call it qualified: an unqualified call with a `std` argument would
 * find `std::format` by ADL wherever `<format>` has been included.
 *
 * Unlike `std::format`, a count mismatch is not an error: surplus placeholders
 * come out empty and surplus arguments are dropped, either way keeping the
 * literal text.
 */
template <typename... Args>
std::string format(std::string_view inFormat, const Args&... inArgs)
{
    std::ostringstream out;

    // The host owns the global locale, and a DAW may well have set one that
    // punctuates integers. Diagnostics should read the same everywhere.
    out.imbue(std::locale::classic());

    std::string_view rest = inFormat;

    ((detail::nextPlaceholder(out, rest) ? void(out << inArgs) : void()), ...);

    // The literal text after the last placeholder an argument reached.
    while (detail::nextPlaceholder(out, rest)) {}

    return out.str();
}

/**
 * `inPath` as UTF-8, the encoding ggml decodes a `char*` path with on Windows.
 * `path::string()` gives the active code page there instead, and throws for a
 * character that page cannot represent.
 */
inline std::string utf8(const std::filesystem::path& inPath)
{
    const std::u8string text = inPath.u8string();
    return {text.begin(), text.end()};
}

} // namespace msl
