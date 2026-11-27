//! The pure parts of "Host a network" (#258): a network name, a password and the Wi-Fi QR code
//! text a phone or laptop camera can join with.

/// Every hosted network's name starts with this, so it is easy to find in a Wi-Fi list.
pub const SSID_PREFIX: &str = "SmartBeat-";
/// Random characters after the prefix.
const SSID_SUFFIX_LEN: usize = 4;
/// Password length: WPA2 needs 8 to 63 printable ASCII characters. 12 characters from a
/// 31-letter alphabet are about 59 bits, plenty for a network that lives for one session.
pub const PASSPHRASE_LEN: usize = 12;
/// WPA2 limits.
pub const MIN_PASSPHRASE: usize = 8;
pub const MAX_PASSPHRASE: usize = 63;
pub const MAX_SSID_BYTES: usize = 32;
/// Letters and digits without look-alikes (no 0/o, 1/l/i), easy to type on a phone.
const PASSPHRASE_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const SSID_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/// Characters the Wi-Fi QR format needs escaped with a backslash.
const QR_SPECIAL: &[char] = &['\\', ';', ',', ':', '"'];

/// `len` characters of `alphabet`, chosen with the system's random numbers. Bytes that would make
/// some characters likelier than others are thrown away (rejection sampling).
pub fn random_text(alphabet: &[u8], len: usize) -> String {
    debug_assert!(!alphabet.is_empty() && alphabet.len() <= 256);
    let limit = 256 - 256 % alphabet.len();
    let mut out = String::with_capacity(len);
    let mut pool = [0u8; 64];
    while out.len() < len {
        // A failure to read randomness is not recoverable; a fixed password would be guessable.
        getrandom::fill(&mut pool).expect("system random numbers");
        for &byte in pool.iter().filter(|&&b| usize::from(b) < limit) {
            if out.len() == len {
                break;
            }
            out.push(char::from(alphabet[usize::from(byte) % alphabet.len()]));
        }
    }
    out
}

/// A new network name, like `SmartBeat-K7QD`.
pub fn new_ssid() -> String {
    format!(
        "{SSID_PREFIX}{}",
        random_text(SSID_ALPHABET, SSID_SUFFIX_LEN)
    )
}

/// A new WPA2 password.
pub fn new_passphrase() -> String {
    random_text(PASSPHRASE_ALPHABET, PASSPHRASE_LEN)
}

/// Whether `text` is a password WPA2-Personal accepts: 8 to 63 printable ASCII characters.
pub fn valid_passphrase(text: &str) -> bool {
    (MIN_PASSPHRASE..=MAX_PASSPHRASE).contains(&text.len())
        && text.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// Escapes `\ ; , : "` for the Wi-Fi QR format.
fn escape_qr(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if QR_SPECIAL.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The text of a Wi-Fi QR code for a WPA network: `WIFI:T:WPA;S:<name>;P:<password>;;`.
pub fn wifi_qr(ssid: &str, passphrase: &str) -> String {
    format!(
        "WIFI:T:WPA;S:{};P:{};;",
        escape_qr(ssid),
        escape_qr(passphrase)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_network_name_is_short_and_recognisable() {
        let ssid = new_ssid();
        assert!(ssid.starts_with(SSID_PREFIX), "{ssid}");
        assert!(ssid.len() <= MAX_SSID_BYTES);
        assert_eq!(ssid.len(), SSID_PREFIX.len() + SSID_SUFFIX_LEN);
        assert!(ssid.is_ascii());
        assert_ne!(
            new_ssid(),
            new_ssid(),
            "names differ (one in a million chance)"
        );
    }

    #[test]
    fn a_new_password_is_valid_for_wpa2_and_random() {
        for _ in 0..200 {
            let pass = new_passphrase();
            assert!(valid_passphrase(&pass), "{pass}");
            assert_eq!(pass.len(), PASSPHRASE_LEN);
            assert!(pass.bytes().all(|b| PASSPHRASE_ALPHABET.contains(&b)));
        }
        assert_ne!(new_passphrase(), new_passphrase());
    }

    #[test]
    fn every_letter_of_the_alphabet_turns_up() {
        let text = random_text(PASSPHRASE_ALPHABET, 4000);
        for &c in PASSPHRASE_ALPHABET {
            assert!(text.contains(char::from(c)), "{}", char::from(c));
        }
    }

    #[test]
    fn wpa2_password_rules() {
        assert!(!valid_passphrase("short"));
        assert!(valid_passphrase("eightchr"));
        assert!(valid_passphrase(&"a".repeat(63)));
        assert!(!valid_passphrase(&"a".repeat(64)));
        assert!(!valid_passphrase("tab\there!"));
        assert!(!valid_passphrase("ünïcode-pass"));
    }

    #[test]
    fn the_wifi_qr_text_names_the_network_and_password() {
        assert_eq!(
            wifi_qr("SmartBeat-K7QD", "abcd2345efgh"),
            "WIFI:T:WPA;S:SmartBeat-K7QD;P:abcd2345efgh;;"
        );
    }

    #[test]
    fn the_wifi_qr_text_escapes_special_characters() {
        assert_eq!(
            wifi_qr(r#"My;Net,"1":\"#, r"p;a,s:s\w"),
            r#"WIFI:T:WPA;S:My\;Net\,\"1\"\:\\;P:p\;a\,s\:s\\w;;"#
        );
    }
}
