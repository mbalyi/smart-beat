//! A small synthetic band with known stems, for the tests and the benchmark: kick, snare and
//! hats in the centre, a bass line in the centre, a vocal-like line in the centre, and two
//! distorted guitars panned hard left and hard right. Every part is returned on its own, so the
//! mix has exact ground truth.

use std::f32::consts::TAU;

pub const RATE: u32 = 44_100;

/// A stereo signal.
#[derive(Debug, Clone, Default)]
pub struct Stereo {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl Stereo {
    pub fn silent(len: usize) -> Self {
        Self {
            left: vec![0.0; len],
            right: vec![0.0; len],
        }
    }

    fn add_into(&mut self, start: usize, mono: &[f32], gain_l: f32, gain_r: f32) {
        for (i, v) in mono.iter().enumerate() {
            if let Some(l) = self.left.get_mut(start + i) {
                *l += v * gain_l;
            }
            if let Some(r) = self.right.get_mut(start + i) {
                *r += v * gain_r;
            }
        }
    }

    pub fn mix(parts: &[&Stereo]) -> Stereo {
        let len = parts.iter().map(|p| p.left.len()).max().unwrap_or(0);
        let mut out = Stereo::silent(len);
        for p in parts {
            for (o, v) in out.left.iter_mut().zip(&p.left) {
                *o += v;
            }
            for (o, v) in out.right.iter_mut().zip(&p.right) {
                *o += v;
            }
        }
        out
    }
}

/// Deterministic white noise in -1..1.
pub struct Noise(u32);

impl Noise {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    pub fn sample(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
    }
}

pub struct Band {
    pub drums: Stereo,
    pub bass: Stereo,
    pub vocals: Stereo,
    pub guitars: Stereo,
    pub mix: Stereo,
}

fn seconds(s: f32) -> usize {
    (s * RATE as f32) as usize
}

fn kick() -> Vec<f32> {
    let n = seconds(0.25);
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let hz = 50.0 + 90.0 * (-t * 40.0).exp();
            phase += TAU * hz / RATE as f32;
            phase.sin() * (-t * 14.0).exp()
        })
        .collect()
}

fn snare(noise: &mut Noise) -> Vec<f32> {
    let n = seconds(0.2);
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            (noise.sample() * 0.8 + (TAU * 190.0 * t).sin() * 0.4) * (-t * 22.0).exp()
        })
        .collect()
}

fn hat(noise: &mut Noise) -> Vec<f32> {
    let n = seconds(0.05);
    let mut last = 0.0;
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let x = noise.sample();
            let hp = x - last; // crude high-pass
            last = x;
            hp * 0.5 * (-t * 70.0).exp()
        })
        .collect()
}

/// A note with `partials` harmonics of falling amplitude, an attack/decay envelope and optional
/// soft clipping (a distorted guitar).
fn note(hz: f32, secs: f32, partials: usize, decay: f32, drive: f32, vibrato: f32) -> Vec<f32> {
    let n = seconds(secs);
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let hz = hz * (1.0 + vibrato * 0.012 * (TAU * 5.5 * t).sin());
            let ph = TAU * hz * t;
            let mut v = 0.0;
            for k in 1..=partials {
                v += (ph * k as f32).sin() / (k as f32).powf(1.1);
            }
            let env = (t * 80.0).min(1.0) * (-t * decay).exp();
            let mut v = v * env;
            if drive > 0.0 {
                v = (v * drive).tanh();
            }
            v
        })
        .collect()
}

/// A `secs`-long band at 120 BPM.
pub fn band(secs: f32) -> Band {
    let len = seconds(secs);
    let beat = seconds(0.5);
    let mut noise = Noise::new(7);
    let (mut drums, mut bass, mut vocals, mut guitars) = (
        Stereo::silent(len),
        Stereo::silent(len),
        Stereo::silent(len),
        Stereo::silent(len),
    );
    let k = kick();
    let s = snare(&mut noise);
    let h = hat(&mut noise);
    let bass_notes = [55.0f32, 55.0, 73.4, 82.4];
    let vocal_notes = [293.7f32, 329.6, 349.2, 392.0];
    let gtr_left = [110.0f32, 146.8, 164.8, 123.5];
    let gtr_right = [165.0f32, 220.0, 247.0, 185.0];
    let beats = len / beat;
    for b in 0..beats {
        let at = b * beat;
        if b % 2 == 0 {
            drums.add_into(at, &k, 0.9, 0.9);
        } else {
            drums.add_into(at, &s, 0.7, 0.7);
        }
        drums.add_into(at, &h, 0.35, 0.35);
        drums.add_into(at + beat / 2, &h, 0.25, 0.25);
        let i = (b / 2) % 4;
        bass.add_into(at, &note(bass_notes[i], 0.48, 4, 3.0, 0.0, 0.0), 0.5, 0.5);
        // The vocal sings on beats 0 and 1 of every bar, rests on the others.
        if b % 4 < 2 {
            vocals.add_into(
                at,
                &note(vocal_notes[(b / 4) % 4], 0.48, 8, 1.5, 0.0, 1.0),
                0.35,
                0.35,
            );
        }
        guitars.add_into(at, &note(gtr_left[i], 0.5, 10, 2.0, 3.0, 0.0), 0.35, 0.0);
        guitars.add_into(at, &note(gtr_right[i], 0.5, 10, 2.0, 3.0, 0.0), 0.0, 0.35);
    }
    let mix = Stereo::mix(&[&drums, &bass, &vocals, &guitars]);
    Band {
        drums,
        bass,
        vocals,
        guitars,
        mix,
    }
}
