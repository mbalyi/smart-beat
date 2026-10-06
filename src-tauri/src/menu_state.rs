//! Keeps the native menu in step with the UI: "Undo Add Note" and "Redo"
//! labels, check marks for Edit Mode, Loop, Metronome, repeats and the note
//! effects at the edit cursor, and which items are available (nothing
//! song-related while no song is open, the Bar and Note menus only in edit
//! mode).
//!
//! The UI sends a [`MenuState`] whenever one of these changes; Rust works out
//! each item's text, enabled and checked state ([`item_states`]) and applies
//! them to the menu bar ([`apply`]).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItemKind};
use tauri::{AppHandle, Runtime};

use crate::error::{CommandError, ErrorKind};
use crate::menu::MenuAction;

/// Longest undo/redo label the UI may send ("Undo " + label).
pub const MAX_LABEL_CHARS: usize = 60;

/// The UI state the menu reflects. Mirrored by `MenuState` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    /// A song is open.
    pub song_open: bool,
    /// What Undo would undo (e.g. "Add Note"), or `None` when there is nothing.
    pub undo: Option<String>,
    /// What Redo would redo, or `None`.
    pub redo: Option<String>,
    /// The song has more than one track (so one can be removed).
    pub can_remove_track: bool,
    pub edit_mode: bool,
    pub fretboard: bool,
    #[serde(rename = "loop")]
    pub looping: bool,
    pub metronome: bool,
    pub count_in: bool,
    /// The bar at the edit cursor starts a repeat.
    #[serde(default)]
    pub repeat_start: bool,
    /// The bar at the edit cursor ends a repeat.
    #[serde(default)]
    pub repeat_end: bool,
    /// A note is under the edit cursor (or selected), so note effects apply.
    #[serde(default)]
    pub has_note: bool,
    /// Effects of the note under the edit cursor.
    #[serde(default)]
    pub note_effects: NoteEffects,
}

/// Which of the Note menu's effects the note at the edit cursor has.
/// Mirrored by `NoteEffectFlags` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteEffects {
    pub hammer_pull: bool,
    pub slide: bool,
    pub vibrato: bool,
    pub palm_mute: bool,
    pub let_ring: bool,
    pub dead_note: bool,
    pub ghost_note: bool,
    pub harmonic: bool,
    pub accent: bool,
    pub staccato: bool,
}

impl MenuState {
    /// Labels must be short, single-line text.
    pub fn validate(&self) -> Result<(), CommandError> {
        for label in [&self.undo, &self.redo].into_iter().flatten() {
            let chars = label.chars().count();
            if chars == 0 || chars > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
                return Err(CommandError::new(
                    ErrorKind::InvalidMenuState,
                    format!(
                        "Undo and redo labels must be 1–{MAX_LABEL_CHARS} characters of plain text."
                    ),
                ));
            }
        }
        Ok(())
    }
}

/// How one menu item should look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemState {
    pub action: MenuAction,
    pub text: String,
    pub enabled: bool,
    /// `Some` for check items.
    pub checked: Option<bool>,
}

/// "Undo Add Note", or plain "Undo" when there is nothing to undo.
pub fn history_text(action: MenuAction, label: Option<&str>) -> String {
    match label {
        Some(label) => format!("{} {label}", action.label()),
        None => action.label().to_string(),
    }
}

/// Whether a check item is on. Every check item has its own flag.
pub fn is_checked(state: &MenuState, action: MenuAction) -> bool {
    let effects = &state.note_effects;
    match action {
        MenuAction::ToggleEditMode => state.edit_mode,
        MenuAction::ToggleFretboard => state.fretboard,
        MenuAction::ToggleRepeatStart => state.repeat_start,
        MenuAction::ToggleRepeatEnd => state.repeat_end,
        MenuAction::ToggleHammerPull => effects.hammer_pull,
        MenuAction::ToggleSlide => effects.slide,
        MenuAction::ToggleVibrato => effects.vibrato,
        MenuAction::TogglePalmMute => effects.palm_mute,
        MenuAction::ToggleLetRing => effects.let_ring,
        MenuAction::ToggleDeadNote => effects.dead_note,
        MenuAction::ToggleGhostNote => effects.ghost_note,
        MenuAction::ToggleHarmonic => effects.harmonic,
        MenuAction::ToggleAccent => effects.accent,
        MenuAction::ToggleStaccato => effects.staccato,
        MenuAction::ToggleLoop => state.looping,
        MenuAction::ToggleMetronome => state.metronome,
        MenuAction::ToggleCountIn => state.count_in,
        _ => false,
    }
}

