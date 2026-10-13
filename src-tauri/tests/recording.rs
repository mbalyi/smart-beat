//! Record to tab: plucked-string-like tones at known times go through the same path as the
//! `transcribe_recording` command, and the notes come back at the right pitches and times.

use smart_beat_lib::recording::{
    BasicPitch, Instrument, RecordedNote, Transcriber, transcribe_take,
};
use std::f64::consts::PI;

const RATE: u32 = 44_100;

/// A plucked string: a few harmonics, each fading faster than the one below, after a short
/// noise-like attack. `frequency` in Hz, `seconds` long.
fn pluck(frequency: f64, seconds: f64, seed: u32) -> Vec<f32> {
    let mut noise = seed;
    (0..(seconds * f64::from(RATE)) as usize)
        .map(|n| {
            let t = n as f64 / f64::from(RATE);
            let tone: f64 = (1..=8)
                .map(|k| {
                    let k = f64::from(k);
                    let decay = (-t * (1.5 + 0.9 * k)).exp();
                    (2.0 * PI * frequency * k * t).sin() * decay / k.powf(1.1)
                })
                .sum();
            noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let hiss = f64::from(noise >> 8) / f64::from(1u32 << 24) - 0.5;
            let attack = hiss * (-t * 90.0).exp() * 0.3;
            ((tone * 0.35 + attack) * (1.0 - (-t * 400.0).exp())) as f32
        })
        .collect()
}

fn hz(midi: u8) -> f64 {
    440.0 * 2f64.powf((f64::from(midi) - 69.0) / 12.0)
}

/// `(start second, MIDI pitches played together)`.
const SCORE: [(f64, &[u8]); 5] = [
    (0.5, &[40]),
    (2.0, &[45]),
    (3.5, &[55]),
    (5.0, &[64]),
    (6.5, &[45, 52]),
];

fn take() -> Vec<f32> {
    let mut audio = vec![0.0f32; RATE as usize * 9];
    for (i, (start, pitches)) in SCORE.iter().enumerate() {
        for &pitch in *pitches {
            let tone = pluck(hz(pitch), 1.3, 7 + i as u32);
            let from = (start * f64::from(RATE)) as usize;
            for (slot, sample) in audio[from..].iter_mut().zip(tone) {
                *slot += sample;
            }
        }
    }
    audio
}

fn transcribe(samples: &[f32], rate: u32) -> Vec<RecordedNote> {
    transcribe_take(&BasicPitch::default(), samples, rate, &mut |_| {}, &|| {
        false
    })
    .unwrap()
}

#[test]
fn finds_plucked_notes_and_a_chord_at_the_right_times() {
    let notes = transcribe(&take(), RATE);
    for (start, pitches) in SCORE {
        for &pitch in pitches {
            let hit = notes
                .iter()
                .find(|n| n.pitch == pitch && (n.start - start).abs() <= 0.05);
            assert!(
                hit.is_some(),
                "no note {pitch} near {start} s in {notes:#?}"
            );
            let hit = hit.unwrap();
            assert!(hit.end > hit.start + 0.1 && (1..=127).contains(&hit.velocity));
        }
    }
    // Upper harmonics can show up as brief extra notes at an onset (A4 and E5 above A2 and
    // E3 here). Anything else, or anything long, is a miss.
    let played: Vec<u8> = SCORE.iter().flat_map(|(_, p)| p.iter().copied()).collect();
    let stray: Vec<_> = notes
        .iter()
        .filter(|n| !played.contains(&n.pitch))
        .collect();
    assert!(stray.len() <= 4, "stray notes: {stray:#?}");
    assert!(
        stray.iter().all(|n| n.end - n.start < 0.5 && n.pitch >= 64),
        "stray notes: {stray:#?}"
    );
}

#[test]
fn the_piano_settings_keep_the_played_notes_and_do_not_add_strays() {
    let samples = take();
    let guitar = transcribe(&samples, RATE);
    let piano = transcribe_take(
        &Instrument::Piano.engine(),
        &samples,
        RATE,
        &mut |_| {},
        &|| false,
    )
    .unwrap();
    for (start, pitches) in SCORE {
        for &pitch in pitches {
            assert!(
                piano
                    .iter()
                    .any(|n| n.pitch == pitch && (n.start - start).abs() <= 0.05),
                "no note {pitch} near {start} s in {piano:#?}"
            );
        }
    }
    assert!(piano.len() <= guitar.len(), "{piano:#?} vs {guitar:#?}");
    assert!(piano.iter().all(|n| (21..=108).contains(&n.pitch)));
}

#[test]
fn another_input_rate_gives_the_same_notes() {
    let notes = transcribe(&take(), RATE);
    // 48 kHz is what most sound cards report.
    let converted = smart_beat_lib::recording::resample(&take(), RATE, 48_000);
    let other = transcribe(&converted, 48_000);
    for (start, pitches) in SCORE {
        for &pitch in pitches {
            assert!(
                other
                    .iter()
                    .any(|n| n.pitch == pitch && (n.start - start).abs() <= 0.05),
                "no note {pitch} near {start} s at 48 kHz in {other:#?}"
            );
        }
    }
    assert!(!notes.is_empty());
}

#[test]
fn silence_gives_no_notes() {
    assert!(transcribe(&vec![0.0; RATE as usize * 3], RATE).is_empty());
}

#[test]
fn a_stop_request_returns_the_stopped_error() {
    let error = BasicPitch::default()
        .transcribe(&take(), RATE, &mut |_| {}, &|| true)
        .unwrap_err();
    assert_eq!(error.message, "Transcription stopped.");
}
