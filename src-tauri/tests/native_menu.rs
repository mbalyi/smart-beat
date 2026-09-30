//! The real native menu bar (built with muda, as in the app) following the
//! UI's menu state: labels, enabled items and check marks.
//!
//! macOS only allows menu items on the main thread, so this test binary has
//! no test harness (see `Cargo.toml`): `main` runs on the main thread.

use smart_beat_lib::menu::{self, MenuAction};
use smart_beat_lib::menu_state::{self, MenuState, NoteEffects, find_in};
use tauri::menu::{Menu, MenuItemKind};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

/// A check run against the menu, with its name for the report.
type MenuTest = (&'static str, fn(&Menu<MockRuntime>));

fn item(menu: &Menu<MockRuntime>, action: MenuAction) -> MenuItemKind<MockRuntime> {
    find_in(menu.items().unwrap(), action.id())
        .unwrap_or_else(|| panic!("{action:?} is not in the menu"))
}

/// (enabled, checked) of a check item.
fn check(menu: &Menu<MockRuntime>, action: MenuAction) -> (bool, bool) {
    let item = item(menu, action);
    let check = item
        .as_check_menuitem()
        .unwrap_or_else(|| panic!("{action:?} is not a check item"));
    (check.is_enabled().unwrap(), check.is_checked().unwrap())
}

fn enabled(menu: &Menu<MockRuntime>, action: MenuAction) -> bool {
    match item(menu, action) {
        MenuItemKind::MenuItem(item) => item.is_enabled().unwrap(),
        MenuItemKind::Check(item) => item.is_enabled().unwrap(),
        _ => panic!("{action:?} is not an item"),
    }
}

fn every_custom_item_is_in_the_menu(menu: &Menu<MockRuntime>) {
    for action in MenuAction::ALL {
        let native_mac_item = cfg!(target_os = "macos")
            && matches!(action, MenuAction::CloseWindow | MenuAction::Quit);
        if native_mac_item {
            continue; // predefined items on macOS
        }
        let found = item(menu, action);
        assert_eq!(
            found.as_check_menuitem().is_some(),
            action.is_toggle(),
            "{action:?}"
        );
    }
}

fn song_items_start_disabled(menu: &Menu<MockRuntime>) {
    for action in MenuAction::ALL.into_iter().filter(|a| a.needs_song()) {
        assert!(!enabled(menu, action), "{action:?} enabled without a song");
    }
    assert!(enabled(menu, MenuAction::Open));
}

fn follows_the_state_in_edit_mode(menu: &Menu<MockRuntime>) {
    let state = MenuState {
        song_open: true,
        undo: Some("Add palm mute".into()),
        edit_mode: true,
        repeat_end: true,
        has_note: true,
        note_effects: NoteEffects {
            palm_mute: true,
            ..NoteEffects::default()
        },
        ..MenuState::default()
    };
    menu_state::apply_to(menu, &state).unwrap();

    let undo = item(menu, MenuAction::Undo);
    assert_eq!(
        undo.as_menuitem().unwrap().text().unwrap(),
        "Undo Add palm mute"
    );
    assert!(enabled(menu, MenuAction::Undo));
    assert!(!enabled(menu, MenuAction::Redo));
    assert!(enabled(menu, MenuAction::BarSettings));
    assert!(enabled(menu, MenuAction::Chord));
    assert_eq!(check(menu, MenuAction::ToggleEditMode), (true, true));
    assert_eq!(check(menu, MenuAction::ToggleRepeatEnd), (true, true));
    assert_eq!(check(menu, MenuAction::ToggleRepeatStart), (true, false));
    assert_eq!(check(menu, MenuAction::TogglePalmMute), (true, true));
    assert_eq!(check(menu, MenuAction::ToggleVibrato), (true, false));
    assert_eq!(check(menu, MenuAction::ToggleCountIn), (true, false));
}

fn disables_the_edit_menus_outside_edit_mode(menu: &Menu<MockRuntime>) {
    let state = MenuState {
        song_open: true,
        has_note: true,
        note_effects: NoteEffects {
            palm_mute: true,
            ..NoteEffects::default()
        },
        ..MenuState::default()
    };
    menu_state::apply_to(menu, &state).unwrap();

    assert_eq!(check(menu, MenuAction::TogglePalmMute), (false, false));
    assert!(!enabled(menu, MenuAction::BarSettings));
    assert!(!enabled(menu, MenuAction::Bend));
    assert!(enabled(menu, MenuAction::Lyrics));
    assert!(enabled(menu, MenuAction::ScaleTool));
    let undo = item(menu, MenuAction::Undo);
    assert_eq!(undo.as_menuitem().unwrap().text().unwrap(), "Undo");
}

fn main() {
    let app = smart_beat_lib::setup(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build app");
    let menu = menu::build(app.handle()).expect("the menu builds");

    let tests: [MenuTest; 4] = [
        (
            "every_custom_item_is_in_the_menu",
            every_custom_item_is_in_the_menu,
        ),
        ("song_items_start_disabled", song_items_start_disabled),
        (
            "follows_the_state_in_edit_mode",
            follows_the_state_in_edit_mode,
        ),
        (
            "disables_the_edit_menus_outside_edit_mode",
            disables_the_edit_menus_outside_edit_mode,
        ),
    ];
    for (name, test) in tests {
        test(&menu);
        println!("test {name} ... ok");
    }
    println!("\ntest result: ok. {} passed", tests.len());
}
