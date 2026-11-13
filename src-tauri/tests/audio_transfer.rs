//! Practice together sends the audio files of the lanes in pieces (ADR 0005): a file loaded on one
//! computer is read out in pieces by its id, staged on the other, checked against its id and loaded.
//! The piece upload takes a raw request body, so the test writes the staged part the way that
//! command does (a file named after the id in this run's staging folder).

use std::path::PathBuf;

use smart_beat_lib::audio::transfer::{
    audio_source_chunk, audio_source_size, audio_stage_abort, audio_stage_begin, audio_stage_finish,
};
use smart_beat_lib::audio::{AudioState, SourceLocation, audio_load_source};
use tauri::Manager;
use tauri::ipc::{InvokeResponseBody, IpcResponse};

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
            let s = (std::f64::consts::TAU * 330.0 * t).sin() * 9_000.0;
            writer.write_sample(s as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}

/// Where the staging commands keep unfinished files in this run.
fn staged(id: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!("smart-beat-incoming-{}", std::process::id()))
        .join(format!("{id}.part"))
}

fn raw(response: tauri::ipc::Response) -> Vec<u8> {
    match response.body().unwrap() {
        InvokeResponseBody::Raw(bytes) => bytes,
        InvokeResponseBody::Json(_) => panic!("pieces are raw bytes"),
    }
}

#[test]
fn a_loaded_file_moves_to_another_computer_in_pieces_by_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = tone_wav(1.0);
    let path = dir.path().join("tone.wav");
    std::fs::write(&path, &bytes).unwrap();

    let sender = tauri::test::mock_app();
    sender.manage(AudioState::new(dir.path().join("a")));
    let receiver = tauri::test::mock_app();
    receiver.manage(AudioState::new(dir.path().join("b")));

    let info = audio_load_source(SourceLocation::File { path }, sender.state()).unwrap();
    let size = audio_source_size(info.id.clone(), sender.state()).unwrap();
    assert_eq!(size, bytes.len() as u64);
    assert!(audio_source_size("c".repeat(64), sender.state()).is_err());
    assert!(audio_source_size("../x".into(), sender.state()).is_err());

    // The receiver has nothing yet; the pieces are read from the sender and written as staged.
    assert_eq!(audio_stage_begin(info.id.clone(), size).unwrap(), 0);
    let mut got = Vec::new();
    while (got.len() as u64) < size {
        let piece =
            raw(
                audio_source_chunk(info.id.clone(), got.len() as u64, 10 * 1024, sender.state())
                    .unwrap(),
            );
        assert!(!piece.is_empty() && piece.len() <= 10 * 1024);
        got.extend_from_slice(&piece);
        // Half way the transfer stops and starts again: it says how far it got.
        if got.len() as u64 >= size / 2 && !staged(&info.id).exists() {
            std::fs::write(staged(&info.id), &got).unwrap();
            assert_eq!(
                audio_stage_begin(info.id.clone(), size).unwrap(),
                got.len() as u64
            );
        }
    }
    std::fs::write(staged(&info.id), &got).unwrap();
    assert_eq!(got, bytes);

    let loaded = audio_stage_finish(info.id.clone(), "tone.wav".into(), receiver.state()).unwrap();
    assert_eq!(loaded.id, info.id);
    assert!((loaded.duration_ms - info.duration_ms).abs() < 1.0);
    assert!(!staged(&info.id).exists(), "the staged part is not kept");
    // The file is loaded on the receiver now, and can be sent on from there.
    assert_eq!(
        audio_source_size(info.id.clone(), receiver.state()).unwrap(),
        size
    );
}

#[test]
fn a_file_that_does_not_match_its_id_is_refused_and_removed() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = tauri::test::mock_app();
    receiver.manage(AudioState::new(dir.path().join("b")));
    let id = "d".repeat(64);
    audio_stage_begin(id.clone(), 1_000).unwrap();
    std::fs::write(staged(&id), tone_wav(0.1)).unwrap();
    assert!(audio_stage_finish(id.clone(), "x.wav".into(), receiver.state()).is_err());
    assert!(!staged(&id).exists());
    assert!(audio_source_size(id, receiver.state()).is_err());
}

#[test]
fn giving_up_removes_the_staged_parts() {
    let id = "e".repeat(64);
    audio_stage_begin(id.clone(), 100).unwrap();
    std::fs::write(staged(&id), [1, 2, 3]).unwrap();
    assert_eq!(audio_stage_begin(id.clone(), 100).unwrap(), 3);
    audio_stage_abort(Some(id.clone())).unwrap();
    assert!(!staged(&id).exists());
    // Giving up on all of them (no id) removes the whole staging folder: not tried here, the
    // tests of this file share it and run side by side.
    assert!(audio_stage_abort(Some("../x".into())).is_err());
}
