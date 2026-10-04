//! Plays an imported SFZ drum kit (#40): one-shot samples per key and
//! velocity layer, round robin, choke groups (an open hi-hat is cut by the
//! closed one) and a short self-choke on the kick so fast double kick does not
//! smear. Linear interpolation, constant-power pan. Written for Smart Beat;
//! never allocates while playing.

use std::sync::Arc;

use super::sfz::Region;

/// Decoded audio of one sample file, at its own rate.
#[derive(Debug, Clone)]
pub struct SampleData {
    pub rate: f32,
    pub left: Arc<[f32]>,
    pub right: Arc<[f32]>,
}

/// A kit ready to play: its regions and their decoded samples.
#[derive(Debug, Clone)]
pub struct SfzKit {
    pub regions: Vec<Region>,
    /// `samples[i]` belongs to `regions[i]` (shared when files repeat).
    pub samples: Vec<Arc<SampleData>>,
}

/// Kick keys: a new hit cuts the previous one (fast double kick stays tight).
const SELF_CHOKE_KEYS: [u8; 2] = [35, 36];
/// How long a choked voice fades.
const CHOKE_SECONDS: f32 = 0.004;

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    region: usize,
    key: u8,
    pos: f64,
    step: f64,
    gain_l: f32,
    gain_r: f32,
    /// Level multiplier; falls to zero while the voice is choked.
    env: f32,
    fade: f32,
    /// Order the voice started in (the oldest is stolen first).
    age: u64,
}

const SILENT: Voice = Voice {
    active: false,
    region: 0,
    key: 0,
    pos: 0.0,
    step: 0.0,
    gain_l: 0.0,
    gain_r: 0.0,
    env: 0.0,
    fade: 1.0,
    age: 0,
};

pub struct SfzSampler {
    kit: Arc<SfzKit>,
    rate: f32,
    voices: Box<[Voice]>,
    /// Round-robin counter of each key.
    seq: [u32; 128],
    random: u32,
    started: u64,
}

impl SfzSampler {
    pub fn new(kit: Arc<SfzKit>, sample_rate: f32, polyphony: usize) -> Self {
        Self {
            kit,
            rate: sample_rate,
            voices: vec![SILENT; polyphony.max(1)].into_boxed_slice(),
            seq: [0; 128],
            random: 0x2545_f491,
            started: 0,
        }
    }

    /// A number in 0…1 (xorshift: cheap and allocation-free).
    fn next_random(&mut self) -> f32 {
        let mut x = self.random;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.random = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }

    fn choke(&mut self, test: impl Fn(&Voice, &Region) -> bool) {
        let fade = 1.0 - 1.0 / (CHOKE_SECONDS * self.rate).max(1.0);
        for voice in self.voices.iter_mut().filter(|v| v.active) {
            if test(voice, &self.kit.regions[voice.region]) {
                voice.fade = voice.fade.min(fade);
            }
        }
    }

    pub fn note_on(&mut self, key: u8, velocity: u8) {
        if velocity == 0 {
            return; // one-shot drums: note offs change nothing
        }
        let key = key.min(127);
        let random = self.next_random();
        let seq = self.seq[key as usize];
        self.seq[key as usize] = seq.wrapping_add(1);
        let kit = self.kit.clone();
        let mut chokes_self = SELF_CHOKE_KEYS.contains(&key);
        for (index, region) in kit.regions.iter().enumerate() {
            let in_seq = (seq % region.seq_length.max(1)) + 1 == region.seq_position;
            if !region.plays(key, velocity)
                || !in_seq
                || random < region.lorand
                || random >= region.hirand.max(region.lorand + f32::EPSILON)
            {
                continue;
            }
            if region.group != 0 {
                let group = region.group;
                self.choke(|_, r| r.off_by == group);
            }
            if chokes_self {
                self.choke(|v, _| v.key == key);
                chokes_self = false;
            }
            self.start(index, region, key, velocity);
        }
    }

