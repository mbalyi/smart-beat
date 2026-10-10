//! Checks the address of Import from Audio's server. build.rs includes this file to check
//! `TRANSCRIPTION_SERVICE_URL`, and the library's tests run it.
use url::Url;

/// Hosts that may use plain `http://`: a server on this computer.
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The address without a trailing slash, or why it is refused. Only `https://` is allowed,
/// or `http://` to this computer. The URL is parsed, so `http://localhost:80@example.com`,
/// whose host is `example.com`, is refused.
pub fn check(address: &str) -> Result<String, String> {
    let url = Url::parse(address.trim()).map_err(|e| format!("is not a URL ({e})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not contain a user name or password".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("must not contain a query or a fragment".into());
    }
    let local = url
        .host_str()
        .is_some_and(|host| LOCAL_HOSTS.contains(&host));
    match url.scheme() {
        "https" if url.host_str().is_some() => {}
        "http" if local => {}
        _ => {
            return Err(
                "must be an https:// URL, or http:// to localhost, 127.0.0.1 or [::1]".into(),
            );
        }
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn accepts_https_and_local_http() {
        assert_eq!(
            check("https://transcribe.example.com/").unwrap(),
            "https://transcribe.example.com"
        );
        assert_eq!(
            check(" https://example.com/muscriptor/ ").unwrap(),
            "https://example.com/muscriptor"
        );
        for local in [
            "http://localhost:8222",
            "http://127.0.0.1:8222",
            "http://[::1]:8222",
        ] {
            assert_eq!(check(local).unwrap(), local);
        }
    }

    #[test]
    fn refuses_plain_http_to_another_host() {
        for address in [
            "http://localhost:80@attacker.example",
            "http://localhost.attacker.example:8222",
            "http://127.0.0.1.attacker.example",
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/?key=1",
            "ftp://example.com",
            "localhost:8222",
        ] {
            assert!(check(address).is_err(), "{address}");
        }
    }
}
