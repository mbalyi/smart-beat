//! Reads the git-ignored `.env` file at the repository root during the local build (#187).
//!
//! `build.rs` includes this file and passes the cloud client IDs and the Google client secret
//! to the compiler, where `option_env!` picks them up. The release pipeline sets the same names
//! as real environment variables, which win over the file.

/// Names the build takes from `.env`. Anything else in the file is ignored.
pub const KEYS: [&str; 4] = [
    "SMARTBEAT_GOOGLE_CLIENT_ID",
    "SMARTBEAT_GOOGLE_CLIENT_SECRET",
    "SMARTBEAT_MICROSOFT_CLIENT_ID",
    "SMARTBEAT_DROPBOX_CLIENT_ID",
];

/// The `KEY=value` pairs of the known [`KEYS`] in `text`, skipping blank values. Supports
/// comments (`#`), an optional `export ` prefix and single or double quotes around the value.
pub fn parse(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        for quote in ['"', '\''] {
            if let Some(inner) = value
                .strip_prefix(quote)
                .and_then(|rest| rest.strip_suffix(quote))
            {
                value = inner;
            }
        }
        if value.is_empty() || !KEYS.contains(&key) {
            continue;
        }
        pairs.push((key.to_owned(), value.to_owned()));
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_known_keys_and_skips_the_rest() {
        let text = "# cloud\nSMARTBEAT_GOOGLE_CLIENT_ID=abc\nOTHER=1\n\nexport SMARTBEAT_DROPBOX_CLIENT_ID=\"def\"\nSMARTBEAT_MICROSOFT_CLIENT_ID='ghi'\n";
        assert_eq!(
            parse(text),
            [
                ("SMARTBEAT_GOOGLE_CLIENT_ID".to_owned(), "abc".to_owned()),
                ("SMARTBEAT_DROPBOX_CLIENT_ID".to_owned(), "def".to_owned()),
                ("SMARTBEAT_MICROSOFT_CLIENT_ID".to_owned(), "ghi".to_owned()),
            ]
        );
    }

    #[test]
    fn blank_values_and_comments_are_skipped() {
        assert!(
            parse("SMARTBEAT_GOOGLE_CLIENT_SECRET=\n# SMARTBEAT_GOOGLE_CLIENT_ID=x").is_empty()
        );
    }

    #[test]
    fn values_may_contain_equals_signs() {
        assert_eq!(parse("SMARTBEAT_GOOGLE_CLIENT_SECRET=a=b==")[0].1, "a=b==");
    }
}
