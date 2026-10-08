//! Export as PDF (#83): the window's print copy of the score (see `src/lib/print.ts`), printed
//! by macOS's own print system straight to a file the user chose, with no print dialog.
//!
//! The print operation runs on the main thread and finishes on its own time, so the file is
//! written next to the destination first and moved into place once macOS has finished it.
//! Other platforms answer with an error: there the system print dialog's "Save as PDF" (or
//! "Microsoft Print to PDF") does the job.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::{CommandError, ErrorKind};

/// Whether this build can export PDF files itself.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// How long macOS may take to write the PDF.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TIMEOUT: Duration = Duration::from_secs(60);

/// Paper and margins, in points (1/72 inch). Mirrors `PdfPage` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
    pub width_pt: f64,
    pub height_pt: f64,
    pub margin_pt: f64,
    pub landscape: bool,
}

fn io_error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Io, message)
}

/// Checks the page and the destination: a `.pdf` file in a folder that exists.
pub fn check(path: &Path, page: &PdfPage) -> Result<(), CommandError> {
    let is_pdf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !path.is_absolute() || !is_pdf {
        return Err(io_error("Choose a .pdf file to export to."));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(io_error("The folder to export to does not exist."));
    }
    let sane = |v: f64, max: f64| v.is_finite() && v > 0.0 && v <= max;
    if !sane(page.width_pt, 2_000.0)
        || !sane(page.height_pt, 2_000.0)
        || !(page.margin_pt.is_finite() && (0.0..=200.0).contains(&page.margin_pt))
    {
        return Err(io_error("The page size is not valid."));
    }
    Ok(())
}

/// Where the PDF is written before it is moved into place.
pub fn partial_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.part.pdf"))
}

/// Waits until `partial` is a complete PDF (it ends with `%%EOF` and stops growing), then
/// moves it to `path`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn finish(partial: &Path, path: &Path, timeout: Duration) -> Result<(), CommandError> {
    let started = Instant::now();
    let mut last = None;
    loop {
        if let Ok(bytes) = std::fs::read(partial) {
            let complete = bytes.starts_with(b"%PDF")
                && bytes.trim_ascii_end().ends_with(b"%%EOF")
                && last == Some(bytes.len());
            if complete {
                return std::fs::rename(partial, path)
                    .map_err(|e| io_error(format!("The PDF could not be saved: {e}")));
            }
            last = Some(bytes.len());
        }
        if started.elapsed() > timeout {
            let _ = std::fs::remove_file(partial);
            return Err(io_error("macOS did not finish the PDF in time."));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Prints the webview's page to `path` as PDF.
#[cfg(target_os = "macos")]
pub fn export<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    path: &Path,
    page: PdfPage,
) -> Result<(), CommandError> {
    check(path, &page)?;
    let partial = partial_path(path);
    let _ = std::fs::remove_file(&partial);
    let (tx, rx) = std::sync::mpsc::channel();
    let target = partial.clone();
    webview
        .with_webview(move |platform| {
            // Safety: `inner` is the window's WKWebView, used on the main thread.
            let started = unsafe { macos::print_to_file(platform.inner(), &target, page) };
            let _ = tx.send(started);
        })
        .map_err(|e| io_error(format!("The window could not print: {e}")))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| io_error("The window did not start printing."))?
        .map_err(io_error)?;
    finish(&partial, path, TIMEOUT)
}

#[cfg(not(target_os = "macos"))]
pub fn export<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    path: &Path,
    page: PdfPage,
) -> Result<(), CommandError> {
    check(path, &page)?;
    Err(io_error(
        "Export as PDF is available on macOS. Use Print and choose \"Save as PDF\" or \"Microsoft Print to PDF\".",
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::path::Path;

    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob,
        NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    use super::PdfPage;

    /// Starts a print operation of the web view that saves to `target`, without panels.
    ///
    /// # Safety
    /// `webview` must be a live `WKWebView`, and this must run on the main thread.
    pub unsafe fn print_to_file(
        webview: *mut c_void,
        target: &Path,
        page: PdfPage,
    ) -> Result<(), String> {
        let webview = unsafe { &*(webview as *const WKWebView) };
        let target = target.to_str().ok_or("The file name is not valid.")?;
        let info = NSPrintInfo::new();
        let (width, height) = if page.landscape {
            (page.height_pt, page.width_pt)
        } else {
            (page.width_pt, page.height_pt)
        };
        info.setPaperSize(NSSize::new(width, height));
        info.setOrientation(if page.landscape {
            NSPaperOrientation::Landscape
        } else {
            NSPaperOrientation::Portrait
        });
        info.setTopMargin(page.margin_pt);
        info.setBottomMargin(page.margin_pt);
        info.setLeftMargin(page.margin_pt);
        info.setRightMargin(page.margin_pt);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticallyCentered(false);
        info.setJobDisposition(unsafe { NSPrintSaveJob });
        let url = NSURL::fileURLWithPath(&NSString::from_str(target));
        unsafe {
            info.dictionary()
                .setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
        }
        let operation = unsafe { webview.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        // WebKit lays the page out in the operation's view, which starts without a size.
        if let Some(view) = operation.view() {
            view.setFrame(NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(width, height),
            ));
        }
        let window = webview
            .window()
            .ok_or("The score has no window to print from.")?;
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A4: PdfPage = PdfPage {
        width_pt: 595.0,
        height_pt: 842.0,
        margin_pt: 42.5,
        landscape: false,
    };

    #[test]
    fn accepts_a_pdf_in_an_existing_folder_only() {
        let dir = std::env::temp_dir();
        assert!(check(&dir.join("song.pdf"), &A4).is_ok());
        assert!(check(&dir.join("song.PDF"), &A4).is_ok());
        assert!(check(&dir.join("song.gp"), &A4).is_err());
        assert!(check(Path::new("song.pdf"), &A4).is_err());
        assert!(check(&dir.join("missing-folder-83").join("song.pdf"), &A4).is_err());
    }

    #[test]
    fn rejects_impossible_pages() {
        let file = std::env::temp_dir().join("song.pdf");
        for page in [
            PdfPage {
                width_pt: 0.0,
                ..A4
            },
            PdfPage {
                height_pt: f64::NAN,
                ..A4
            },
            PdfPage {
                margin_pt: -1.0,
                ..A4
            },
            PdfPage {
                width_pt: 1e9,
                ..A4
            },
        ] {
            assert!(check(&file, &page).is_err(), "{page:?}");
        }
    }

    #[test]
    fn writes_next_to_the_destination_first() {
        let partial = partial_path(Path::new("/music/My song.pdf"));
        assert_eq!(partial, Path::new("/music/.My song.pdf.part.pdf"));
    }

    #[test]
    fn moves_a_finished_pdf_into_place_and_gives_up_on_an_unfinished_one() {
        let dir = std::env::temp_dir().join(format!("smart-beat-pdf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("score.pdf");
        let partial = partial_path(&path);
        std::fs::write(&partial, b"%PDF-1.4\n...\n%%EOF\n").unwrap();
        finish(&partial, &path, Duration::from_secs(5)).unwrap();
        assert!(path.exists() && !partial.exists());

        std::fs::write(&partial, b"%PDF-1.4\nnot done").unwrap();
        let error = finish(&partial, &dir.join("other.pdf"), Duration::from_millis(400));
        assert!(error.is_err());
        assert!(!partial.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
