//! OAuth 2.0 authorization code flow with PKCE (S256) for desktop apps: the system browser
//! signs in, the redirect lands on a loopback listener (`127.0.0.1`, random port), and the code
//! is exchanged for tokens (#187).

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::keychain::TokenStore;
use super::pages;
use super::{Provider, ProviderKind, Tokens, agent, encode};
use crate::cloud_folder::now_secs;
use crate::error::{CommandError, ErrorKind};

/// A provider's OAuth endpoints and the app's registration.
#[derive(Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    /// Sent with the token requests when set. Google's Desktop app clients come with one and
    /// still ask for it with PKCE; it is not confidential for an installed app, but it stays out
    /// of the logs (see the manual `Debug`).
    pub client_secret: Option<String>,
    /// Local ports the sign-in may listen on for the redirect, tried in order. Empty means any
    /// free port. Dropbox compares the redirect address exactly, port included, so it needs a
    /// fixed list that is registered in its console.
    pub redirect_ports: Vec<u16>,
    /// Host name in the redirect address: `127.0.0.1`, or `localhost` where the provider is
    /// registered that way (Microsoft documents `http://localhost` for desktop apps). The
    /// listener is always on the IPv4 loopback address.
    pub redirect_host: String,
    pub auth_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Extra authorization parameters (`access_type=offline`, `token_access_type=offline`, ...).
    pub extra_auth_params: Vec<(String, String)>,
}

impl std::fmt::Debug for OAuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthConfig")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<hidden>"),
            )
            .field("auth_url", &self.auth_url)
            .field("token_url", &self.token_url)
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce() -> Result<(String, String), CommandError> {
    let verifier = random_token(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// URL-safe random text from `bytes` bytes of OS randomness.
pub fn random_token(bytes: usize) -> Result<String, CommandError> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)
        .map_err(|e| CommandError::new(ErrorKind::Io, format!("No secure randomness: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub fn authorize_url(config: &OAuthConfig, redirect: &str, state: &str, challenge: &str) -> String {
    let mut url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        config.auth_url,
        encode(&config.client_id),
        encode(redirect),
        encode(&config.scopes.join(" ")),
        encode(state),
        encode(challenge),
    );
    for (key, value) in &config.extra_auth_params {
        url.push_str(&format!("&{}={}", encode(key), encode(value)));
    }
    url
}

/// The loopback listener that receives the redirect.
pub struct Loopback {
    listener: TcpListener,
}

impl Loopback {
    /// Binds a random free port on `127.0.0.1`.
    pub fn bind() -> Result<Self, CommandError> {
        Self::bind_to(&[])
    }

    /// Binds the first free port of `ports` on `127.0.0.1`; any free port when the list is empty.
    pub fn bind_to(ports: &[u16]) -> Result<Self, CommandError> {
        let candidates: &[u16] = if ports.is_empty() { &[0] } else { ports };
        let mut last_error = None;
        for &port in candidates {
            match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
                Ok(listener) => {
                    listener.set_nonblocking(true).ok();
                    return Ok(Self { listener });
                }
                Err(e) => last_error = Some(e),
            }
        }
        let reason = last_error.map_or_else(String::new, |e| e.to_string());
        Err(CommandError::new(
            ErrorKind::Io,
            if ports.is_empty() {
                format!("The sign-in could not start: {reason}")
            } else {
                format!(
                    "The sign-in could not start: none of the local ports {ports:?} is free ({reason}). \
                     Close the program using them and try again."
                )
            },
        ))
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map_or(0, |a| a.port())
    }

    pub fn redirect_uri(&self) -> String {
        self.redirect_uri_with("127.0.0.1")
    }

    /// The redirect address with `host` as the host name.
    pub fn redirect_uri_with(&self, host: &str) -> String {
        Self::redirect_uri_for(host, self.port())
    }

    /// The redirect address for `host` and `port`.
    pub fn redirect_uri_for(host: &str, port: u16) -> String {
        format!("http://{host}:{port}/")
    }

    /// Waits for the browser redirect and returns the authorization code together with the open
    /// browser connection, which the caller answers once the code exchange is done. Checks
    /// `state`. A cancelled or mismatched redirect is answered with an error page right away.
    pub fn wait_for_code(
        &self,
        state: &str,
        timeout: Duration,
    ) -> Result<(String, PendingReply), CommandError> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(result) = handle_redirect(stream, state) {
                        return result;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(CommandError::new(
                        ErrorKind::Io,
                        format!("Sign-in failed: {e}"),
                    ));
                }
            }
        }
        Err(CommandError::new(
            ErrorKind::Network,
            "The sign-in timed out.",
        ))
    }
}