/// Text, enabled and checked state of every item that depends on the UI.
pub fn item_states(state: &MenuState) -> Vec<ItemState> {
    MenuAction::ALL
        .into_iter()
        .filter(|action| action.needs_song())
        .map(|action| {
            let song = state.song_open;
            let editing = song && state.edit_mode;
            let (text, enabled) = match action {
                MenuAction::Undo => (
                    history_text(action, state.undo.as_deref()),
                    song && state.undo.is_some(),
                ),
                MenuAction::Redo => (
                    history_text(action, state.redo.as_deref()),
                    song && state.redo.is_some(),
                ),
                MenuAction::RemoveTrack => (action.label().into(), song && state.can_remove_track),
                _ if action.needs_note() => (action.label().into(), editing && state.has_note),
                _ if action.needs_edit_mode() => (action.label().into(), editing),
                _ => (action.label().into(), song),
            };
            // Edit-mode items show no check marks while they are unavailable.
            let shown = if action.needs_edit_mode() {
                editing
            } else {
                song
            };
            let checked = action
                .is_toggle()
                .then_some(shown && is_checked(state, action));
            ItemState {
                action,
                text,
                enabled,
                checked,
            }
        })
        .collect()
}

/// The last state the UI sent. Stored as Tauri state.
#[derive(Debug, Default)]
pub struct MenuStateStore(Mutex<MenuState>);

impl MenuStateStore {
    pub fn get(&self) -> MenuState {
        self.0.lock().expect("menu state lock poisoned").clone()
    }

    pub fn set(&self, state: MenuState) {
        *self.0.lock().expect("menu state lock poisoned") = state;
    }
}

/// Finds an item anywhere in the menu (`Menu::get` only looks at the top level).
pub fn find_in<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> Option<MenuItemKind<R>> {
    for item in items {
        if item.id() == id {
            return Some(item);
        }
        if let Some(found) = item
            .as_submenu()
            .and_then(|submenu| find_in(submenu.items().ok()?, id))
        {
            return Some(found);
        }
    }
    None
}

/// Applies `state` to the app's menu bar. Does nothing without one (e.g. in tests).
pub fn apply<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<()> {
    match app.menu() {
        Some(menu) => apply_to(&menu, state),
        None => Ok(()),
    }
}

