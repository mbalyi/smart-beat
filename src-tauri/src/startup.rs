//! Startup without a white flash (#53): the main window is created hidden
//! (`"visible": false` in tauri.conf.json, on a black background) and shown
//! once its page has loaded, when the black splash is already on screen. A
//! timer shows it anyway, so a page that never reports back is not invisible.

use std::time::Duration;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Runtime, Webview};

/// The window the app shows at startup.
pub const MAIN_WINDOW: &str = "main";
/// Shows the window even if the page never says it loaded.
pub const SAFETY_SHOW: Duration = Duration::from_secs(2);

/// Whether a page-load event means the splash is on screen.
pub fn ready_to_show(event: PageLoadEvent) -> bool {
    matches!(event, PageLoadEvent::Finished)
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
    }
}

/// `on_page_load` handler: shows the main window once its page has loaded.
pub fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if webview.label() == MAIN_WINDOW && ready_to_show(payload.event()) {
        show(webview.app_handle());
    }
}

/// Shows the main window after [`SAFETY_SHOW`] whatever happens.
pub fn show_later<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAFETY_SHOW);
        show(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_the_window_when_the_page_has_loaded() {
        assert!(ready_to_show(PageLoadEvent::Finished));
        assert!(!ready_to_show(PageLoadEvent::Started));
    }

    #[test]
    fn the_main_window_starts_hidden_on_black() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["label"] == MAIN_WINDOW)
            .unwrap();
        assert_eq!(window["visible"], false);
        assert_eq!(window["backgroundColor"], "#000000");
    }
}
