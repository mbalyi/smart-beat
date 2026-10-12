//! Native application menu (File / Edit / View / Track / Bar / Note /
//! Playback / Help).
//!
//! Custom menu items are described by [`MenuAction`]. Actions that only touch
//! the native window (zoom, full screen, close, quit) are handled in Rust;
//! everything else is forwarded to the webview as a [`MENU_EVENT`] event so the
//! UI can react (open a dialog, switch theme, undo an edit, ...). The UI keeps
//! item labels, enabled and checked states in sync through
//! [`crate::menu_state`].

use serde::Serialize;
use tauri::menu::{
    CheckMenuItem, Menu, MenuBuilder, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::recent::RecentStore;
use crate::zoom::{ZoomChange, ZoomState};

/// Event name used to forward menu actions to the webview.
pub const MENU_EVENT: &str = "menu-action";

/// Label of the window created from `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Every custom (non-predefined) menu item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuAction {
    NewSong,
    Open,
    ImportAudio,
    ClearRecent,
    Save,
    SaveAs,
    ExportAll,
    // The UI knows these two by the names below (not "export-music-xml" / "export-alpha-tex").
    #[serde(rename = "export-musicxml")]
    ExportMusicXml,
    ExportMidi,
    #[serde(rename = "export-alphatex")]
    ExportAlphaTex,
    ExportAsciiTab,
    ExportAudio,
    ExportAudioM4a,
    ExportPdf,
    Print,
    CloseWindow,
    Quit,
    Undo,
    Redo,
    ToggleEditMode,
    ToggleTheme,
    ToggleFretboard,
    ToggleMixer,
    ToggleInspector,
    TogglePracticeView,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    ToggleFullscreen,
    AddTrack,
    AddAudioTrack,
    DuplicateTrack,
    RemoveTrack,
    TrackSettings,
    Lyrics,
    Transpose,
    BarSettings,
    FixBarDurations,
    ToggleRepeatStart,
    ToggleRepeatEnd,
    Bend,
    ToggleHammerPull,
    ToggleSlide,
    ToggleVibrato,
    TogglePalmMute,
    ToggleLetRing,
    ToggleDeadNote,
    ToggleGhostNote,
    ToggleHarmonic,
    ToggleAccent,
    ToggleStaccato,
    Text,
    Chord,
    ScaleTool,
    ToggleLoop,
    SpeedTrainer,
    ToggleMetronome,
    ToggleCountIn,
    Shortcuts,
    Settings,
    Licenses,
    CheckForUpdates,
    About,
}

impl MenuAction {
    pub const ALL: [Self; 63] = [
        Self::NewSong,
        Self::Open,
        Self::ImportAudio,
        Self::ClearRecent,
        Self::Save,
        Self::SaveAs,
        Self::ExportAll,
        Self::ExportMusicXml,
        Self::ExportMidi,
        Self::ExportAlphaTex,
        Self::ExportAsciiTab,
        Self::ExportAudio,
        Self::ExportAudioM4a,
        Self::ExportPdf,
        Self::Print,
        Self::CloseWindow,
        Self::Quit,
        Self::Undo,
        Self::Redo,
        Self::ToggleEditMode,
        Self::ToggleTheme,
        Self::ToggleFretboard,
        Self::ToggleMixer,
        Self::ToggleInspector,
        Self::TogglePracticeView,
        Self::ZoomIn,
        Self::ZoomOut,
        Self::ZoomReset,
        Self::ToggleFullscreen,
        Self::AddTrack,
        Self::AddAudioTrack,
        Self::DuplicateTrack,
        Self::RemoveTrack,
        Self::TrackSettings,
        Self::Lyrics,
        Self::Transpose,
        Self::BarSettings,
        Self::FixBarDurations,
        Self::ToggleRepeatStart,
        Self::ToggleRepeatEnd,
        Self::Bend,
        Self::ToggleHammerPull,
        Self::ToggleSlide,
        Self::ToggleVibrato,
        Self::TogglePalmMute,
        Self::ToggleLetRing,
        Self::ToggleDeadNote,
        Self::ToggleGhostNote,
        Self::ToggleHarmonic,
        Self::ToggleAccent,
        Self::ToggleStaccato,
        Self::Text,
        Self::Chord,
        Self::ScaleTool,
        Self::ToggleLoop,
        Self::SpeedTrainer,
        Self::ToggleMetronome,
        Self::ToggleCountIn,
        Self::Shortcuts,
        Self::Settings,
        Self::Licenses,
        Self::CheckForUpdates,
        Self::About,
    ];

