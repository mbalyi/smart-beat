//! Native application menu (File / Edit / View / Help).
//!
//! Custom menu items are described by [`MenuAction`]. Actions that only touch
//! the native window (zoom, full screen, close, quit) are handled in Rust;
//! everything else is forwarded to the webview as a [`MENU_EVENT`] event so the
//! UI can react (open a dialog, switch theme, ...).

use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::zoom::{ZoomChange, ZoomState};

/// Event name used to forward menu actions to the webview.
pub const MENU_EVENT: &str = "menu-action";

/// Label of the window created from `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Every custom (non-predefined) menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuAction {
    Open,
    CloseWindow,
    Quit,
    ToggleTheme,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    ToggleFullscreen,
    Shortcuts,
    Licenses,
    About,
}

impl MenuAction {
    pub const ALL: [Self; 11] = [
        Self::Open,
        Self::CloseWindow,
        Self::Quit,
        Self::ToggleTheme,
        Self::ZoomIn,
        Self::ZoomOut,
        Self::ZoomReset,
        Self::ToggleFullscreen,
        Self::Shortcuts,
        Self::Licenses,
        Self::About,
    ];

    /// Stable menu item id.
    pub fn id(self) -> &'static str {
        match self {
            Self::Open => "file.open",
            Self::CloseWindow => "file.close-window",
            Self::Quit => "file.quit",
            Self::ToggleTheme => "view.toggle-theme",
            Self::ZoomIn => "view.zoom-in",
            Self::ZoomOut => "view.zoom-out",
            Self::ZoomReset => "view.zoom-reset",
            Self::ToggleFullscreen => "view.toggle-fullscreen",
            Self::Shortcuts => "help.shortcuts",
            Self::Licenses => "help.licenses",
            Self::About => "help.about",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }

    /// Title of the submenu the item lives in (the macOS app menu counts as "Smart Beat").
    pub fn menu(self) -> &'static str {
        match self {
            Self::Open | Self::CloseWindow | Self::Quit => "File",
            Self::ToggleTheme
            | Self::ZoomIn
            | Self::ZoomOut
            | Self::ZoomReset
            | Self::ToggleFullscreen => "View",
            Self::Shortcuts | Self::Licenses | Self::About => "Help",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Open => "Open…",
            Self::CloseWindow => "Close Window",
            Self::Quit => "Quit Smart Beat",
            Self::ToggleTheme => "Toggle Dark Mode",
            Self::ZoomIn => "Zoom In",
            Self::ZoomOut => "Zoom Out",
            Self::ZoomReset => "Actual Size",
            Self::ToggleFullscreen => "Toggle Full Screen",
            Self::Shortcuts => "Keyboard Shortcuts",
            Self::Licenses => "Open-Source Licenses",
            Self::About => "About Smart Beat",
        }
    }

    /// Accelerator in Tauri syntax for the given `std::env::consts::OS` value.
    pub fn accelerator_for(self, os: &str) -> Option<&'static str> {
        match self {
            Self::Open => Some("CmdOrCtrl+O"),
            Self::CloseWindow => Some("CmdOrCtrl+W"),
            Self::Quit => Some("CmdOrCtrl+Q"),
            Self::ToggleTheme => Some("CmdOrCtrl+Shift+L"),
            Self::ZoomIn => Some("CmdOrCtrl+="),
            Self::ZoomOut => Some("CmdOrCtrl+-"),
            Self::ZoomReset => Some("CmdOrCtrl+0"),
            Self::ToggleFullscreen if os == "macos" => Some("Ctrl+Cmd+F"),
            Self::ToggleFullscreen => Some("F11"),
            Self::Shortcuts => Some("CmdOrCtrl+/"),
            Self::Licenses | Self::About => None,
        }
    }

    pub fn accelerator(self) -> Option<&'static str> {
        self.accelerator_for(std::env::consts::OS)
    }

    /// Whether the action is handled in Rust rather than forwarded to the webview.
    pub fn is_native(self) -> bool {
        matches!(
            self,
            Self::CloseWindow
                | Self::Quit
                | Self::ZoomIn
                | Self::ZoomOut
                | Self::ZoomReset
                | Self::ToggleFullscreen
        )
    }
}

/// A keyboard shortcut as shown in the "Keyboard Shortcuts" dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub action: MenuAction,
    pub menu: &'static str,
    pub label: &'static str,
    /// Key caps to render, in platform order (e.g. `["⇧", "⌘", "L"]`).
    pub keys: Vec<String>,
    /// Screen-reader friendly description (e.g. `"Shift+Command+L"`).
    pub spoken: String,
}