/// The browser connection of a valid redirect, still waiting for its page.
#[derive(Debug)]
pub struct PendingReply {
    stream: TcpStream,
}

impl PendingReply {
    /// Shows the success page.
    pub fn succeed(self, provider: &str) {
        self.send("200 OK", &pages::success_page(provider));
    }

    /// Shows the error page with a short reason derived from `error` (never its raw text).
    pub fn fail(self, error: &CommandError) {
        self.send("200 OK", &pages::error_page(failure_reason(error)));
    }

    fn send(mut self, status: &str, body: &str) {
        let _ = self
            .stream
            .write_all(pages::http_response(status, body).as_bytes());
        let _ = self.stream.flush();
    }
}

/// A short, safe sentence for the browser; the details stay in the app.
fn failure_reason(error: &CommandError) -> &'static str {
    match error.kind {
        ErrorKind::AuthExpired => "The provider did not accept the sign-in.",
        ErrorKind::Network => "Smart Beat could not reach the provider.",
        _ => "Smart Beat could not finish the sign-in.",
    }
}

fn reply_now(mut stream: TcpStream, status: &str, body: &str) {
    let _ = stream.write_all(pages::http_response(status, body).as_bytes());
    let _ = stream.flush();
}

/// Handles one request. `None` for requests that are not the redirect (favicon, probes), which
/// get a 404 so the browser does not wait.
fn handle_redirect(
    stream: TcpStream,
    state: &str,
) -> Option<Result<(String, PendingReply), CommandError>> {
    stream.set_nonblocking(false).ok();
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return None;
    }
    let query = line
        .split_whitespace()
        .nth(1)
        .and_then(|target| target.split_once('?'))
        .map(|(_, q)| q);
    let Some(query) = query else {
        reply_now(stream, "404 Not Found", &pages::error_page("Nothing here."));
        return None;
    };
    let param = |name: &str| {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == name).then(|| percent_decode(v))
        })
    };
    if param("state").as_deref() != Some(state) {
        reply_now(
            stream,
            "200 OK",
            &pages::error_page("The sign-in answer did not match the request."),
        );
        return Some(Err(CommandError::new(
            ErrorKind::Io,
            "The sign-in answer did not match the request.",
        )));
    }
    if let Some(code) = param("code") {
        return Some(Ok((code, PendingReply { stream })));
    }
    let reason = if param("error").as_deref() == Some("access_denied") {
        "Access was declined."
    } else {
        "The provider reported a problem."
    };
    reply_now(stream, "200 OK", &pages::error_page(reason));
    Some(Err(CommandError::new(
        ErrorKind::Io,
        format!(
            "Sign-in was cancelled ({}).",
            param("error").unwrap_or_default()
        ),
    )))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn token_request(config: &OAuthConfig, form: &[(&str, &str)]) -> Result<Tokens, CommandError> {
    let secret = config
        .client_secret
        .as_deref()
        .map(|secret| ("client_secret", secret));
    let body = form
        .iter()
        .chain(secret.as_ref())
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let mut response = agent()
        .post(&config.token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body)
        .map_err(|e| match e {
            // A refused refresh token means access was revoked.
            ureq::Error::StatusCode(400 | 401) => CommandError::new(
                ErrorKind::AuthExpired,
                "The cloud sign-in expired or was revoked. Connect the account again.",
            ),
            other => super::http_error(other, "The sign-in"),
        })?;
    let parsed: TokenResponse = response.body_mut().read_json().map_err(|e| {
        CommandError::new(
            ErrorKind::Network,
            format!("Unexpected sign-in answer: {e}"),
        )
    })?;
    Ok(Tokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: parsed.expires_in.map_or(0, |s| now_secs() + s),
        account: String::new(),
    })
}