    /// Stable menu item id.
    pub fn id(self) -> &'static str {
        match self {
            Self::NewSong => "file.new",
            Self::Open => "file.open",
            Self::ImportAudio => "file.import-audio",
            Self::ClearRecent => "file.clear-recent",
            Self::Save => "file.save",
            Self::SaveAs => "file.save-as",
            Self::ExportAll => "file.export-all",
            Self::ExportMusicXml => "file.export-musicxml",
            Self::ExportMidi => "file.export-midi",
            Self::ExportAlphaTex => "file.export-alphatex",
            Self::ExportAsciiTab => "file.export-ascii-tab",
            Self::ExportAudio => "file.export-audio",
            Self::ExportAudioM4a => "file.export-audio-m4a",
            Self::ExportPdf => "file.export-pdf",
            Self::Print => "file.print",
            Self::CloseWindow => "file.close-window",
            Self::Quit => "file.quit",
            Self::Undo => "edit.undo",
            Self::Redo => "edit.redo",
            Self::ToggleEditMode => "edit.toggle-edit-mode",
            Self::ToggleTheme => "view.toggle-theme",
            Self::ToggleFretboard => "view.toggle-fretboard",
            Self::ToggleMixer => "view.toggle-mixer",
            Self::ToggleInspector => "view.toggle-inspector",
            Self::TogglePracticeView => "view.toggle-practice-view",
            Self::ZoomIn => "view.zoom-in",
            Self::ZoomOut => "view.zoom-out",
            Self::ZoomReset => "view.zoom-reset",
            Self::ToggleFullscreen => "view.toggle-fullscreen",
            Self::AddTrack => "track.add",
            Self::AddAudioTrack => "track.add-audio",
            Self::DuplicateTrack => "track.duplicate",
            Self::RemoveTrack => "track.remove",
            Self::TrackSettings => "track.settings",
            Self::Lyrics => "track.lyrics",
            Self::Transpose => "track.transpose",
            Self::BarSettings => "bar.settings",
            Self::FixBarDurations => "bar.fix-durations",
            Self::ToggleRepeatStart => "bar.toggle-repeat-start",
            Self::ToggleRepeatEnd => "bar.toggle-repeat-end",
            Self::Bend => "note.bend",
            Self::ToggleHammerPull => "note.toggle-hammer-pull",
            Self::ToggleSlide => "note.toggle-slide",
            Self::ToggleVibrato => "note.toggle-vibrato",
            Self::TogglePalmMute => "note.toggle-palm-mute",
            Self::ToggleLetRing => "note.toggle-let-ring",
            Self::ToggleDeadNote => "note.toggle-dead-note",
            Self::ToggleGhostNote => "note.toggle-ghost-note",
            Self::ToggleHarmonic => "note.toggle-harmonic",
            Self::ToggleAccent => "note.toggle-accent",
            Self::ToggleStaccato => "note.toggle-staccato",
            Self::Text => "note.text",
            Self::Chord => "note.chord",
            Self::ScaleTool => "view.scale-tool",
            Self::ToggleLoop => "playback.toggle-loop",
            Self::SpeedTrainer => "playback.speed-trainer",
            Self::ToggleMetronome => "playback.toggle-metronome",
            Self::ToggleCountIn => "playback.toggle-count-in",
            Self::Shortcuts => "help.shortcuts",
            Self::Settings => "help.settings",
            Self::Licenses => "help.licenses",
            Self::CheckForUpdates => "help.check-for-updates",
            Self::About => "help.about",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }

