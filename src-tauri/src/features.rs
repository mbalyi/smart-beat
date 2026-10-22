//! Feature flags from `src/lib/features.json`, the file the UI reads too. A feature that is
//! `false` stays out of reach and shows as "AI coming soon" in the AI menu.
use std::collections::BTreeMap;

const FEATURES: &str = include_str!("../../src/lib/features.json");

/// Menu names of the flags, in menu order.
const LABELS: [(&str, &str); 5] = [
    ("audio-2-tab", "Audio to Tab"),
    ("muscriptor-record", "Recording to Tab with AI"),
    ("record-2-tab", "Recording to Tab"),
    ("speech-2-tab", "Speech to Tab"),
    ("hum-2-accompaniment", "Hum to Accompaniment"),
];

fn flags() -> BTreeMap<String, bool> {
    serde_json::from_str(FEATURES).expect("src/lib/features.json is a map of booleans")
}

/// Whether a feature is switched on. An unknown name is off.
pub fn enabled(id: &str) -> bool {
    flags().get(id).copied().unwrap_or(false)
}

/// The id and menu name of every feature that is still off.
pub fn coming_soon() -> Vec<(&'static str, &'static str)> {
    LABELS.into_iter().filter(|(id, _)| !enabled(id)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_flag_has_a_menu_name() {
        for id in flags().keys() {
            assert!(LABELS.iter().any(|(label_id, _)| label_id == id), "{id}");
        }
        assert_eq!(flags().len(), LABELS.len());
    }

    #[test]
    fn unknown_features_are_off() {
        assert!(!enabled("not-a-feature"));
    }
}
