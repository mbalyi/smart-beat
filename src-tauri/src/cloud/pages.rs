//! The pages the browser shows after a cloud sign-in (#187). Self-contained: inline CSS and one
//! tiny inline script, no external requests.

/// Sent with every page: nothing may load from outside, only the inline style and script run.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/// Escapes text for HTML element content and attribute values.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The page after a successful sign-in; `provider` is the display name (e.g. "Google Drive").
pub fn success_page(provider: &str) -> String {
    let provider = escape_html(provider);
    page(
        "ok",
        &format!("{provider} is connected"),
        "You are signed in. You can close this tab and return to Smart Beat.",
    )
}

/// The page after a failed or cancelled sign-in; `reason` must be a short plain-English sentence
/// (never a provider body, token or secret).
pub fn error_page(reason: &str) -> String {
    page(
        "error",
        "Sign-in did not complete",
        &format!(
            "{} You can close this tab and try again in Smart Beat.",
            escape_html(reason)
        ),
    )
}

/// `title` must already be escaped; `message` too.
fn page(status: &str, title: &str, message: &str) -> String {
    let mark = if status == "ok" {
        r#"<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>"#
    } else {
        r#"<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>"#
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Smart Beat</title>
<style>
:root{{--bg:#f4f1ea;--card:#ffffff;--fg:#1c1b22;--muted:#5d5b68;--line:#dcd8cc;--accent:#e8337c;--ok:#16a34a;--err:#dc2626}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0e0d12;--card:#18171f;--fg:#f3f1f8;--muted:#a19fb0;--line:#2c2a38;--accent:#ff4d94;--ok:#4ade80;--err:#f87171}}}}
*{{box-sizing:border-box}}
html,body{{height:100%;margin:0}}
body{{display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}
main{{width:100%;max-width:420px;padding:36px 32px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.14)}}
.brand{{display:inline-flex;align-items:center;gap:10px;margin-bottom:24px;font-weight:800;font-size:20px;letter-spacing:.02em}}
.brand i{{width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}}
.status{{width:64px;height:64px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid currentColor}}
.status svg{{width:34px;height:34px}}
.ok{{color:var(--ok)}}.error{{color:var(--err)}}
h1{{margin:0 0 8px;font-size:22px;color:var(--fg)}}
p{{margin:0 0 22px;color:var(--muted)}}
button{{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:10px;padding:10px 22px;cursor:pointer}}
button:focus-visible{{outline:3px solid var(--fg);outline-offset:2px}}
#note{{margin-top:16px;font-size:14px;color:var(--muted);min-height:1.5em}}
</style>
</head>
<body>
<main>
<div class="brand"><i aria-hidden="true"></i>Smart Beat</div>
<div class="status {status}" aria-hidden="true"><svg viewBox="0 0 24 24">{mark}</svg></div>
<h1>{title}</h1>
<p>{message}</p>
<button type="button" id="close">Close this tab</button>
<div id="note" role="status"></div>
</main>
<script>
(function(){{
var note=document.getElementById("note");
function tryClose(){{
window.close();
setTimeout(function(){{note.textContent="Your browser kept this tab open. You can close it yourself and return to Smart Beat."}},400);
}}
document.getElementById("close").addEventListener("click",tryClose);
setTimeout(tryClose,2500);
}})();
</script>
</body>
</html>
"#
    )
}

/// A complete HTTP response for `body` with the page headers.
pub fn http_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: {CONTENT_SECURITY_POLICY}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_carry_the_app_name_and_status() {
        let ok = success_page("Google Drive");
        assert!(ok.contains("Smart Beat"));
        assert!(ok.contains("Google Drive is connected"));
        assert!(ok.contains("You can close this tab"));
        assert!(ok.contains("prefers-color-scheme:dark"));
        let bad = error_page("The provider refused the request.");
        assert!(bad.contains("Smart Beat"));
        assert!(bad.contains("Sign-in did not complete"));
        assert!(bad.contains("The provider refused the request."));
    }

    #[test]
    fn pages_make_no_external_requests() {
        for html in [success_page("X"), error_page("y")] {
            assert!(!html.contains("http://") && !html.contains("https://"));
            assert!(!html.contains("src=") && !html.contains("<link"));
            assert!(!html.contains("url("));
        }
    }

    #[test]
    fn dynamic_text_is_escaped() {
        let html = success_page("<script>alert(1)</script>");
        assert!(!html.contains("<script>alert(1)"));
        assert!(html.contains("&lt;script&gt;alert(1)"));
        let html = error_page(r#""><img onerror=x>"#);
        assert!(!html.contains("<img"));
    }

    #[test]
    fn response_sets_a_csp_matching_the_page() {
        let response = http_response("200 OK", "<p>hi</p>");
        assert!(response.contains("Content-Security-Policy: default-src 'none'"));
        assert!(response.contains("Content-Length: 9\r\n"));
        // The page uses an inline style and an inline script, nothing else.
        assert!(CONTENT_SECURITY_POLICY.contains("style-src 'unsafe-inline'"));
        assert!(CONTENT_SECURITY_POLICY.contains("script-src 'unsafe-inline'"));
    }
}