    /// Title of the submenu the item lives in (the macOS app menu counts as "Smart Beat").
    pub fn menu(self) -> &'static str {
        match self {
            Self::NewSong
            | Self::Open
            | Self::ImportAudio
            | Self::ClearRecent
            | Self::Save
            | Self::SaveAs
            | Self::ExportAll
            | Self::ExportMusicXml
            | Self::ExportMidi
            | Self::ExportAlphaTex
            | Self::ExportAsciiTab
            | Self::ExportAudio
            | Self::ExportAudioM4a
            | Self::ExportPdf
            | Self::Print
            | Self::CloseWindow
            | Self::Quit => "File",
            Self::Undo | Self::Redo | Self::ToggleEditMode => "Edit",
            Self::ToggleTheme
            | Self::ToggleFretboard
            | Self::ToggleMixer
            | Self::ToggleInspector
            | Self::TogglePracticeView
            | Self::ScaleTool
            | Self::ZoomIn
            | Self::ZoomOut
            | Self::ZoomReset
            | Self::ToggleFullscreen => "View",
            Self::AddTrack
            | Self::AddAudioTrack
            | Self::DuplicateTrack
            | Self::RemoveTrack
            | Self::TrackSettings
            | Self::Lyrics
            | Self::Transpose => "Track",
            Self::BarSettings
            | Self::FixBarDurations
            | Self::ToggleRepeatStart
            | Self::ToggleRepeatEnd => "Bar",
            Self::Bend
            | Self::ToggleHammerPull
            | Self::ToggleSlide
            | Self::ToggleVibrato
            | Self::TogglePalmMute
            | Self::ToggleLetRing
            | Self::ToggleDeadNote
            | Self::ToggleGhostNote
            | Self::ToggleHarmonic
            | Self::ToggleAccent
            | Self::ToggleStaccato
            | Self::Text
            | Self::Chord => "Note",
            Self::ToggleLoop | Self::SpeedTrainer | Self::ToggleMetronome | Self::ToggleCountIn => {
                "Playback"
            }
            Self::Shortcuts
            | Self::Settings
            | Self::Licenses
            | Self::CheckForUpdates
            | Self::About => "Help",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::NewSong => "New",
            Self::Open => "Open…",
            Self::ImportAudio => "Import from Audio…",
            Self::ClearRecent => "Clear Menu",
            Self::Save => "Save",
            Self::SaveAs => "Save As…",
            Self::ExportAll => "All Formats…",
            Self::ExportMusicXml => "MusicXML…",
            Self::ExportMidi => "MIDI…",
            Self::ExportAlphaTex => "alphaTex…",
            Self::ExportAsciiTab => "ASCII Tab…",
            Self::ExportAudio => "Audio (WAV)…",
            Self::ExportAudioM4a => "Audio (M4A)…",
            Self::ExportPdf => "PDF…",
            Self::Print => "Print or Save as PDF…",
            Self::CloseWindow => "Close Window",
            Self::Quit => "Quit Smart Beat",
            Self::Undo => "Undo",
            Self::Redo => "Redo",
            Self::ToggleEditMode => "Edit Mode",
            Self::ToggleTheme => "Toggle Dark Mode",
            Self::ToggleFretboard => "Fretboard and Keyboard",
            Self::ToggleMixer => "Mixer",
            Self::ToggleInspector => "Inspector",
            Self::TogglePracticeView => "Practice View",
            Self::ZoomIn => "Zoom In",
            Self::ZoomOut => "Zoom Out",
            Self::ZoomReset => "Actual Size",
            Self::ToggleFullscreen => "Toggle Full Screen",
            Self::AddTrack => "Add Track…",
            Self::AddAudioTrack => "Add Audio Track…",
            Self::DuplicateTrack => "Duplicate Track",
            Self::RemoveTrack => "Remove Track",
            Self::TrackSettings => "Track Settings…",
            Self::Lyrics => "Lyrics…",
            Self::Transpose => "Transpose…",
            Self::BarSettings => "Bar Settings…",
            Self::FixBarDurations => "Fix Bar Durations…",
            Self::ToggleRepeatStart => "Repeat Start",
            Self::ToggleRepeatEnd => "Repeat End",
            Self::Bend => "Bend…",
            Self::ToggleHammerPull => "Hammer-On / Pull-Off",
            Self::ToggleSlide => "Slide",
            Self::ToggleVibrato => "Vibrato",
            Self::TogglePalmMute => "Palm Mute",
            Self::ToggleLetRing => "Let Ring",
            Self::ToggleDeadNote => "Dead Note",
            Self::ToggleGhostNote => "Ghost Note",
            Self::ToggleHarmonic => "Natural Harmonic",
            Self::ToggleAccent => "Accent",
            Self::ToggleStaccato => "Staccato",
            Self::Text => "Text…",
            Self::Chord => "Chord…",
            Self::ScaleTool => "Scale Tool…",
            Self::ToggleLoop => "Loop",
            Self::SpeedTrainer => "Speed Trainer…",
            Self::ToggleMetronome => "Metronome",
            Self::ToggleCountIn => "Count-In",
            Self::Shortcuts => "Keyboard Shortcuts",
            Self::Settings => "Settings…",
            Self::Licenses => "Open-Source Licenses",
            Self::CheckForUpdates => "Check for Updates…",
            Self::About => "About Smart Beat",
        }
    }

    /// Accelerator in Tauri syntax for the given `std::env::consts::OS` value.
    pub fn accelerator_for(self, os: &str) -> Option<&'static str> {
        match self {
            Self::NewSong => Some("CmdOrCtrl+N"),
            Self::Open => Some("CmdOrCtrl+O"),
            Self::Save => Some("CmdOrCtrl+S"),
            Self::SaveAs => Some("CmdOrCtrl+Shift+S"),
            Self::Print => Some("CmdOrCtrl+P"),
            Self::CloseWindow => Some("CmdOrCtrl+W"),
            Self::Quit => Some("CmdOrCtrl+Q"),
            Self::Undo => Some("CmdOrCtrl+Z"),
            Self::Redo if os == "macos" => Some("Shift+CmdOrCtrl+Z"),
            Self::Redo => Some("Ctrl+Y"),
            Self::ToggleEditMode => Some("CmdOrCtrl+E"),
            Self::ToggleTheme => Some("CmdOrCtrl+Shift+L"),
            Self::ToggleFretboard => Some("CmdOrCtrl+Shift+F"),
            Self::ToggleMixer => Some("CmdOrCtrl+Alt+M"),
            Self::ToggleInspector => Some("CmdOrCtrl+Alt+I"),
            Self::TogglePracticeView => Some("CmdOrCtrl+Shift+P"),
            Self::ZoomIn => Some("CmdOrCtrl+="),
            Self::ZoomOut => Some("CmdOrCtrl+-"),
            Self::ZoomReset => Some("CmdOrCtrl+0"),
            Self::ToggleFullscreen if os == "macos" => Some("Ctrl+Cmd+F"),
            Self::ToggleFullscreen => Some("F11"),
            Self::AddTrack => Some("CmdOrCtrl+Shift+N"),
            Self::BarSettings => Some("CmdOrCtrl+B"),
            Self::Text => Some("CmdOrCtrl+T"),
            Self::Chord => Some("CmdOrCtrl+K"),
            Self::ToggleLoop => Some("CmdOrCtrl+L"),
            Self::ToggleMetronome => Some("CmdOrCtrl+Shift+M"),
            Self::Shortcuts => Some("CmdOrCtrl+/"),
            Self::Settings => Some("CmdOrCtrl+,"),
            // The note effects have plain keys in the score (H, P, L...); menu
            // accelerators would take those keys away from text fields.
            Self::AddAudioTrack
            | Self::ImportAudio
            | Self::DuplicateTrack
            | Self::RemoveTrack
            | Self::TrackSettings
            | Self::Lyrics
            | Self::ToggleRepeatStart
            | Self::ToggleRepeatEnd
            | Self::Bend
            | Self::ToggleHammerPull
            | Self::ToggleSlide
            | Self::ToggleVibrato
            | Self::TogglePalmMute
            | Self::ToggleLetRing
            | Self::ToggleDeadNote
            | Self::ToggleGhostNote
            | Self::ToggleHarmonic
            | Self::ToggleAccent
            | Self::ToggleStaccato
            | Self::ScaleTool
            | Self::SpeedTrainer
            | Self::ToggleCountIn
            | Self::Licenses
            | Self::CheckForUpdates
            | Self::ClearRecent
            | Self::ExportAll
            | Self::ExportMusicXml
            | Self::ExportMidi
            | Self::ExportAlphaTex
            | Self::ExportAsciiTab
            | Self::ExportAudio
            | Self::ExportAudioM4a
            | Self::ExportPdf
            | Self::Transpose
            | Self::FixBarDurations
            | Self::About => None,
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
                | Self::ClearRecent
                | Self::ZoomIn
                | Self::ZoomOut
                | Self::ZoomReset
                | Self::ToggleFullscreen
        )
    }

    /// Whether the item shows a check mark (an on/off setting).
    pub fn is_toggle(self) -> bool {
        matches!(
            self,
            Self::ToggleEditMode
                | Self::ToggleFretboard
                | Self::ToggleMixer
                | Self::ToggleInspector
                | Self::TogglePracticeView
                | Self::ToggleRepeatStart
                | Self::ToggleRepeatEnd
                | Self::ToggleLoop
                | Self::ToggleMetronome
                | Self::ToggleCountIn
        ) || self.is_note_effect()
    }

    /// The Note menu's check items: effects of the note under the edit cursor.
    pub fn is_note_effect(self) -> bool {
        matches!(
            self,
            Self::ToggleHammerPull
                | Self::ToggleSlide
                | Self::ToggleVibrato
                | Self::TogglePalmMute
                | Self::ToggleLetRing
                | Self::ToggleDeadNote
                | Self::ToggleGhostNote
                | Self::ToggleHarmonic
                | Self::ToggleAccent
                | Self::ToggleStaccato
        )
    }

    /// Whether the item works on the edit cursor (the Bar and Note menus), so
    /// it is only available in edit mode.
    pub fn needs_edit_mode(self) -> bool {
        matches!(self.menu(), "Bar" | "Note")
    }

    /// Whether the item needs a note under the edit cursor.
    pub fn needs_note(self) -> bool {
        self.is_note_effect() || self == Self::Bend
    }

    /// Whether the item only makes sense with a song open (disabled otherwise).
    pub fn needs_song(self) -> bool {
        matches!(
            self,
            Self::Undo
                | Self::Redo
                | Self::Save
                | Self::SaveAs
                | Self::ExportAll
                | Self::ExportMusicXml
                | Self::ExportMidi
                | Self::ExportAlphaTex
                | Self::ExportAsciiTab
                | Self::ExportAudio
                | Self::ExportAudioM4a
                | Self::ExportPdf
                | Self::Print
                | Self::Transpose
                | Self::ToggleEditMode
                | Self::ToggleFretboard
                | Self::ToggleMixer
                | Self::ToggleInspector
                | Self::TogglePracticeView
                | Self::AddTrack
                | Self::AddAudioTrack
                | Self::DuplicateTrack
                | Self::RemoveTrack
                | Self::TrackSettings
                | Self::Lyrics
                | Self::ScaleTool
                | Self::ToggleLoop
                | Self::SpeedTrainer
                | Self::ToggleMetronome
                | Self::ToggleCountIn
        ) || self.needs_edit_mode()
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
        "," => "Comma".to_string(),
        other => other.to_uppercase(),
    };
    spoken.push(&spoken_key);

    (keys, spoken.join("+"))
}

