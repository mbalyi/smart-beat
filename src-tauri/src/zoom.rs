//! Webview zoom levels for View → Zoom In / Zoom Out / Actual Size.

use std::sync::Mutex;

/// Zoom steps, matching what browsers offer.
pub const LEVELS: [f64; 13] = [
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];
pub const DEFAULT: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoomChange {
    In,
    Out,
    Reset,
}

/// Next zoom level after `change`, clamped to [`LEVELS`].
pub fn next_level(current: f64, change: ZoomChange) -> f64 {
    const EPSILON: f64 = 1e-6;
    match change {
        ZoomChange::In => LEVELS
            .into_iter()
            .find(|level| *level > current + EPSILON)
            .unwrap_or(LEVELS[LEVELS.len() - 1]),
        ZoomChange::Out => LEVELS
            .into_iter()
            .rev()
            .find(|level| *level < current - EPSILON)
            .unwrap_or(LEVELS[0]),
        ZoomChange::Reset => DEFAULT,
    }
}

/// Current zoom level, stored as Tauri managed state.
#[derive(Debug)]
pub struct ZoomState(Mutex<f64>);

impl Default for ZoomState {
    fn default() -> Self {
        Self(Mutex::new(DEFAULT))
    }
}

impl ZoomState {
    pub fn level(&self) -> f64 {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Applies `change` and returns the new level.
    pub fn apply(&self, change: ZoomChange) -> f64 {
        let mut level = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *level = next_level(*level, change);
        *level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_through_levels() {
        assert_eq!(next_level(1.0, ZoomChange::In), 1.1);
        assert_eq!(next_level(1.0, ZoomChange::Out), 0.9);
        assert_eq!(next_level(0.9, ZoomChange::In), 1.0);
    }

    #[test]
    fn clamps_at_bounds() {
        assert_eq!(next_level(3.0, ZoomChange::In), 3.0);
        assert_eq!(next_level(0.5, ZoomChange::Out), 0.5);
    }

    #[test]
    fn snaps_off_grid_values_to_the_next_level() {
        assert_eq!(next_level(1.05, ZoomChange::In), 1.1);
        assert_eq!(next_level(1.05, ZoomChange::Out), 1.0);
    }

    #[test]
    fn reset_returns_to_default() {
        assert_eq!(next_level(2.5, ZoomChange::Reset), DEFAULT);
    }

    #[test]
    fn state_tracks_changes() {
        let state = ZoomState::default();
        assert_eq!(state.level(), 1.0);
        assert_eq!(state.apply(ZoomChange::In), 1.1);
        assert_eq!(state.apply(ZoomChange::In), 1.25);
        assert_eq!(state.apply(ZoomChange::Reset), 1.0);
        assert_eq!(state.level(), 1.0);
    }
}