/// All menu shortcuts for the given OS, in menu order.
pub fn shortcuts(os: &str) -> Vec<Shortcut> {
    MenuAction::ALL
        .into_iter()
        .filter_map(|action| {
            let (keys, spoken) = format_accelerator(action.accelerator_for(os)?, os);
            Some(Shortcut {
                action,
                menu: action.menu(),
                label: action.label(),
                keys,
                spoken,
            })
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Modifier {
    Control,
    Alt,
    Shift,
    Command,
}

/// Turns a Tauri accelerator such as `CmdOrCtrl+Shift+L` into key caps and a
/// spoken label, following each platform's conventions (macOS uses the
/// ⌃⌥⇧⌘ glyph order, other platforms `Ctrl+Alt+Shift`).
pub fn format_accelerator(accelerator: &str, os: &str) -> (Vec<String>, String) {
    let mac = os == "macos";
    let mut modifiers = Vec::new();
    let mut key = None;

    for token in accelerator.split('+').filter(|t| !t.is_empty()) {
        match token.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "commandorctrl" | "cmdorcontrol" => {
                modifiers.push(if mac {
                    Modifier::Command
                } else {
                    Modifier::Control
                })
            }
            "cmd" | "command" | "super" | "meta" => modifiers.push(Modifier::Command),
            "ctrl" | "control" => modifiers.push(Modifier::Control),
            "alt" | "option" => modifiers.push(Modifier::Alt),
            "shift" => modifiers.push(Modifier::Shift),
            _ => key = Some(token),
        }
    }
    // A trailing "+" means the key itself is the plus sign ("CmdOrCtrl++").
    let key = key.unwrap_or(if accelerator.ends_with('+') { "+" } else { "" });
    modifiers.sort();
    modifiers.dedup();

    let mut keys: Vec<String> = modifiers
        .iter()
        .map(|m| {
            match (m, mac) {
                (Modifier::Control, true) => "⌃",
                (Modifier::Alt, true) => "⌥",
                (Modifier::Shift, true) => "⇧",
                (Modifier::Command, true) => "⌘",
                (Modifier::Control, false) => "Ctrl",
                (Modifier::Alt, false) => "Alt",
                (Modifier::Shift, false) => "Shift",
                (Modifier::Command, false) => "Win",
            }
            .to_string()
        })
        .collect();
    keys.push(key.to_uppercase());

    let mut spoken: Vec<&str> = modifiers
        .iter()
        .map(|m| match (m, mac) {
            (Modifier::Control, _) => "Control",
            (Modifier::Alt, true) => "Option",
            (Modifier::Alt, false) => "Alt",
            (Modifier::Shift, _) => "Shift",
            (Modifier::Command, true) => "Command",
            (Modifier::Command, false) => "Windows",
        })
        .collect();
    let spoken_key = match key {
        "=" => "Equals".to_string(),
        "-" => "Minus".to_string(),
        "+" => "Plus".to_string(),
        "/" => "Slash".to_string(),
        other => other.to_uppercase(),
    };
    spoken.push(&spoken_key);

    (keys, spoken.join("+"))
}

fn item<R: Runtime>(app: &AppHandle<R>, action: MenuAction) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, action.id(), action.label(), true, action.accelerator())
}

/// Builds the application menu bar.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use MenuAction::*;

    let about = item(app, About)?;
    let open = item(app, Open)?;
    let toggle_theme = item(app, ToggleTheme)?;
    let zoom_in = item(app, ZoomIn)?;
    let zoom_out = item(app, ZoomOut)?;
    let zoom_reset = item(app, ZoomReset)?;
    let fullscreen = item(app, ToggleFullscreen)?;
    let shortcuts = item(app, Shortcuts)?;
    let licenses = item(app, Licenses)?;

    let mut menu = MenuBuilder::new(app);

    // macOS convention: an app menu named after the app, holding About and Quit.
    // Close/Quit use the predefined items there; Linux does not support those,
    // and Windows/Linux keep them in the File menu as custom items.
    let file = if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Smart Beat")
            .item(&about)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);

        SubmenuBuilder::new(app, "File")
            .item(&open)
            .separator()
            .close_window()
            .build()?
    } else {
        SubmenuBuilder::new(app, "File")
            .item(&open)
            .separator()
            .item(&item(app, CloseWindow)?)
            .item(&item(app, Quit)?)
            .build()?
    };

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_theme)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&fullscreen)
        .build()?;

    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&shortcuts)
        .item(&licenses);
    if !cfg!(target_os = "macos") {
        help = help.separator().item(&about);
    }
    let help = help.build()?;

    menu.items(&[&file, &edit, &view, &help]).build()
}

/// Entry point registered with `Builder::on_menu_event`.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(action) = MenuAction::from_id(event.id().as_ref()) else {
        return; // predefined items are handled by the OS
    };
    if let Err(err) = dispatch(app, action) {
        eprintln!("menu action {action:?} failed: {err}");
    }
}