/// Applies `state` to `menu`: item texts, enabled states and check marks.
pub fn apply_to<R: Runtime>(menu: &Menu<R>, state: &MenuState) -> tauri::Result<()> {
    for item in item_states(state) {
        match find_in(menu.items()?, item.action.id()) {
            Some(MenuItemKind::MenuItem(menu_item)) => {
                menu_item.set_text(&item.text)?;
                menu_item.set_enabled(item.enabled)?;
            }
            Some(MenuItemKind::Check(check)) => {
                check.set_text(&item.text)?;
                check.set_enabled(item.enabled)?;
                check.set_checked(item.checked.unwrap_or(false))?;
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_for(items: &[ItemState], action: MenuAction) -> &ItemState {
        items.iter().find(|i| i.action == action).unwrap()
    }

    fn open_song() -> MenuState {
        MenuState {
            song_open: true,
            ..MenuState::default()
        }
    }

    #[test]
    fn save_export_and_editing_helpers_follow_the_song() {
        let song_items = [
            MenuAction::Save,
            MenuAction::SaveAs,
            MenuAction::ExportMusicXml,
            MenuAction::ExportMidi,
            MenuAction::ExportAlphaTex,
            MenuAction::ExportAsciiTab,
            MenuAction::Transpose,
        ];
        let closed = item_states(&MenuState::default());
        let open = item_states(&open_song());
        for action in song_items {
            assert!(!state_for(&closed, action).enabled, "{action:?} closed");
            assert!(state_for(&open, action).enabled, "{action:?} open");
        }
        // Fixing bar durations works on the edit cursor, like the rest of the Bar menu.
        assert!(!state_for(&open, MenuAction::FixBarDurations).enabled);
        let editing = item_states(&MenuState {
            edit_mode: true,
            ..open_song()
        });
        assert!(state_for(&editing, MenuAction::FixBarDurations).enabled);
        // Clear Menu belongs to the native Open Recent list, not to the UI state.
        assert!(
            !open
                .iter()
                .any(|item| item.action == MenuAction::ClearRecent)
        );
    }

    #[test]
    fn deserializes_the_ui_payload() {
        let state: MenuState = serde_json::from_value(serde_json::json!({
            "songOpen": true,
            "undo": "Add Note",
            "redo": null,
            "canRemoveTrack": true,
            "editMode": true,
            "fretboard": false,
            "loop": true,
            "metronome": false,
            "countIn": true,
        }))
        .unwrap();
        assert!(state.looping && state.count_in && state.edit_mode);
        assert_eq!(state.undo.as_deref(), Some("Add Note"));
    }

    #[test]
    fn without_a_song_everything_song_related_is_off() {
        let items = item_states(&MenuState {
            undo: Some("Add Note".into()),
            looping: true,
            ..MenuState::default()
        });
        assert!(items.iter().all(|i| !i.enabled));
        assert!(items.iter().all(|i| i.checked != Some(true)));
    }

    #[test]
    fn names_what_undo_and_redo_will_do() {
        let items = item_states(&MenuState {
            undo: Some("Add Note".into()),
            ..open_song()
        });
        let undo = state_for(&items, MenuAction::Undo);
        assert_eq!(undo.text, "Undo Add Note");
        assert!(undo.enabled);
        let redo = state_for(&items, MenuAction::Redo);
        assert_eq!(redo.text, "Redo");
        assert!(!redo.enabled);
        assert_eq!(undo.checked, None);
    }

    #[test]
    fn checks_the_settings_that_are_on() {
        let items = item_states(&MenuState {
            edit_mode: true,
            metronome: true,
            ..open_song()
        });
        assert_eq!(
            state_for(&items, MenuAction::ToggleEditMode).checked,
            Some(true)
        );
        assert_eq!(
            state_for(&items, MenuAction::ToggleMetronome).checked,
            Some(true)
        );
        assert_eq!(
            state_for(&items, MenuAction::ToggleLoop).checked,
            Some(false)
        );
        assert_eq!(
            state_for(&items, MenuAction::ToggleCountIn).checked,
            Some(false)
        );
        assert_eq!(
            state_for(&items, MenuAction::ToggleFretboard).checked,
            Some(false)
        );
        assert!(state_for(&items, MenuAction::AddTrack).enabled);
    }

    #[test]
    fn only_removes_a_track_when_another_one_is_left() {
        let items = item_states(&open_song());
        assert!(!state_for(&items, MenuAction::RemoveTrack).enabled);
        let items = item_states(&MenuState {
            can_remove_track: true,
            ..open_song()
        });
        assert!(state_for(&items, MenuAction::RemoveTrack).enabled);
    }

    #[test]
    fn covers_exactly_the_song_items() {
        let items = item_states(&open_song());
        let expected: Vec<_> = MenuAction::ALL
            .into_iter()
            .filter(|a| a.needs_song())
            .collect();
        assert_eq!(items.iter().map(|i| i.action).collect::<Vec<_>>(), expected);
    }

    #[test]
    fn validates_labels() {
        assert!(open_song().validate().is_ok());
        let long = "x".repeat(MAX_LABEL_CHARS + 1);
        for bad in ["", "Add\nNote", long.as_str()] {
            let state = MenuState {
                undo: Some(bad.into()),
                ..open_song()
            };
            assert_eq!(
                state.validate().unwrap_err().kind,
                ErrorKind::InvalidMenuState
            );
        }
        let ok = MenuState {
            redo: Some("Paste «4 beats» — über".into()),
            ..open_song()
        };
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn deserializes_edit_mode_details_and_defaults_them() {
        let state: MenuState = serde_json::from_value(serde_json::json!({
            "songOpen": true,
            "undo": null,
            "redo": null,
            "canRemoveTrack": false,
            "editMode": true,
            "fretboard": false,
            "loop": false,
            "metronome": false,
            "countIn": false,
            "repeatStart": true,
            "hasNote": true,
            "noteEffects": { "palmMute": true, "deadNote": true },
        }))
        .unwrap();
        assert!(state.repeat_start && !state.repeat_end && state.has_note);
        assert!(state.note_effects.palm_mute && state.note_effects.dead_note);
        assert!(!state.note_effects.vibrato);

        // Older payloads without them still work.
        let old: MenuState = serde_json::from_value(serde_json::json!({
            "songOpen": true, "undo": null, "redo": null, "canRemoveTrack": false,
            "editMode": false, "fretboard": false, "loop": false, "metronome": false,
            "countIn": false,
        }))
        .unwrap();
        assert_eq!(old.note_effects, NoteEffects::default());
    }

    #[test]
    fn every_check_item_has_its_own_flag() {
        // Turn on one flag at a time: exactly one check item follows it.
        let mut flags: Vec<MenuState> = Vec::new();
        let base = MenuState {
            edit_mode: true,
            has_note: true,
            ..open_song()
        };
        for set in [
            |s: &mut MenuState| s.fretboard = true,
            |s: &mut MenuState| s.repeat_start = true,
            |s: &mut MenuState| s.repeat_end = true,
            |s: &mut MenuState| s.looping = true,
            |s: &mut MenuState| s.metronome = true,
            |s: &mut MenuState| s.count_in = true,
            |s: &mut MenuState| s.note_effects.hammer_pull = true,
            |s: &mut MenuState| s.note_effects.slide = true,
            |s: &mut MenuState| s.note_effects.vibrato = true,
            |s: &mut MenuState| s.note_effects.palm_mute = true,
            |s: &mut MenuState| s.note_effects.let_ring = true,
            |s: &mut MenuState| s.note_effects.dead_note = true,
            |s: &mut MenuState| s.note_effects.ghost_note = true,
            |s: &mut MenuState| s.note_effects.harmonic = true,
            |s: &mut MenuState| s.note_effects.accent = true,
            |s: &mut MenuState| s.note_effects.staccato = true,
        ] {
            let mut state = base.clone();
            set(&mut state);
            flags.push(state);
        }
        let mut checked_items = Vec::new();
        for state in &flags {
            let on: Vec<_> = item_states(state)
                .into_iter()
                .filter(|i| i.checked == Some(true) && i.action != MenuAction::ToggleEditMode)
                .map(|i| i.action)
                .collect();
            assert_eq!(on.len(), 1, "{state:?} checks {on:?}");
            checked_items.push(on[0]);
        }
        // Together they cover every check item except Edit Mode (on in `base`).
        let toggles = MenuAction::ALL
            .into_iter()
            .filter(|a| a.is_toggle() && *a != MenuAction::ToggleEditMode)
            .count();
        checked_items.sort_by_key(|a| a.id());
        checked_items.dedup();
        assert_eq!(checked_items.len(), toggles);
    }

    #[test]
    fn bar_and_note_items_need_edit_mode_and_notes_need_a_note() {
        let browsing = item_states(&MenuState {
            repeat_start: true,
            has_note: true,
            ..open_song()
        });
        assert!(!state_for(&browsing, MenuAction::BarSettings).enabled);
        assert!(!state_for(&browsing, MenuAction::Chord).enabled);
        assert_eq!(
            state_for(&browsing, MenuAction::ToggleRepeatStart).checked,
            Some(false)
        );
        assert!(state_for(&browsing, MenuAction::Lyrics).enabled);
        assert!(state_for(&browsing, MenuAction::ScaleTool).enabled);

        let on_a_rest = item_states(&MenuState {
            edit_mode: true,
            ..open_song()
        });
        assert!(state_for(&on_a_rest, MenuAction::BarSettings).enabled);
        assert!(state_for(&on_a_rest, MenuAction::Text).enabled);
        assert!(!state_for(&on_a_rest, MenuAction::Bend).enabled);
        assert!(!state_for(&on_a_rest, MenuAction::TogglePalmMute).enabled);

        let on_a_note = item_states(&MenuState {
            edit_mode: true,
            has_note: true,
            note_effects: NoteEffects {
                palm_mute: true,
                ..NoteEffects::default()
            },
            ..open_song()
        });
        assert!(state_for(&on_a_note, MenuAction::Bend).enabled);
        let palm_mute = state_for(&on_a_note, MenuAction::TogglePalmMute);
        assert!(palm_mute.enabled);
        assert_eq!(palm_mute.checked, Some(true));
        assert_eq!(
            state_for(&on_a_note, MenuAction::ToggleVibrato).checked,
            Some(false)
        );
    }

    #[test]
    fn stores_the_last_state() {
        let store = MenuStateStore::default();
        assert_eq!(store.get(), MenuState::default());
        store.set(open_song());
        assert!(store.get().song_open);
    }
}