fn item<R: Runtime>(app: &AppHandle<R>, action: MenuAction) -> tauri::Result<MenuItem<R>> {
    let enabled = !action.needs_song(); // enabled once a song is open (see menu_state)
    MenuItem::with_id(
        app,
        action.id(),
        action.label(),
        enabled,
        action.accelerator(),
    )
}

fn check_item<R: Runtime>(
    app: &AppHandle<R>,
    action: MenuAction,
) -> tauri::Result<CheckMenuItem<R>> {
    let enabled = !action.needs_song();
    CheckMenuItem::with_id(
        app,
        action.id(),
        action.label(),
        enabled,
        false,
        action.accelerator(),
    )
}

/// The File menu start. Import from Audio shows only while `audio-2-tab` is on.
fn file_menu<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    new_song: &MenuItem<R>,
    open: &MenuItem<R>,
    import_audio: &MenuItem<R>,
    recent: &Submenu<R>,
) -> SubmenuBuilder<'a, R, AppHandle<R>> {
    let mut file = SubmenuBuilder::new(app, "File").item(new_song).item(open);
    if crate::features::enabled("audio-2-tab") {
        file = file.item(import_audio);
    }
    file.item(recent)
}

/// The AI menu: one disabled entry for each feature that is not out yet.
fn ai_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Submenu<R>>> {
    let soon = crate::features::coming_soon();
    if soon.is_empty() {
        return Ok(None);
    }
    let mut ai = SubmenuBuilder::new(app, "AI");
    for (id, label) in soon {
        let text = format!("{label} — AI coming soon");
        ai = ai.item(&MenuItem::with_id(
            app,
            format!("ai.{id}"),
            text,
            false,
            None::<&str>,
        )?);
    }
    ai.build().map(Some)
}