    fn start(&mut self, index: usize, region: &Region, key: u8, velocity: u8) {
        let sample = &self.kit.samples[index];
        let cents = region.tune
            + (f32::from(key) - f32::from(region.pitch_keycenter)) * region.pitch_keytrack;
        let step = f64::from(sample.rate / self.rate) * 2f64.powf(f64::from(cents) / 1200.0);
        let v = f32::from(velocity) / 127.0;
        let track = region.amp_veltrack / 100.0;
        let velocity_gain =
            (1.0 - track.abs()) + track.abs() * if track >= 0.0 { v * v } else { 1.0 - v * v };
        let gain = 10f32.powf(region.volume_db / 20.0) * velocity_gain;
        let angle = (region.pan / 100.0 + 1.0) * std::f32::consts::FRAC_PI_4;
        // Steal a free voice, else the oldest one.
        let slot = self
            .voices
            .iter()
            .position(|v| !v.active)
            .unwrap_or_else(|| {
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.age)
                    .map_or(0, |(i, _)| i)
            });
        self.started += 1;
        self.voices[slot] = Voice {
            active: true,
            region: index,
            key,
            pos: 0.0,
            step,
            gain_l: gain * angle.cos() * std::f32::consts::SQRT_2,
            gain_r: gain * angle.sin() * std::f32::consts::SQRT_2,
            env: 1.0,
            fade: 1.0,
            age: self.started,
        };
    }

    /// Adds the playing voices into `left` and `right` (which it overwrites).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        for voice in self.voices.iter_mut().filter(|v| v.active) {
            let sample = &self.kit.samples[voice.region];
            let len = sample.left.len();
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                let index = voice.pos as usize;
                if index + 1 >= len || voice.env < 1.0e-4 {
                    voice.active = false;
                    break;
                }
                let frac = (voice.pos - index as f64) as f32;
                let sl = sample.left[index] + (sample.left[index + 1] - sample.left[index]) * frac;
                let sr =
                    sample.right[index] + (sample.right[index + 1] - sample.right[index]) * frac;
                *l += sl * voice.gain_l * voice.env;
                *r += sr * voice.gain_r * voice.env;
                voice.env *= voice.fade;
                voice.pos += voice.step;
            }
        }
    }

    pub fn note_off_all(&mut self, immediate: bool) {
        if immediate {
            self.reset();
        } else {
            self.choke(|_, _| true);
        }
    }

    pub fn reset(&mut self) {
        for voice in self.voices.iter_mut() {
            voice.active = false;
        }
        self.seq = [0; 128];
    }

    /// Voices playing now (for tests).
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const RATE: f32 = 48_000.0;

    /// A one-second sample of a constant `level` (left) and `level / 2` (right).
    fn sample(level: f32) -> Arc<SampleData> {
        Arc::new(SampleData {
            rate: RATE,
            left: vec![level; 48_000].into(),
            right: vec![level / 2.0; 48_000].into(),
        })
    }

    fn region(key: u8, edit: impl FnOnce(&mut Region)) -> Region {
        let mut r = Region {
            sample: PathBuf::from("x.wav"),
            lokey: key,
            hikey: key,
            pitch_keycenter: key,
            pitch_keytrack: 0.0,
            amp_veltrack: 0.0,
            ..Region::default()
        };
        edit(&mut r);
        r
    }

    fn kit(regions: Vec<(Region, f32)>) -> Arc<SfzKit> {
        Arc::new(SfzKit {
            samples: regions.iter().map(|(_, level)| sample(*level)).collect(),
            regions: regions.into_iter().map(|(r, _)| r).collect(),
        })
    }

    fn render(sampler: &mut SfzSampler, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        sampler.render(&mut l, &mut r);
        (l, r)
    }

    #[test]
    fn picks_the_velocity_layer() {
        let k = kit(vec![
            (region(38, |r| r.hivel = 63), 0.1),
            (region(38, |r| r.lovel = 64), 0.5),
        ]);
        let mut s = SfzSampler::new(k, RATE, 8);
        s.note_on(38, 40);
        let (l, _) = render(&mut s, 64);
        assert!((l[10] - 0.1).abs() < 1e-3, "{}", l[10]);
        s.reset();
        s.note_on(38, 120);
        let (l, r) = render(&mut s, 64);
        assert!((l[10] - 0.5).abs() < 1e-3);
        assert!((r[10] - 0.25).abs() < 1e-3, "centred pan keeps the level");
        s.note_on(40, 100);
        assert_eq!(s.active_voices(), 1, "no region for key 40");
    }

    #[test]
    fn plays_round_robin_in_order() {
        let k = kit(vec![
            (
                region(38, |r| {
                    r.seq_length = 2;
                    r.seq_position = 1
                }),
                0.1,
            ),
            (
                region(38, |r| {
                    r.seq_length = 2;
                    r.seq_position = 2
                }),
                0.3,
            ),
        ]);
        let mut s = SfzSampler::new(k, RATE, 8);
        let mut heard = Vec::new();
        for _ in 0..4 {
            s.note_on(38, 100);
            let (l, _) = render(&mut s, 16);
            heard.push((l[8] * 10.0).round() / 10.0);
            s.reset_voices_for_test();
        }
        assert_eq!(heard, vec![0.1, 0.3, 0.1, 0.3]);
    }

    #[test]
    fn closed_hi_hat_chokes_the_open_one_quickly() {
        let k = kit(vec![
            (
                region(46, |r| {
                    r.group = 2;
                    r.off_by = 1
                }),
                0.4,
            ),
            (region(42, |r| r.group = 1), 0.0),
        ]);
        let mut s = SfzSampler::new(k, RATE, 8);
        s.note_on(46, 100);
        render(&mut s, 100);
        s.note_on(42, 100);
        // Within 50 ms the open hat is gone.
        let (l, _) = render(&mut s, 2_400);
        assert!(l[2_399].abs() < 1e-4, "{}", l[2_399]);
        assert!(l[0] > 0.1, "it fades, not a click");
        assert_eq!(s.active_voices(), 1);
    }

    #[test]
    fn a_new_kick_cuts_the_previous_one() {
        let k = kit(vec![(region(36, |_| {}), 0.5)]);
        let mut s = SfzSampler::new(k, RATE, 8);
        s.note_on(36, 100);
        render(&mut s, 100);
        s.note_on(36, 100);
        let (l, _) = render(&mut s, 2_400);
        // One voice left at full level (not two overlapping kicks).
        assert!((l[2_399] - 0.5).abs() < 1e-3, "{}", l[2_399]);
        assert_eq!(s.active_voices(), 1);
    }

    #[test]
    fn velocity_pan_volume_and_voice_stealing() {
        let k = kit(vec![(
            region(38, |r| {
                r.amp_veltrack = 100.0;
                r.pan = 100.0;
                r.volume_db = -6.0;
            }),
            1.0,
        )]);
        let mut s = SfzSampler::new(k, RATE, 2);
        s.note_on(38, 127);
        let (l, r) = render(&mut s, 32);
        assert!(l[8].abs() < 1e-6, "panned hard right");
        assert!((r[8] - 0.5 * 10f32.powf(-6.0 / 20.0) * std::f32::consts::SQRT_2).abs() < 1e-3);
        for _ in 0..5 {
            s.note_on(38, 64);
        }
        assert_eq!(s.active_voices(), 2, "the oldest voices are stolen");
        let (l, r) = render(&mut s, 48_000);
        assert!(l.iter().chain(&r).all(|v| v.is_finite()));
        assert_eq!(s.active_voices(), 0, "one-shots end with their sample");
    }

    #[test]
    fn pitched_regions_follow_the_key() {
        let k = kit(vec![(
            region(60, |r| {
                r.lokey = 48;
                r.hikey = 72;
                r.pitch_keytrack = 100.0;
            }),
            0.2,
        )]);
        let mut s = SfzSampler::new(k, RATE, 4);
        s.note_on(72, 100);
        assert!(
            (s.voices[0].step - 2.0).abs() < 1e-6,
            "an octave up plays twice as fast"
        );
    }

    impl SfzSampler {
        fn reset_voices_for_test(&mut self) {
            for v in self.voices.iter_mut() {
                v.active = false;
            }
        }
    }
}