pub fn exchange_code(
    config: &OAuthConfig,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<Tokens, CommandError> {
    token_request(
        config,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
            ("client_id", &config.client_id),
        ],
    )
}

pub fn refresh(config: &OAuthConfig, refresh_token: &str) -> Result<Tokens, CommandError> {
    let mut tokens = token_request(
        config,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &config.client_id),
        ],
    )?;
    // Providers may omit a new refresh token: keep the old one.
    tokens
        .refresh_token
        .get_or_insert_with(|| refresh_token.to_owned());
    Ok(tokens)
}

/// Full sign-in: opens the browser through `open_browser`, waits for the redirect, exchanges
/// the code, stores the tokens in `store`.
pub fn sign_in(
    provider: &dyn Provider,
    config: &OAuthConfig,
    store: &dyn TokenStore,
    open_browser: impl FnOnce(&str) -> Result<(), CommandError>,
    timeout: Duration,
) -> Result<Tokens, CommandError> {
    let (verifier, challenge) = pkce()?;
    let state = random_token(16)?;
    let loopback = Loopback::bind_to(&config.redirect_ports)?;
    let redirect = loopback.redirect_uri_with(&config.redirect_host);
    open_browser(&authorize_url(config, &redirect, &state, &challenge))?;
    let (code, reply) = loopback.wait_for_code(&state, timeout)?;
    // The browser page is answered only now, so it reflects the real outcome.
    let finish = || -> Result<Tokens, CommandError> {
        let mut tokens = exchange_code(config, &code, &verifier, &redirect)?;
        tokens.account = provider.account_name(&tokens.access_token)?;
        store.save(provider.kind(), &tokens)?;
        Ok(tokens)
    };
    match finish() {
        Ok(tokens) => {
            reply.succeed(provider.kind().label());
            Ok(tokens)
        }
        Err(error) => {
            reply.fail(&error);
            Err(error)
        }
    }
}

/// Gives providers a valid access token, refreshing and re-storing it when it is about to expire.
pub struct Session<'a> {
    pub kind: ProviderKind,
    pub config: &'a OAuthConfig,
    pub store: &'a dyn TokenStore,
}