/// Builds the application menu bar.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use MenuAction::*;

    let about = item(app, About)?;
    let new_song = item(app, NewSong)?;
    let open = item(app, Open)?;
    let import_audio = item(app, ImportAudio)?;
    let toggle_theme = item(app, ToggleTheme)?;
    let zoom_in = item(app, ZoomIn)?;
    let zoom_out = item(app, ZoomOut)?;
    let zoom_reset = item(app, ZoomReset)?;
    let fullscreen = item(app, ToggleFullscreen)?;
    let shortcuts = item(app, Shortcuts)?;
    let settings = item(app, Settings)?;
    let licenses = item(app, Licenses)?;
    let updates = item(app, CheckForUpdates)?;

    crate::recent::ensure_store(app)?;
    let recent = Submenu::with_id(app, RECENT_MENU_ID, "Open Recent", true)?;
    fill_recent_menu(app, &recent, &app.state::<RecentStore>().load())?;
    app.manage(RecentMenu(recent.clone()));
    let mut export = SubmenuBuilder::new(app, "Export")
        .item(&item(app, ExportAll)?)
        .separator()
        .item(&item(app, ExportMusicXml)?)
        .item(&item(app, ExportMidi)?)
        .item(&item(app, ExportAlphaTex)?)
        .item(&item(app, ExportAsciiTab)?)
        .separator()
        .item(&item(app, ExportAudio)?);
    // AAC comes from the system's encoder, which only macOS has wired in so far.
    if crate::m4a::SUPPORTED {
        export = export.item(&item(app, ExportAudioM4a)?);
    }
    // macOS prints to a file itself; elsewhere the system print dialog saves PDFs (#83).
    if crate::pdf::SUPPORTED {
        export = export.separator().item(&item(app, ExportPdf)?);
    }
    let export = export.build()?;

    let mut menu = MenuBuilder::new(app);

    // macOS convention: an app menu named after the app, holding About, Settings and Quit.
    // Close/Quit use the predefined items there; Linux does not support those,
    // and Windows/Linux keep them in the File menu as custom items.
    let file = if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Smart Beat")
            .item(&about)
            .separator()
            .item(&settings)
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

        file_menu(app, &new_song, &open, &import_audio, &recent)
            .separator()
            .item(&item(app, Save)?)
            .item(&item(app, SaveAs)?)
            .item(&export)
            .item(&item(app, Print)?)
            .separator()
            .close_window()
            .build()?
    } else {
        file_menu(app, &new_song, &open, &import_audio, &recent)
            .separator()
            .item(&item(app, Save)?)
            .item(&item(app, SaveAs)?)
            .item(&export)
            .item(&item(app, Print)?)
            .separator()
            .item(&item(app, CloseWindow)?)
            .item(&item(app, Quit)?)
            .build()?
    };

    // Undo and Redo are custom items: they undo score edits (the UI falls back
    // to the text field's own undo when one has focus). Cut, Copy, Paste and
    // Select All stay predefined so text fields keep working; the score editor
    // handles those keys itself.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, Undo)?)
        .item(&item(app, Redo)?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&check_item(app, ToggleEditMode)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_theme)
        .item(&check_item(app, ToggleFretboard)?)
        .item(&check_item(app, ToggleMixer)?)
        .item(&check_item(app, ToggleInspector)?)
        .item(&check_item(app, TogglePracticeView)?)
        .item(&item(app, ScaleTool)?)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&fullscreen)
        .build()?;

    let track = SubmenuBuilder::new(app, "Track")
        .item(&item(app, AddTrack)?)
        .item(&item(app, AddAudioTrack)?)
        .item(&item(app, DuplicateTrack)?)
        .item(&item(app, RemoveTrack)?)
        .separator()
        .item(&item(app, TrackSettings)?)
        .item(&item(app, Lyrics)?)
        .separator()
        .item(&item(app, Transpose)?)
        .build()?;

    let bar = SubmenuBuilder::new(app, "Bar")
        .item(&item(app, BarSettings)?)
        .item(&item(app, FixBarDurations)?)
        .separator()
        .item(&check_item(app, ToggleRepeatStart)?)
        .item(&check_item(app, ToggleRepeatEnd)?)
        .build()?;

    let note = SubmenuBuilder::new(app, "Note")
        .item(&item(app, Bend)?)
        .separator()
        .item(&check_item(app, ToggleHammerPull)?)
        .item(&check_item(app, ToggleSlide)?)
        .item(&check_item(app, ToggleVibrato)?)
        .separator()
        .item(&check_item(app, TogglePalmMute)?)
        .item(&check_item(app, ToggleLetRing)?)
        .item(&check_item(app, ToggleDeadNote)?)
        .item(&check_item(app, ToggleGhostNote)?)
        .separator()
        .item(&check_item(app, ToggleHarmonic)?)
        .item(&check_item(app, ToggleAccent)?)
        .item(&check_item(app, ToggleStaccato)?)
        .separator()
        .item(&item(app, Text)?)
        .item(&item(app, Chord)?)
        .build()?;

    let playback = SubmenuBuilder::new(app, "Playback")
        .item(&check_item(app, ToggleLoop)?)
        .item(&item(app, SpeedTrainer)?)
        .separator()
        .item(&check_item(app, ToggleMetronome)?)
        .item(&check_item(app, ToggleCountIn)?)
        .build()?;

    // On macOS, Settings and About live in the app menu instead.
    let help = if cfg!(target_os = "macos") {
        SubmenuBuilder::new(app, "Help")
            .item(&shortcuts)
            .item(&licenses)
            .item(&updates)
    } else {
        SubmenuBuilder::new(app, "Help")
            .item(&shortcuts)
            .item(&settings)
            .item(&licenses)
            .item(&updates)
            .separator()
            .item(&about)
    }
    .build()?;

    menu = menu.items(&[&file, &edit, &view, &track, &bar, &note, &playback]);
    if let Some(ai) = ai_menu(app)? {
        menu = menu.item(&ai);
    }
    menu.item(&help).build()
}