/// Performs a menu action: native ones here, the rest in the webview.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, action: MenuAction) -> tauri::Result<()> {
    match action {
        MenuAction::Quit => app.exit(0),
        MenuAction::CloseWindow => {
            if let Some(window) = target_window(app) {
                window.close()?;
            }
        }
        MenuAction::ZoomIn | MenuAction::ZoomOut | MenuAction::ZoomReset => {
            let change = match action {
                MenuAction::ZoomIn => ZoomChange::In,
                MenuAction::ZoomOut => ZoomChange::Out,
                _ => ZoomChange::Reset,
            };
            let level = app.state::<ZoomState>().apply(change);
            if let Some(window) = target_window(app) {
                window.set_zoom(level)?;
            }
        }
        MenuAction::ToggleFullscreen => {
            if let Some(window) = target_window(app) {
                window.set_fullscreen(!window.is_fullscreen()?)?;
            }
        }
        _ => app.emit(MENU_EVENT, action)?,
    }
    Ok(())
}

/// The focused window, falling back to the main window.
fn target_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN_WINDOW))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn ids_round_trip() {
        for action in MenuAction::ALL {
            assert_eq!(MenuAction::from_id(action.id()), Some(action));
        }
    }

    #[test]
    fn ids_are_unique() {
        let ids: HashSet<_> = MenuAction::ALL.iter().map(|a| a.id()).collect();
        assert_eq!(ids.len(), MenuAction::ALL.len());
    }

    #[test]
    fn unknown_ids_are_ignored() {
        assert_eq!(MenuAction::from_id("edit.copy"), None);
        assert_eq!(MenuAction::from_id(""), None);
    }

    #[test]
    fn serializes_as_kebab_case() {
        let json = serde_json::to_string(&MenuAction::ToggleTheme).unwrap();
        assert_eq!(json, "\"toggle-theme\"");
    }

    #[test]
    fn window_actions_are_native_and_ui_actions_are_forwarded() {
        assert!(MenuAction::ZoomIn.is_native());
        assert!(MenuAction::Quit.is_native());
        assert!(!MenuAction::Open.is_native());
        assert!(!MenuAction::About.is_native());
    }

    #[test]
    fn accelerators_are_unique_per_platform() {
        for os in ["macos", "windows", "linux"] {
            let accelerators: Vec<_> = MenuAction::ALL
                .iter()
                .filter_map(|a| a.accelerator_for(os))
                .collect();
            let unique: HashSet<_> = accelerators.iter().collect();
            assert_eq!(
                unique.len(),
                accelerators.len(),
                "duplicate accelerator on {os}"
            );
        }
    }

    #[test]
    fn fullscreen_uses_platform_convention() {
        assert_eq!(
            MenuAction::ToggleFullscreen.accelerator_for("macos"),
            Some("Ctrl+Cmd+F")
        );
        assert_eq!(
            MenuAction::ToggleFullscreen.accelerator_for("windows"),
            Some("F11")
        );
    }

    #[test]
    fn formats_mac_accelerators_with_glyphs_in_canonical_order() {
        let (keys, spoken) = format_accelerator("CmdOrCtrl+Shift+L", "macos");
        assert_eq!(keys, ["⇧", "⌘", "L"]);
        assert_eq!(spoken, "Shift+Command+L");

        let (keys, _) = format_accelerator("Ctrl+Cmd+F", "macos");
        assert_eq!(keys, ["⌃", "⌘", "F"]);
    }

    #[test]
    fn formats_other_platform_accelerators_with_names() {
        let (keys, spoken) = format_accelerator("CmdOrCtrl+Shift+L", "windows");
        assert_eq!(keys, ["Ctrl", "Shift", "L"]);
        assert_eq!(spoken, "Control+Shift+L");

        let (keys, spoken) = format_accelerator("F11", "linux");
        assert_eq!(keys, ["F11"]);
        assert_eq!(spoken, "F11");
    }

    #[test]
    fn spells_out_punctuation_keys() {
        assert_eq!(
            format_accelerator("CmdOrCtrl+=", "macos").1,
            "Command+Equals"
        );
        assert_eq!(
            format_accelerator("CmdOrCtrl+-", "linux").1,
            "Control+Minus"
        );
        assert_eq!(
            format_accelerator("CmdOrCtrl+/", "windows").1,
            "Control+Slash"
        );
        assert_eq!(
            format_accelerator("CmdOrCtrl++", "windows").0,
            ["Ctrl", "+"]
        );
    }

    #[test]
    fn shortcuts_list_every_item_with_an_accelerator() {
        let list = shortcuts("macos");
        assert!(list.iter().all(|s| !s.keys.is_empty()));
        assert!(
            list.iter()
                .any(|s| s.action == MenuAction::Open && s.menu == "File")
        );
        assert!(!list.iter().any(|s| s.action == MenuAction::About));
        assert_eq!(
            list.len(),
            MenuAction::ALL
                .iter()
                .filter(|a| a.accelerator_for("macos").is_some())
                .count()
        );
    }
}