impl Session<'_> {
    pub fn token(&self) -> Result<String, CommandError> {
        let Some(tokens) = self.store.load(self.kind)? else {
            return Err(CommandError::new(
                ErrorKind::AuthExpired,
                format!("{} is not connected.", self.kind.label()),
            ));
        };
        if tokens.expires_at == 0 || tokens.expires_at > now_secs() + 60 {
            return Ok(tokens.access_token);
        }
        let Some(refresh_token) = tokens.refresh_token.clone() else {
            return Err(CommandError::new(
                ErrorKind::AuthExpired,
                "The cloud sign-in expired. Connect the account again.",
            ));
        };
        match refresh(self.config, &refresh_token) {
            Ok(mut fresh) => {
                fresh.account = tokens.account;
                self.store.save(self.kind, &fresh)?;
                Ok(fresh.access_token)
            }
            Err(e) => {
                if e.kind == ErrorKind::AuthExpired {
                    // Revoked in the provider: the local tokens go too.
                    self.store.delete(self.kind)?;
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn challenge_is_the_s256_of_the_verifier() {
        let (verifier, challenge) = pkce().unwrap();
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        assert!(verifier.len() >= 43);
    }

    #[test]
    fn authorize_url_carries_pkce_and_scope() {
        let config = OAuthConfig {
            client_id: "id".into(),
            client_secret: None,
            redirect_ports: Vec::new(),
            redirect_host: "127.0.0.1".into(),
            auth_url: "https://a.example/auth".into(),
            token_url: String::new(),
            scopes: vec!["one".into(), "two".into()],
            extra_auth_params: vec![("access_type".into(), "offline".into())],
        };
        let url = authorize_url(&config, "http://127.0.0.1:1/", "st", "ch");
        assert!(url.contains("code_challenge=ch&code_challenge_method=S256"));
        assert!(url.contains("scope=one%20two"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F"));
        assert!(url.ends_with("&access_type=offline"));
    }

    /// Sends a request like the browser; returns the answer once the server closes.
    fn browser_get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(stream, "GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    fn browser_hit(port: u16, query: &str) -> String {
        browser_get(port, &format!("/?{query}"))
    }

    /// A token endpoint on 127.0.0.1 that records the request body and answers with tokens.
    fn mock_token_endpoint() -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!(
            "http://127.0.0.1:{}/token",
            listener.local_addr().unwrap().port()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0usize;
            let mut line = String::new();
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let answer = r#"{"access_token":"a","refresh_token":"r","expires_in":3600}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
            String::from_utf8(body).unwrap()
        });
        (url, handle)
    }

    /// A token endpoint that answers every request with `status` and a provider error body.
    fn mock_failing_token_endpoint(status: u16) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!(
            "http://127.0.0.1:{}/token",
            listener.local_addr().unwrap().port()
        );
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let body = r#"{"error":"invalid_grant"}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        url
    }

    fn config_with(token_url: String, secret: Option<&str>) -> OAuthConfig {
        OAuthConfig {
            client_id: "the-id".into(),
            client_secret: secret.map(str::to_owned),
            redirect_ports: Vec::new(),
            redirect_host: "127.0.0.1".into(),
            auth_url: String::new(),
            token_url,
            scopes: Vec::new(),
            extra_auth_params: Vec::new(),
        }
    }

    #[test]
    fn token_requests_carry_the_client_secret_when_there_is_one() {
        let (url, handle) = mock_token_endpoint();
        exchange_code(
            &config_with(url, Some("s3cret")),
            "code",
            "ver",
            "http://127.0.0.1:1/",
        )
        .unwrap();
        let body = handle.join().unwrap();
        assert!(body.contains("client_secret=s3cret"), "{body}");
        assert!(body.contains("client_id=the-id"));
        assert!(body.contains("code_verifier=ver"));

        let (url, handle) = mock_token_endpoint();
        refresh(&config_with(url, Some("s3cret")), "old-refresh").unwrap();
        assert!(handle.join().unwrap().contains("client_secret=s3cret"));
    }

    #[test]
    fn token_requests_send_no_secret_without_one() {
        let (url, handle) = mock_token_endpoint();
        exchange_code(
            &config_with(url, None),
            "code",
            "ver",
            "http://127.0.0.1:1/",
        )
        .unwrap();
        assert!(!handle.join().unwrap().contains("client_secret"));
    }

    #[test]
    fn the_secret_is_not_printed() {
        let shown = format!("{:?}", config_with(String::new(), Some("s3cret")));
        assert!(!shown.contains("s3cret"));
        assert!(shown.contains("client_id"));
    }

    #[test]
    fn loopback_returns_the_code_and_answers_after_the_caller_does() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || browser_hit(port, "code=a%2Fb&state=s1"));
        let (code, reply) = loopback
            .wait_for_code("s1", Duration::from_secs(5))
            .unwrap();
        assert_eq!(code, "a/b");
        assert!(!t.is_finished(), "the page must wait for the exchange");
        reply.succeed("Google Drive");
        let answer = t.join().unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"));
        assert!(answer.contains("Cloud storage is <em>connected</em>"));
        assert!(answer.contains("Content-Security-Policy"));
    }

    #[test]
    fn loopback_ignores_the_favicon_and_keeps_waiting() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || {
            let favicon = browser_get(port, "/favicon.ico");
            assert!(favicon.starts_with("HTTP/1.1 404"));
            browser_hit(port, "code=c&state=s1")
        });
        let (code, reply) = loopback
            .wait_for_code("s1", Duration::from_secs(5))
            .unwrap();
        assert_eq!(code, "c");
        reply.succeed("OneDrive");
        t.join().unwrap();
    }

    #[test]
    fn loopback_rejects_a_wrong_state() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || browser_hit(port, "code=x&state=evil"));
        assert!(
            loopback
                .wait_for_code("s1", Duration::from_secs(5))
                .is_err()
        );
        let answer = t.join().unwrap();
        assert!(answer.contains("Sign-in did not <em>complete</em>"));
        assert!(!answer.contains("evil"));
    }

    #[test]
    fn loopback_reports_a_cancelled_sign_in() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || browser_hit(port, "error=access_denied&state=s1"));
        let error = loopback
            .wait_for_code("s1", Duration::from_secs(5))
            .err()
            .unwrap();
        assert!(error.message.contains("access_denied"));
        let answer = t.join().unwrap();
        assert!(answer.contains("Sign-in did not <em>complete</em>"));
        assert!(answer.contains("Access was declined."));
    }

    /// A provider whose account lookup works, for the full sign-in tests.
    struct FakeProvider;
    impl Provider for FakeProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Drive
        }
        fn account_name(&self, _token: &str) -> Result<String, CommandError> {
            Ok("ada@x.com".into())
        }
        fn list(&self, _t: &str) -> Result<Vec<super::super::RemoteFile>, CommandError> {
            unreachable!()
        }
        fn metadata(&self, _t: &str, _id: &str) -> Result<super::super::RemoteFile, CommandError> {
            unreachable!()
        }
        fn read(
            &self,
            _t: &str,
            _id: &str,
        ) -> Result<(Vec<u8>, super::super::RemoteFile), CommandError> {
            unreachable!()
        }
        fn write_if_revision(
            &self,
            _t: &str,
            _id: &str,
            _r: &str,
            _b: &[u8],
        ) -> Result<super::super::RemoteFile, CommandError> {
            unreachable!()
        }
        fn create(
            &self,
            _t: &str,
            _n: &str,
            _b: &[u8],
        ) -> Result<super::super::RemoteFile, CommandError> {
            unreachable!()
        }
        fn revoke(&self, _token: &str) -> Result<(), CommandError> {
            Ok(())
        }
    }

    /// Opens the "browser" on a thread that follows the redirect and returns the page.
    fn run_sign_in(
        token_url: String,
    ) -> (
        Result<Tokens, CommandError>,
        String,
        super::super::keychain::MemoryStore,
    ) {
        let store = super::super::keychain::MemoryStore::default();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let config = config_with(token_url, None);
        let result = sign_in(
            &FakeProvider,
            &config,
            &store,
            |url| {
                let state = url
                    .split('&')
                    .find_map(|p| p.strip_prefix("state="))
                    .unwrap()
                    .to_owned();
                let port: u16 = percent_decode(
                    url.split('&')
                        .find_map(|p| p.strip_prefix("redirect_uri="))
                        .unwrap(),
                )
                .rsplit(':')
                .next()
                .unwrap()
                .trim_end_matches('/')
                .parse()
                .unwrap();
                std::thread::spawn(move || {
                    tx.send(browser_hit(port, &format!("code=c&state={state}")))
                        .unwrap();
                });
                Ok(())
            },
            Duration::from_secs(10),
        );
        (result, rx.recv().unwrap(), store)
    }

    #[test]
    fn sign_in_shows_the_success_page_after_the_exchange() {
        let (url, handle) = mock_token_endpoint();
        let (result, page, store) = run_sign_in(url);
        handle.join().unwrap();
        assert_eq!(result.unwrap().account, "ada@x.com");
        assert!(page.contains("<em>connected</em>"));
        assert!(store.load(ProviderKind::Drive).unwrap().is_some());
    }

    #[test]
    fn sign_in_shows_the_failure_page_when_the_exchange_fails() {
        let url = mock_failing_token_endpoint(400);
        let (result, page, store) = run_sign_in(url);
        assert!(result.is_err());
        assert!(page.contains("Sign-in did not <em>complete</em>"));
        assert!(page.contains("The provider did not accept the sign-in."));
        assert!(!page.contains("<em>connected</em>"));
        assert!(!page.contains("invalid_grant"));
        assert!(store.load(ProviderKind::Drive).unwrap().is_none());
    }

    #[test]
    fn loopback_times_out() {
        let loopback = Loopback::bind().unwrap();
        let error = loopback
            .wait_for_code("s", Duration::from_millis(100))
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Network);
    }

    #[test]
    fn percent_decoding_handles_edges() {
        assert_eq!(percent_decode("a%2Fb+c"), "a/b c");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