/// Id of the File › Open Recent submenu.
pub const RECENT_MENU_ID: &str = "file.recent";

/// Prefix of the ids of the recent file items (`file.recent.0`, `file.recent.1`...).
const RECENT_ITEM_PREFIX: &str = "file.recent.";

/// Event sent to the webview when the recent files list changed.
pub const RECENT_CHANGED_EVENT: &str = "recent-changed";

/// Event sent to the webview with the path of the recent file to open.
pub const OPEN_RECENT_EVENT: &str = "open-recent";

/// The Open Recent submenu, kept as state so it can be refilled.
pub struct RecentMenu<R: Runtime>(pub Submenu<R>);

/// Menu text for a recent file: its name, with the folder to tell equal names apart.
pub fn recent_label(path: &str) -> String {
    let path = std::path::Path::new(path);
    let name = path
        .file_name()
        .map_or_else(|| path.to_string_lossy(), |n| n.to_string_lossy())
        .into_owned();
    match path.parent().and_then(|p| p.file_name()) {
        Some(folder) => format!("{name} — {}", folder.to_string_lossy()),
        None => name,
    }
}

/// Replaces the items of the Open Recent submenu with `paths`.
pub fn fill_recent_menu<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Submenu<R>,
    paths: &[String],
) -> tauri::Result<()> {
    for existing in menu.items()? {
        menu.remove(&existing)?;
    }
    if paths.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "file.recent.none",
            "No Recent Files",
            false,
            None::<&str>,
        )?)?;
    }
    for (index, path) in paths.iter().enumerate() {
        menu.append(&MenuItem::with_id(
            app,
            format!("{RECENT_ITEM_PREFIX}{index}"),
            recent_label(path),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let clear = item(app, MenuAction::ClearRecent)?;
    clear.set_enabled(!paths.is_empty())?;
    menu.append(&clear)?;
    Ok(())
}

/// Shows the current recent files in the menu bar.
pub fn refresh_recent_menu<R: Runtime>(app: &AppHandle<R>, paths: &[String]) {
    let Some(menu) = app.try_state::<RecentMenu<R>>() else {
        return; // no menu bar (tests)
    };
    if let Err(error) = fill_recent_menu(app, &menu.0, paths) {
        eprintln!("could not update Open Recent: {error}");
    }
}

fn open_recent<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<()> {
    let Some(index) = id
        .strip_prefix(RECENT_ITEM_PREFIX)
        .and_then(|n| n.parse::<usize>().ok())
    else {
        return Ok(());
    };
    if let Some(path) = app.state::<RecentStore>().load().get(index) {
        app.emit(OPEN_RECENT_EVENT, path)?;
    }
    Ok(())
}

/// Entry point registered with `Builder::on_menu_event`.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref().starts_with(RECENT_ITEM_PREFIX) {
        if let Err(err) = open_recent(app, event.id().as_ref()) {
            eprintln!("could not open the recent file: {err}");
        }
        return;
    }
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
        MenuAction::ClearRecent => match app.state::<RecentStore>().clear() {
            Ok(paths) => {
                refresh_recent_menu(app, &paths);
                app.emit(RECENT_CHANGED_EVENT, &paths)?;
            }
            Err(error) => eprintln!("could not clear the recent files: {error}"),
        },
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

    /// The UI listens for these names (`MenuAction` in `src/lib/tauri.ts`): an action it
    /// does not know would be forwarded and silently ignored.
    #[test]
    fn every_forwarded_action_is_known_to_the_ui() {
        let types = include_str!("../../src/lib/tauri.ts");
        for action in MenuAction::ALL.into_iter().filter(|a| !a.is_native()) {
            let name = serde_json::to_string(&action).unwrap();
            assert!(
                // Each union member is on its own line; the last one ends with a semicolon.
                types.contains(&format!("| {name}\n")) || types.contains(&format!("| {name};")),
                "{action:?} is sent as {name}, which the UI does not list"
            );
        }
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
        assert!(!MenuAction::Undo.is_native());
        assert!(!MenuAction::ToggleLoop.is_native());
    }

    #[test]
    fn settings_are_check_items_and_song_items_need_a_song() {
        let toggles: Vec<_> = MenuAction::ALL
            .into_iter()
            .filter(|a| a.is_toggle())
            .collect();
        assert_eq!(
            toggles,
            [
                MenuAction::ToggleEditMode,
                MenuAction::ToggleFretboard,
                MenuAction::ToggleMixer,
                MenuAction::ToggleInspector,
                MenuAction::TogglePracticeView,
                MenuAction::ToggleRepeatStart,
                MenuAction::ToggleRepeatEnd,
                MenuAction::ToggleHammerPull,
                MenuAction::ToggleSlide,
                MenuAction::ToggleVibrato,
                MenuAction::TogglePalmMute,
                MenuAction::ToggleLetRing,
                MenuAction::ToggleDeadNote,
                MenuAction::ToggleGhostNote,
                MenuAction::ToggleHarmonic,
                MenuAction::ToggleAccent,
                MenuAction::ToggleStaccato,
                MenuAction::ToggleLoop,
                MenuAction::ToggleMetronome,
                MenuAction::ToggleCountIn,
            ]
        );
        // Every toggle is about the open song, and so are the Track, Bar, Note and Playback menus.
        for action in MenuAction::ALL {
            if action.is_toggle() || matches!(action.menu(), "Track" | "Bar" | "Note" | "Playback")
            {
                assert!(action.needs_song(), "{action:?}");
            }
        }
        assert!(!MenuAction::NewSong.needs_song());
        assert!(!MenuAction::Open.needs_song());
        assert!(!MenuAction::ToggleTheme.needs_song());
        assert!(!MenuAction::ToggleTheme.is_toggle());
    }

    #[test]
    fn bar_and_note_items_work_on_the_edit_cursor() {
        for action in MenuAction::ALL {
            assert_eq!(
                action.needs_edit_mode(),
                matches!(action.menu(), "Bar" | "Note"),
                "{action:?}"
            );
            // Note effects need a note, and are check items.
            if action.is_note_effect() {
                assert!(action.needs_note() && action.is_toggle(), "{action:?}");
                assert_eq!(action.menu(), "Note");
            }
        }
        assert!(MenuAction::Bend.needs_note());
        assert!(!MenuAction::Text.needs_note());
        assert!(!MenuAction::BarSettings.needs_note());
        // The lyrics and the scale tool work outside edit mode too.
        assert!(MenuAction::Lyrics.needs_song() && !MenuAction::Lyrics.needs_edit_mode());
        assert!(MenuAction::ScaleTool.needs_song() && !MenuAction::ScaleTool.needs_edit_mode());
    }

    #[test]
    fn note_effects_have_no_accelerators() {
        // They have plain keys in the score; accelerators would steal them from text fields.
        for os in ["macos", "windows", "linux"] {
            for action in MenuAction::ALL.into_iter().filter(|a| a.is_note_effect()) {
                assert_eq!(action.accelerator_for(os), None, "{action:?}");
            }
            assert_eq!(
                MenuAction::BarSettings.accelerator_for(os),
                Some("CmdOrCtrl+B")
            );
            assert_eq!(MenuAction::Text.accelerator_for(os), Some("CmdOrCtrl+T"));
            assert_eq!(MenuAction::Chord.accelerator_for(os), Some("CmdOrCtrl+K"));
        }
    }

    #[test]
    fn serializes_new_actions_for_the_webview() {
        for (action, name) in [
            (MenuAction::BarSettings, "\"bar-settings\""),
            (MenuAction::ToggleRepeatEnd, "\"toggle-repeat-end\""),
            (MenuAction::TogglePalmMute, "\"toggle-palm-mute\""),
            (MenuAction::ScaleTool, "\"scale-tool\""),
            (MenuAction::Lyrics, "\"lyrics\""),
        ] {
            assert_eq!(serde_json::to_string(&action).unwrap(), name);
        }
    }

    #[test]
    fn recent_files_are_labelled_with_name_and_folder() {
        assert_eq!(recent_label("/Users/me/Songs/riff.gp5"), "riff.gp5 — Songs");
        assert_eq!(recent_label("riff.gp5"), "riff.gp5");
        assert_eq!(recent_label("/riff.gp5"), "riff.gp5");
    }

    #[test]
    fn save_export_and_editing_helpers_are_menu_items() {
        assert_eq!(
            MenuAction::Save.accelerator_for("macos"),
            Some("CmdOrCtrl+S")
        );
        assert_eq!(
            MenuAction::SaveAs.accelerator_for("linux"),
            Some("CmdOrCtrl+Shift+S")
        );
        for action in [
            MenuAction::Save,
            MenuAction::SaveAs,
            MenuAction::ExportAll,
            MenuAction::ExportMusicXml,
            MenuAction::ExportMidi,
            MenuAction::ExportAlphaTex,
            MenuAction::ExportAsciiTab,
            MenuAction::ExportAudio,
            MenuAction::ExportAudioM4a,
            MenuAction::ExportPdf,
            MenuAction::Print,
            MenuAction::Transpose,
            MenuAction::FixBarDurations,
        ] {
            assert!(action.needs_song(), "{action:?}");
            assert!(!action.is_native(), "{action:?}");
        }
        assert!(MenuAction::ClearRecent.is_native());
        assert!(!MenuAction::ClearRecent.needs_song());
        assert_eq!(MenuAction::FixBarDurations.menu(), "Bar");
        assert_eq!(MenuAction::Transpose.menu(), "Track");
        assert_eq!(
            serde_json::to_string(&MenuAction::ExportAsciiTab).unwrap(),
            "\"export-ascii-tab\""
        );
        assert_eq!(
            serde_json::to_string(&MenuAction::ExportAll).unwrap(),
            "\"export-all\""
        );
    }

    #[test]
    fn redo_uses_platform_convention() {
        assert_eq!(
            MenuAction::Redo.accelerator_for("macos"),
            Some("Shift+CmdOrCtrl+Z")
        );
        assert_eq!(MenuAction::Redo.accelerator_for("windows"), Some("Ctrl+Y"));
        assert_eq!(MenuAction::Redo.accelerator_for("linux"), Some("Ctrl+Y"));
        let (keys, spoken) = format_accelerator("Shift+CmdOrCtrl+Z", "macos");
        assert_eq!(keys, ["⇧", "⌘", "Z"]);
        assert_eq!(spoken, "Shift+Command+Z");
    }

    #[test]
    fn check_for_updates_is_a_help_item_the_ui_handles() {
        let action = MenuAction::CheckForUpdates;
        assert_eq!(action.id(), "help.check-for-updates");
        assert_eq!(action.menu(), "Help");
        assert_eq!(action.label(), "Check for Updates…");
        assert_eq!(
            serde_json::to_string(&action).unwrap(),
            "\"check-for-updates\""
        );
        // The UI shows the dialog; it works without a song and has no shortcut.
        assert!(!action.is_native());
        assert!(!action.needs_song());
        assert_eq!(action.accelerator_for("macos"), None);
        assert_eq!(action.accelerator_for("windows"), None);
    }

    #[test]
    fn settings_is_an_app_menu_item_the_ui_handles() {
        let action = MenuAction::Settings;
        assert_eq!(action.id(), "help.settings");
        assert_eq!(action.label(), "Settings…");
        assert_eq!(serde_json::to_string(&action).unwrap(), "\"settings\"");
        // The UI shows the dialog; it works without a song.
        assert!(!action.is_native());
        assert!(!action.needs_song());
        assert!(!action.is_toggle());
        // ⌘, is the macOS convention for Settings.
        for os in ["macos", "windows", "linux"] {
            assert_eq!(action.accelerator_for(os), Some("CmdOrCtrl+,"));
        }
        let (keys, spoken) = format_accelerator("CmdOrCtrl+,", "macos");
        assert_eq!(keys, ["⌘", ","]);
        assert_eq!(spoken, "Command+Comma");
        assert_eq!(
            format_accelerator("CmdOrCtrl+,", "windows").1,
            "Control+Comma"
        );
    }

    #[test]
    fn every_action_has_a_menu_and_a_label() {
        let menus = [
            "File", "Edit", "View", "Track", "Bar", "Note", "Playback", "Help",
        ];
        for action in MenuAction::ALL {
            assert!(menus.contains(&action.menu()), "{action:?}");
            assert!(!action.label().is_empty());
            let prefix = action.id().split('.').next().unwrap();
            assert_eq!(prefix, action.menu().to_lowercase(), "{action:?}");
        }
    }

    #[test]
    fn accelerators_are_unique_per_platform() {
        for os in ["macos", "windows", "linux"] {
            // Compare the keys, so "Shift+Cmd+Z" and "Cmd+Shift+Z" count as the same.
            let keys: Vec<_> = MenuAction::ALL
                .iter()
                .filter_map(|a| a.accelerator_for(os))
                .map(|accelerator| format_accelerator(accelerator, os).0)
                .collect();
            let unique: HashSet<_> = keys.iter().collect();
            assert_eq!(unique.len(), keys.len(), "duplicate accelerator on {os}");
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
