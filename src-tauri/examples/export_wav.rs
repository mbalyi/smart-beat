//! Writes the synthetic band and the owner's songs as 32-bit float stereo WAV files into a
//! scratch folder, so a neural separator running in a container can read them (issue #186).
//!
//! ```sh
//! cargo run --release --example export_wav --manifest-path src-tauri/Cargo.toml -- <out dir> [song.mp3 name]...
//! ```
//!
//! Without song arguments only `<out>/synth/*.wav` is written. A song is given as a path and
//! the name of its folder: `"my song.mp3" my-song`. The files are for local use only; the
//! example prints sizes, never audio.

use std::fs;
use std::path::Path;

use smart_beat_lib::audio::backing::decode;
use smart_beat_lib::separation::synth;

/// A 32-bit float, 2-channel RIFF/WAVE file.
fn wav_bytes(rate: u32, left: &[f32], right: &[f32]) -> Vec<u8> {
    let data_len = (left.len() * 2 * 4) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 8).to_le_bytes());
    out.extend_from_slice(&8u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for (l, r) in left.iter().zip(right) {
        out.extend_from_slice(&l.to_le_bytes());
        out.extend_from_slice(&r.to_le_bytes());
    }
    out
}

fn write(path: &Path, rate: u32, left: &[f32], right: &[f32]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = wav_bytes(rate, left, right);
    // Read-back check of the header.
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(bytes.len(), 44 + left.len() * 8);
    fs::write(path, &bytes).unwrap();
    println!(
        "{}: {:.1} MB, {} Hz, {:.1} s",
        path.display(),
        bytes.len() as f64 / 1e6,
        rate,
        left.len() as f64 / rate as f64
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = Path::new(
        args.first()
            .expect("usage: export_wav <out dir> [mp3 name]..."),
    );
    let band = synth::band(30.0);
    for (name, part) in [
        ("mix", &band.mix),
        ("drums", &band.drums),
        ("bass", &band.bass),
        ("vocals", &band.vocals),
        ("guitars", &band.guitars),
    ] {
        write(
            &out.join("synth").join(format!("{name}.wav")),
            synth::RATE,
            &part.left,
            &part.right,
        );
    }
    for pair in args[1..].chunks(2) {
        let [path, name] = pair else {
            panic!("songs come as <path> <name> pairs");
        };
        let ext = Path::new(path).extension().and_then(|e| e.to_str());
        let audio = decode(fs::read(path).unwrap(), ext).unwrap();
        if audio.rate != 44_100 {
            println!("WARNING: {name} is {} Hz, not 44100", audio.rate);
        }
        write(
            &out.join(name).join("mix.wav"),
            audio.rate,
            &audio.left,
            &audio.right,
        );
    }
}
