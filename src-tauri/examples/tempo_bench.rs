//! Tempo detection on real audio files (issue #186), no stems needed: the detector runs on the
//! mix. Prints the tempo, confidence, alternatives, sections and the time per file.
//!
//! ```sh
//! cargo run --release --example tempo_bench --manifest-path src-tauri/Cargo.toml -- \
//!     "song.mp3" "other.wav"
//! ```
//!
//! A `.mid` file next to the audio file (same name) has its tempo events read and printed as
//! the tab's tempo. That is a proxy: a tab is written to a click, the recording may differ.
//! Only numbers are printed; no audio is written anywhere.

use std::path::Path;
use std::time::Instant;

use smart_beat_lib::audio::backing::decode;
use smart_beat_lib::separation::tempo::{analyse, to_mono};

/// The tempo events of a Standard MIDI file as (tick, BPM), or `None` when it is not one.
fn midi_tempos(bytes: &[u8]) -> Option<(u16, Vec<(u64, f64)>)> {
    if bytes.get(0..4)? != b"MThd" {
        return None;
    }
    let division = u16::from_be_bytes([*bytes.get(12)?, *bytes.get(13)?]);
    let tracks = u16::from_be_bytes([*bytes.get(10)?, *bytes.get(11)?]);
    let mut pos = 8 + u32::from_be_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    let mut tempos = Vec::new();
    for _ in 0..tracks {
        if bytes.get(pos..pos + 4)? != b"MTrk" {
            return None;
        }
        let len = u32::from_be_bytes(bytes.get(pos + 4..pos + 8)?.try_into().ok()?) as usize;
        let track = bytes.get(pos + 8..pos + 8 + len)?;
        pos += 8 + len;
        let (mut i, mut tick, mut status) = (0usize, 0u64, 0u8);
        let var = |i: &mut usize| -> Option<u64> {
            let mut v = 0u64;
            loop {
                let b = *track.get(*i)?;
                *i += 1;
                v = (v << 7) | u64::from(b & 0x7f);
                if b & 0x80 == 0 {
                    return Some(v);
                }
            }
        };
        while i < track.len() {
            tick += var(&mut i)?;
            let first = *track.get(i)?;
            if first & 0x80 != 0 {
                status = first;
                i += 1;
            }
            match status {
                0xff => {
                    let kind = *track.get(i)?;
                    i += 1;
                    let n = var(&mut i)? as usize;
                    if kind == 0x51 && n == 3 {
                        let d = track.get(i..i + 3)?;
                        let us = u32::from_be_bytes([0, d[0], d[1], d[2]]);
                        tempos.push((tick, 60_000_000.0 / f64::from(us)));
                    }
                    i += n;
                }
                0xf0 | 0xf7 => {
                    let n = var(&mut i)? as usize;
                    i += n;
                }
                s if (0xc0..0xe0).contains(&(s & 0xf0)) => i += 1,
                _ => i += 2,
            }
        }
    }
    tempos.sort_by_key(|t| t.0);
    Some((division, tempos))
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: tempo_bench <audio file>...");
        std::process::exit(2);
    }
    for file in &files {
        let path = Path::new(file);
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                println!("{name}: cannot read: {e}");
                continue;
            }
        };
        let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
        let decode_start = Instant::now();
        let audio = match decode(bytes, ext.as_deref()) {
            Ok(a) => a,
            Err(e) => {
                println!("{name}: {e}");
                continue;
            }
        };
        let decode_secs = decode_start.elapsed().as_secs_f64();
        let mono = to_mono(&audio.left, &audio.right);
        let start = Instant::now();
        let result = analyse(&mono, None, audio.rate, &|| false);
        let secs = start.elapsed().as_secs_f64();
        let Ok(result) = result else {
            println!("{name}: stopped");
            continue;
        };
        let t = result.tempo;
        println!("{name}");
        println!(
            "  {:.1} s at {} Hz, decode {decode_secs:.2} s, tempo analysis {secs:.2} s",
            audio.duration(),
            audio.rate
        );
        println!(
            "  bpm {:.2}  confidence {:.2}  first beat {:.3} s  steady {}",
            t.bpm, t.confidence, t.first_beat_sec, t.steady
        );
        println!("  alternatives {:?}", t.alternatives);
        for s in &t.sections {
            println!(
                "  section {:.1}-{:.1} s: {:.2} bpm",
                s.start_sec, s.end_sec, s.bpm
            );
        }
        let midi = path.with_extension("mid");
        if let Some((division, tempos)) = std::fs::read(&midi).ok().and_then(|b| midi_tempos(&b)) {
            let list: Vec<String> = tempos
                .iter()
                .map(|(tick, bpm)| format!("{bpm:.2} bpm at tick {tick}"))
                .collect();
            println!("  .mid ({division} ticks/beat): {}", list.join(", "));
        }
    }
}
