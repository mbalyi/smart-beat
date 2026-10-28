//! The pages the browser shows after a cloud sign-in (#187). Self-contained: inline CSS and one
//! tiny inline script, the artwork embedded as data, no external requests.

use base64::Engine;

const CLOUD_ART: &[u8] = include_bytes!("assets/connected-cloud.webp");
const SPLASH_ART: &[u8] = include_bytes!("assets/connected-splash.webp");

fn data_uri(bytes: &[u8]) -> String {
    format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Sent with every page: nothing may load from outside, only the inline style and script run.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

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
        &format!("{provider} is <em>connected</em>"),
        "You are signed in. You can close this tab and return to Smart Beat.",
    )
}

/// The page after a failed or cancelled sign-in; `reason` must be a short plain-English sentence
/// (never a provider body, token or secret).
pub fn error_page(reason: &str) -> String {
    page(
        "error",
        "Sign-in did not <em>complete</em>",
        &format!(
            "{} You can close this tab and try again in Smart Beat.",
            escape_html(reason)
        ),
    )
}

/// `title` may hold one `<em>` accent word; it and `message` must already be escaped.
fn page(status: &str, title: &str, message: &str) -> String {
    let art = if status == "ok" {
        format!(
            r#"<img class="art" src="{}" alt="" width="560" height="373">"#,
            data_uri(CLOUD_ART)
        )
    } else {
        r#"<div class="status error" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></div>"#.to_owned()
    };
    let splash = data_uri(SPLASH_ART);
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Smart Beat</title>
<style>
:root{{--bg:#07060b;--card:#0c0b12;--fg:#fff;--muted:#a9a7b8;--line:#4a1fa8;--accent:#ff2d95;--blue:#12a8ff;--err:#ff6b81}}
*{{box-sizing:border-box}}
html,body{{height:100%;margin:0}}
body{{display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg) url("{splash}") center/cover no-repeat;color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}
main{{position:relative;width:100%;max-width:580px;padding:12px 32px 32px;text-align:center;background:rgba(12,11,18,.92);border:1.5px solid var(--line);border-radius:24px;box-shadow:0 0 60px rgba(120,60,255,.18)}}
.art{{display:block;width:min(100%,460px);height:auto;margin:-72px auto 0}}
.status{{width:72px;height:72px;margin:20px auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:3px solid currentColor}}
.status svg{{width:38px;height:38px}}
.error{{color:var(--err)}}
.brand{{display:inline-flex;align-items:center;gap:10px;margin:4px 0 6px;font-weight:700;font-size:18px}}
.brand i{{width:12px;height:12px;border-radius:50%;background:var(--accent)}}
h1{{margin:0 0 10px;font-size:clamp(28px,6vw,40px);line-height:1.15;font-weight:800;letter-spacing:-.01em}}
h1 em{{font-style:normal;color:var(--blue)}}
.error~h1 em,.status.error+.brand+h1 em{{color:var(--err)}}
p{{margin:0 auto 22px;max-width:420px;color:var(--muted)}}
button{{display:inline-flex;align-items:center;gap:10px;font:inherit;font-weight:700;font-size:18px;color:#fff;background:var(--accent);border:0;border-radius:12px;padding:14px 56px;cursor:pointer;box-shadow:0 0 28px rgba(255,45,149,.55)}}
button:hover{{filter:brightness(1.08)}}
button:focus-visible{{outline:3px solid #fff;outline-offset:3px}}
#note{{margin:18px auto 0;max-width:380px;font-size:14px;color:var(--muted);min-height:1.5em}}
</style>
</head>
<body>
<main>
{art}
<div class="brand"><i aria-hidden="true"></i>Smart Beat</div>
<h1>{title}</h1>
<p>{message}</p>
<button type="button" id="close">Close this tab <span aria-hidden="true">&rarr;</span></button>
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
        assert!(ok.contains("Google Drive is <em>connected</em>"));
        assert!(ok.contains("You can close this tab"));
        let bad = error_page("The provider refused the request.");
        assert!(bad.contains("Smart Beat"));
        assert!(bad.contains("Sign-in did not <em>complete</em>"));
        assert!(bad.contains("The provider refused the request."));
    }

    #[test]
    fn pages_make_no_external_requests() {
        for html in [success_page("X"), error_page("y")] {
            assert!(!html.contains("http://") && !html.contains("https://"));
            assert!(!html.contains("<link"));
            // The only images are embedded data.
            assert!(!html.contains("src=\"data:") || html.contains("src=\"data:image/webp"));
            assert!(!html.contains("url(\"http") && !html.contains("src=\"/"));
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
        assert!(CONTENT_SECURITY_POLICY.contains("img-src data:"));
    }
}
