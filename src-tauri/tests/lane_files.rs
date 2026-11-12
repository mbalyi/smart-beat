//! Audio lanes are decoded and edited with any audio engine: opening a file, its analysis, the
//! lane settings and letting files go work while no engine runs. Only playback needs an engine.

use smart_beat_lib::audio::{
    AudioState, LanesData, SourceLocation, audio_detect_beats, audio_extract_source,
    audio_forget_sources, audio_load_source, audio_loudness, audio_set_lanes, audio_silent_regions,
    audio_spectrogram, audio_state, audio_zero_crossing,
};
use tauri::Manager;

/// A 440 Hz tone, mono, 16-bit, `seconds` long.
fn tone_wav(seconds: f64) -> Vec<u8> {
    let rate = 22_050u32;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for i in 0..(seconds * f64::from(rate)) as usize {
            let t = i as f64 / f64::from(rate);
            let s = (std::f64::consts::TAU * 440.0 * t).sin() * 12_000.0;
            writer.write_sample(s as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}

#[test]
fn lane_files_load_and_analyse_without_an_engine() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tone.wav");
    std::fs::write(&path, tone_wav(2.0)).unwrap();
    let app = tauri::test::mock_app();
    app.manage(AudioState::new(dir.path().join("library")));
    let status = audio_state(app.state()).unwrap();
    assert!(!status.running, "no engine runs in this test");

    let info = audio_load_source(SourceLocation::File { path: path.clone() }, app.state())
        .expect("a file opens without an engine");
    assert!((info.duration_ms - 2000.0).abs() < 5.0);
    assert!(!info.peaks.is_empty());
    let id = info.id.clone();

    let crossing = audio_zero_crossing(id.clone(), 500.0, app.state()).unwrap();
    assert!((crossing - 500.0).abs() <= 10.0);
    let loudness = audio_loudness(id.clone(), 0.0, 2000.0, app.state()).unwrap();
    assert!(loudness.peak_db < 0.0 && loudness.peak_db > -20.0);
    assert!(audio_detect_beats(id.clone(), app.state()).is_ok());
    let columns = audio_spectrogram(id.clone(), 0.0, 1000.0, 8, 16, app.state()).unwrap();
    assert_eq!(columns.len(), 8);
    let regions = audio_silent_regions(id.clone(), -50.0, 100.0, 0.0, app.state()).unwrap();
    assert!(regions.is_empty(), "a steady tone has no quiet part");
    let copy = dir.path().join("copy.wav");
    audio_extract_source(id.clone(), copy.clone(), true, app.state()).unwrap();
    assert!(copy.exists());

    // The lanes are stored for a later engine; files not kept are let go of.
    let lanes = LanesData {
        audio: Default::default(),
        sync: vec![],
        transpose: 0,
    };
    audio_set_lanes(Some(lanes), app.state()).unwrap();
    audio_set_lanes(None, app.state()).unwrap();
    audio_forget_sources(vec![], app.state());
    assert!(
        audio_zero_crossing(id, 500.0, app.state()).is_err(),
        "a forgotten file is gone"
    );
    assert!(!audio_state(app.state()).unwrap().running);
}
