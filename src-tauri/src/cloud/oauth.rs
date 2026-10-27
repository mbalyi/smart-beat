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
use super::{Provider, ProviderKind, Tokens, agent, encode};
use crate::cloud_folder::now_secs;
use crate::error::{CommandError, ErrorKind};

/// A provider's OAuth endpoints and the app's registration.
#[derive(Debug, Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub auth_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    /// Extra authorization parameters (`access_type=offline`, `token_access_type=offline`, ...).
    pub extra_auth_params: Vec<(String, String)>,
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
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| {
            CommandError::new(ErrorKind::Io, format!("The sign-in could not start: {e}"))
        })?;
        listener.set_nonblocking(true).ok();
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map_or(0, |a| a.port())
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port())
    }

    /// Waits for the browser redirect and returns the authorization code. Checks `state`.
    pub fn wait_for_code(&self, state: &str, timeout: Duration) -> Result<String, CommandError> {
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

/// Answers one request; `None` for requests that are not the redirect (favicon, probes).
fn handle_redirect(mut stream: TcpStream, state: &str) -> Option<Result<String, CommandError>> {
    stream.set_nonblocking(false).ok();
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    let param = |name: &str| {
        query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == name).then(|| percent_decode(v))
        })
    };
    let result = if param("state").as_deref() != Some(state) {
        Err(CommandError::new(
            ErrorKind::Io,
            "The sign-in answer did not match the request.",
        ))
    } else if let Some(code) = param("code") {
        Ok(code)
    } else {
        Err(CommandError::new(
            ErrorKind::Io,
            format!(
                "Sign-in was cancelled ({}).",
                param("error").unwrap_or_default()
            ),
        ))
    };
    let body = if result.is_ok() {
        "You are signed in. You can close this tab and return to Smart Beat."
    } else {
        "Sign-in did not complete. You can close this tab and try again in Smart Beat."
    };
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    Some(result)
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
    let body = form
        .iter()
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
    let loopback = Loopback::bind()?;
    let redirect = loopback.redirect_uri();
    open_browser(&authorize_url(config, &redirect, &state, &challenge))?;
    let code = loopback.wait_for_code(&state, timeout)?;
    let mut tokens = exchange_code(config, &code, &verifier, &redirect)?;
    tokens.account = provider.account_name(&tokens.access_token)?;
    store.save(provider.kind(), &tokens)?;
    Ok(tokens)
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

    fn browser_hit(port: u16, query: &str) {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        write!(stream, "GET /?{query} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn loopback_returns_the_code_for_the_right_state() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || browser_hit(port, "code=a%2Fb&state=s1"));
        let code = loopback
            .wait_for_code("s1", Duration::from_secs(5))
            .unwrap();
        t.join().unwrap();
        assert_eq!(code, "a/b");
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
        t.join().unwrap();
    }

    #[test]
    fn loopback_reports_a_cancelled_sign_in() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let t = std::thread::spawn(move || browser_hit(port, "error=access_denied&state=s1"));
        let error = loopback
            .wait_for_code("s1", Duration::from_secs(5))
            .unwrap_err();
        t.join().unwrap();
        assert!(error.message.contains("access_denied"));
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
