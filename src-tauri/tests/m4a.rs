//! M4A export with the system encoder (macOS, Windows): the file is written, then read
//! back with the app's own decoder (symphonia, with the AAC and MP4 readers
//! enabled for the tests) to check the sound that comes out.
#![cfg(any(target_os = "macos", windows))]

use std::f64::consts::TAU;
use std::fs;
use std::io::Cursor;

use smart_beat_lib::audio::backing::{DecodedAudio, decode};
use smart_beat_lib::error::ErrorKind;
use smart_beat_lib::m4a;

/// A 16-bit WAV file with a sine per channel (440 Hz left, 660 Hz right), half full scale.
fn tone_wav(seconds: f64, rate: u32, channels: u16) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(Cursor::new(&mut bytes), spec).unwrap();
        for frame in 0..(seconds * f64::from(rate)) as usize {
            let t = frame as f64 / f64::from(rate);
            for channel in 0..channels {
                let hz = 440.0 + 220.0 * f64::from(channel);
                let value = 0.5 * (TAU * hz * t).sin();
                writer.write_sample((value * 32_767.0) as i16).unwrap();
            }
        }
        writer.finalize().unwrap();
    }
    bytes
}

fn read(path: &std::path::Path) -> DecodedAudio {
    decode(fs::read(path).unwrap(), Some("m4a")).expect("the .m4a file decodes")
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// How many times the signal crosses zero (twice per period of a sine).
fn crossings(samples: &[f32]) -> usize {
    samples
        .windows(2)
        .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
        .count()
}

#[test]
fn writes_stereo_aac_that_sounds_like_the_input() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("my mix é.m4a");

    m4a::encode(&tone_wav(2.0, 44_100, 2), &path).unwrap();

    let bytes = fs::read(&path).unwrap();
    assert_eq!(&bytes[4..8], b"ftyp", "an MP4 container");
    assert!(bytes.len() > 10_000, "{} bytes", bytes.len());
    let audio = read(&path);
    assert_eq!((audio.rate, audio.channels), (44_100, 2));
    let seconds = audio.left.len() as f64 / f64::from(audio.rate);
    // AAC adds a little priming and padding around the sound.
    assert!((1.9..2.2).contains(&seconds), "{seconds} s");
    // Half scale sine: about 0.35 RMS, and each channel keeps its own pitch.
    for side in [&audio.left, &audio.right] {
        let level = rms(side);
        assert!((0.28..0.42).contains(&level), "rms {level}");
    }
    let (left, right) = (
        crossings(&audio.left) as f64 / seconds,
        crossings(&audio.right) as f64 / seconds,
    );
    assert!(
        (left - 880.0).abs() < 30.0,
        "{left} crossings per second on the left"
    );
    assert!(
        (right - 1320.0).abs() < 40.0,
        "{right} crossings per second on the right"
    );
}

#[test]
fn writes_mono_and_other_sample_rates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mono.m4a");

    m4a::encode(&tone_wav(1.0, 48_000, 1), &path).unwrap();

    let audio = read(&path);
    assert_eq!((audio.rate, audio.channels), (48_000, 1));
    assert!(rms(&audio.left) > 0.28);
}

#[test]
fn sound_longer_than_one_buffer_is_written_whole() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("long.m4a");
    // 5 seconds is several 32768-frame buffers.
    m4a::encode(&tone_wav(5.0, 44_100, 2), &path).unwrap();
    let seconds = read(&path).left.len() as f64 / 44_100.0;
    assert!((4.9..5.3).contains(&seconds), "{seconds} s");
}

#[test]
fn replaces_an_existing_file_and_leaves_no_temporary_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mix.m4a");
    fs::write(&path, b"old").unwrap();

    m4a::encode(&tone_wav(0.5, 44_100, 2), &path).unwrap();

    assert_eq!(&fs::read(&path).unwrap()[4..8], b"ftyp");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn keeps_the_permissions_of_the_replaced_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mix.m4a");
    fs::write(&path, b"old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    m4a::encode(&tone_wav(0.5, 44_100, 2), &path).unwrap();

    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o644
    );
}

#[test]
fn an_unusable_wav_leaves_the_existing_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mix.m4a");
    fs::write(&path, b"keep").unwrap();

    let error = m4a::encode(b"not a wav", &path).unwrap_err();

    assert_eq!(error.kind, ErrorKind::Audio);
    assert_eq!(fs::read(&path).unwrap(), b"keep");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
