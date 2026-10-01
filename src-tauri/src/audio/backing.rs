//! The audio track: an mp3 / wav / flac / ogg / aiff recording played along
//! with the score (issue #38).
//!
//! The file is decoded once (Symphonia, MPL-2.0, used unmodified). Sync
//! points tie bars of the score to times in the recording; [`SyncMap`] turns
//! any song position into a position in the recording, so seeking and looping
//! stay aligned by construction. [`Stretcher`] plays the recording at the
//! speed the sync map and the playback rate ask for without changing its
//! pitch (WSOLA: overlapping windowed grains, each placed where it best
//! continues the previous one), and transposes it by reading the grains
//! faster or slower.

use std::f64::consts::PI;
use std::io::Cursor;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use super::dsp::Effect;
use super::dsp::biquad::{Biquad, Coefficients, FilterKind};
use super::dsp::eq::Eq;
use super::mixing::{TrackEq, mix_into, pan_gains};

/// File types the audio track opens. Mirrored by `AUDIO_EXTENSIONS` in `src/lib/tauri.ts`.
pub const AUDIO_EXTENSIONS: [&str; 7] = ["mp3", "wav", "flac", "ogg", "oga", "aif", "aiff"];
/// Longest recording accepted (memory: about 10 MB per stereo minute at 44.1 kHz).
pub const MAX_SECONDS: f64 = 30.0 * 60.0;
/// Largest encoded file accepted.
pub const MAX_FILE_BYTES: usize = 512 * 1024 * 1024;
/// Waveform resolution sent to the UI.
pub const PEAKS_PER_SECOND: u32 = 100;

/// A decoded recording, stereo (mono files are doubled), at its own rate.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    pub rate: u32,
    pub channels: usize,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl DecodedAudio {
    pub fn frames(&self) -> usize {
        self.left.len()
    }

    pub fn duration(&self) -> f64 {
        self.frames() as f64 / self.rate.max(1) as f64
    }

    /// The loudest sample of each 1/[`PEAKS_PER_SECOND`] s, for the waveform.
    pub fn peaks(&self) -> Vec<f32> {
        let frames = self.frames();
        let rate = self.rate.max(1) as usize;
        let per = PEAKS_PER_SECOND as usize;
        let count = (frames * per).div_ceil(rate);
        (0..count)
            .map(|i| {
                let (a, b) = (i * rate / per, ((i + 1) * rate / per).min(frames));
                self.left[a..b]
                    .iter()
                    .chain(&self.right[a..b])
                    .fold(0.0f32, |acc, s| acc.max(s.abs()))
                    .min(1.0)
            })
            .collect()
    }
}

/// Decodes an encoded file. `extension` helps the format probe.
pub fn decode(bytes: Vec<u8>, extension: Option<&str>) -> Result<DecodedAudio, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err("The audio file is too large".into());
    }
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("The audio file cannot be read: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("The file has no audio")?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("The file has no audio")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("The audio format is not supported: {e}"))?;

    let mut rate = 0u32;
    let mut channels = 0usize;
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut interleaved: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(DecodeError::IoError(_)) => break,
            Err(e) => return Err(format!("The audio file is damaged: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            // A damaged frame: skip it, like players do.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("The audio file cannot be decoded: {e}")),
        };
        let spec = buffer.spec();
        if rate == 0 {
            rate = spec.rate();
            channels = spec.channels().count().max(1);
        }
        let ch = spec.channels().count().max(1);
        interleaved.resize(buffer.samples_interleaved(), 0.0);
        buffer.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved.chunks(ch) {
            left.push(frame[0]);
            right.push(*frame.get(1).unwrap_or(&frame[0]));
        }
        if rate > 0 && left.len() as f64 / rate as f64 > MAX_SECONDS {
            return Err(format!(
                "The recording is longer than {} minutes",
                MAX_SECONDS / 60.0
            ));
        }
    }
    if rate == 0 || left.is_empty() {
        return Err("The audio file is empty".into());
    }
    for s in left.iter_mut().chain(right.iter_mut()) {
        if !s.is_finite() {
            *s = 0.0;
        }
    }
    Ok(DecodedAudio {
        rate,
        channels,
        left,
        right,
    })
}

/// Song seconds → recording seconds, through the sync points.
///
/// Between two points the recording is stretched linearly; before the first
/// and after the last it runs at the score's speed (slope 1). Without points
/// the recording starts with the song.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncMap {
    /// (song seconds, recording seconds), both strictly increasing.
    points: Vec<(f64, f64)>,
}

impl SyncMap {
    /// Points out of order (a later bar at an earlier time) are dropped.
    pub fn new(mut points: Vec<(f64, f64)>) -> Self {
        points.retain(|(s, a)| s.is_finite() && a.is_finite());
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut kept: Vec<(f64, f64)> = Vec::with_capacity(points.len());
        for p in points {
            match kept.last() {
                Some(last) if p.0 <= last.0 || p.1 <= last.1 => {}
                _ => kept.push(p),
            }
        }
        Self { points: kept }
    }

    pub fn points(&self) -> &[(f64, f64)] {
        &self.points
    }

    pub fn audio_at(&self, song: f64) -> f64 {
        let Some(&(s0, a0)) = self.points.first() else {
            return song;
        };
        if song <= s0 {
            return a0 + (song - s0);
        }
        let i = self.points.partition_point(|p| p.0 <= song);
        let (sa, aa) = self.points[i - 1];
        match self.points.get(i) {
            Some(&(sb, ab)) => aa + (song - sa) * (ab - aa) / (sb - sa),
            None => aa + (song - sa),
        }
    }

    /// Recording seconds per song second at `song`.
    pub fn slope_at(&self, song: f64) -> f64 {
        let i = self.points.partition_point(|p| p.0 <= song);
        match (i.checked_sub(1).map(|j| self.points[j]), self.points.get(i)) {
            (Some((sa, aa)), Some(&(sb, ab))) => (ab - aa) / (sb - sa),
            _ => 1.0,
        }
    }
}

/// Band-limited interpolation (windowed sinc, Blackman window) for reading the
/// recording at any fractional position and any speed.
pub struct Interpolator {
    /// Taps for each of `PHASES` fractional positions.
    table: Vec<f32>,
}

const TAPS: usize = 16;
const HALF: isize = (TAPS / 2) as isize;
const PHASES: usize = 512;

impl Interpolator {
    /// `step`: source samples advanced per output sample; above 1 the cutoff
    /// drops so reading faster does not alias.
    pub fn new(step: f64) -> Self {
        let cutoff = if step > 1.0 { 1.0 / step } else { 1.0 };
        let mut table = vec![0.0f32; PHASES * TAPS];
        for phase in 0..PHASES {
            let frac = phase as f64 / PHASES as f64;
            let row = &mut table[phase * TAPS..(phase + 1) * TAPS];
            let mut sum = 0.0;
            for (k, tap) in row.iter_mut().enumerate() {
                // Distance from the tap to the read position.
                let x = (k as isize - HALF + 1) as f64 - frac;
                let sinc = if x.abs() < 1e-9 {
                    1.0
                } else {
                    (PI * x * cutoff).sin() / (PI * x)
                };
                let sinc = if x.abs() < 1e-9 { cutoff } else { sinc };
                let w = (x + HALF as f64) / TAPS as f64;
                let window = if (0.0..=1.0).contains(&w) {
                    0.42 - 0.5 * (2.0 * PI * w).cos() + 0.08 * (4.0 * PI * w).cos()
                } else {
                    0.0
                };
                *tap = (sinc * window) as f32;
                sum += sinc * window;
            }
            // Unity gain at DC for every phase.
            if sum.abs() > 1e-9 {
                row.iter_mut().for_each(|t| *t = (*t as f64 / sum) as f32);
            }
        }
        Self { table }
    }

    /// The signal at `pos` (in samples); zero outside the recording.
    #[inline]
    pub fn read(&self, samples: &[f32], pos: f64) -> f32 {
        let base = pos.floor();
        let frac = pos - base;
        let base = base as isize;
        let phase = ((frac * PHASES as f64) as usize).min(PHASES - 1);
        let taps = &self.table[phase * TAPS..(phase + 1) * TAPS];
        let start = base - HALF + 1;
        let len = samples.len() as isize;
        if start >= 0 && start + TAPS as isize <= len {
            let s = &samples[start as usize..start as usize + TAPS];
            s.iter().zip(taps).map(|(a, b)| a * b).sum()
        } else {
            let mut acc = 0.0;
            for (k, t) in taps.iter().enumerate() {
                let i = start + k as isize;
                if i >= 0 && i < len {
                    acc += samples[i as usize] * t;
                }
            }
            acc
        }
    }
}

/// WSOLA time-stretcher with pitch shift.
pub struct Stretcher {
    grain: usize,
    hop: usize,
    window: Vec<f32>,
    acc: [Vec<f32>; 2],
    /// Output samples of `acc` ready to play.
    ready: usize,
    /// Where the previous grain started in the recording (source samples).
    prev_start: Option<f64>,
    /// Source samples read per output sample inside a grain (pitch × rates).
    step: f64,
    interpolator: Interpolator,
    tolerance: usize,
}

impl Stretcher {
    /// `step` = pitch ratio × source rate / output rate.
    pub fn new(output_rate: f32, step: f64) -> Self {
        // About 43 ms grains, an even number of samples.
        let grain = (((output_rate * 0.043) as usize) / 2 * 2).max(64);
        let hop = grain / 2;
        // Periodic Hann: overlapping by half, the windows sum to exactly 1.
        let window = (0..grain)
            .map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / grain as f64).cos()) as f32)
            .collect();
        Self {
            grain,
            hop,
            window,
            acc: [vec![0.0; grain], vec![0.0; grain]],
            ready: 0,
            prev_start: None,
            step,
            interpolator: Interpolator::new(step),
            tolerance: (output_rate * 0.012) as usize,
        }
    }

    pub fn step(&self) -> f64 {
        self.step
    }

    pub fn reset(&mut self) {
        self.acc.iter_mut().for_each(|a| a.fill(0.0));
        self.ready = 0;
        self.prev_start = None;
    }

    /// Fills `out`, asking `target(i)` where the recording should be (source
    /// samples) at output sample `i` of this call.
    pub fn render(
        &mut self,
        audio: &DecodedAudio,
        out: (&mut [f32], &mut [f32]),
        target: impl Fn(usize) -> f64,
    ) {
        let n = out.0.len();
        let mut done = 0;
        while done < n {
            if self.ready == 0 {
                self.add_grain(audio, target(done));
            }
            let offset = self.hop - self.ready;
            let take = self.ready.min(n - done);
            out.0[done..done + take].copy_from_slice(&self.acc[0][offset..offset + take]);
            out.1[done..done + take].copy_from_slice(&self.acc[1][offset..offset + take]);
            self.ready -= take;
            done += take;
            if self.ready == 0 {
                for a in &mut self.acc {
                    a.copy_within(self.hop.., 0);
                    a[self.hop..].fill(0.0);
                }
            }
        }
    }

    fn add_grain(&mut self, audio: &DecodedAudio, target: f64) {
        let natural = self.prev_start.map(|p| p + self.hop as f64 * self.step);
        let start = match natural {
            // On track (normal speed, no transposition): continue exactly.
            Some(natural) if (natural - target).abs() < 0.5 => natural,
            // A seek or loop: jump.
            Some(natural)
                if (natural - target).abs() > (self.grain as f64 * self.step.max(1.0) * 4.0) =>
            {
                target
            }
            Some(natural) => self.best_start(audio, natural, target),
            None => target,
        };
        for (channel, samples) in [&audio.left, &audio.right].into_iter().enumerate() {
            let acc = &mut self.acc[channel];
            for (i, w) in self.window.iter().enumerate() {
                let pos = start + i as f64 * self.step;
                acc[i] += w * self.interpolator.read(samples, pos);
            }
        }
        self.prev_start = Some(start);
        self.ready = self.hop;
    }

    /// The start near `target` whose first half looks most like `natural`'s
    /// (what would have followed the previous grain), so grains join in phase.
    fn best_start(&self, audio: &DecodedAudio, natural: f64, target: f64) -> f64 {
        const STRIDE: usize = 4;
        let len = self.hop / STRIDE;
        let mono = |pos: f64| {
            let i = pos as isize;
            if i < 0 || i as usize >= audio.left.len() {
                0.0
            } else {
                audio.left[i as usize] + audio.right[i as usize]
            }
        };
        let reference: Vec<f32> = (0..len)
            .map(|k| mono(natural + (k * STRIDE) as f64 * self.step))
            .collect();
        let mut best = (f32::MIN, target);
        let tolerance = self.tolerance as isize;
        let mut delta = -tolerance;
        while delta <= tolerance {
            let candidate = target + delta as f64;
            let score: f32 = reference
                .iter()
                .enumerate()
                .map(|(k, r)| r * mono(candidate + (k * STRIDE) as f64 * self.step))
                .sum();
            if score > best.0 {
                best = (score, candidate);
            }
            delta += 2;
        }
        best.1
    }
}

/// Filter for practising against a recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackingFilter {
    #[default]
    Off,
    /// Keep only the low end (bass and kick).
    BassIsolate,
    /// Keep the guitar range.
    GuitarBand,
    /// Remove what is panned to the centre (usually vocals and solo).
    CentreCut,
}

/// Settings of the audio track. Mirrored by `AudioTrackSettings` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackingParams {
    pub enabled: bool,
    pub volume: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub eq: TrackEq,
    /// -24…24.
    pub semitones: i32,
    /// -100…100.
    pub cents: i32,
    pub filter: BackingFilter,
}

impl Default for BackingParams {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            eq: TrackEq::default(),
            semitones: 0,
            cents: 0,
            filter: BackingFilter::Off,
        }
    }
}

impl BackingParams {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.volume.is_finite() && (0.0..=1.0).contains(&self.volume)) {
            return Err("audio track volume must be between 0 and 1".into());
        }
        if !(self.pan.is_finite() && (-1.0..=1.0).contains(&self.pan)) {
            return Err("audio track pan must be between -1 and 1".into());
        }
        if !(-24..=24).contains(&self.semitones) || !(-100..=100).contains(&self.cents) {
            return Err("audio track transposition is out of range".into());
        }
        self.eq.validate()
    }

    pub fn pitch_ratio(&self) -> f64 {
        2f64.powf(
            (self.semitones.clamp(-24, 24) as f64 * 100.0 + self.cents.clamp(-100, 100) as f64)
                / 1_200.0,
        )
    }
}

struct FilterBank {
    kind: BackingFilter,
    filters: [[Biquad; 2]; 2],
}

impl FilterBank {
    fn new(kind: BackingFilter, rate: f32) -> Self {
        let c = |k, f| Coefficients::new(k, f, 0.707, 0.0, rate);
        let pair = match kind {
            BackingFilter::Off => [Coefficients::IDENTITY; 2],
            BackingFilter::BassIsolate => [c(FilterKind::LowPass, 250.0); 2],
            BackingFilter::GuitarBand => [
                c(FilterKind::HighPass, 150.0),
                c(FilterKind::LowPass, 5_000.0),
            ],
            BackingFilter::CentreCut => [c(FilterKind::LowPass, 180.0); 2],
        };
        let mut filters = [[Biquad::default(); 2]; 2];
        for channel in &mut filters {
            for (f, coefficients) in channel.iter_mut().zip(pair) {
                f.set(coefficients);
            }
        }
        Self { kind, filters }
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        match self.kind {
            BackingFilter::Off => {}
            BackingFilter::CentreCut => {
                // Side signal plus the low end of the centre (keeps bass and kick).
                let [low, _] = &mut self.filters[0];
                for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                    let mid = 0.5 * (*l + *r);
                    let side = 0.5 * (*l - *r);
                    let bass = low.tick(mid);
                    *l = bass + side;
                    *r = bass - side;
                }
            }
            _ => {
                for (channel, samples) in [left, right].into_iter().enumerate() {
                    let [a, b] = &mut self.filters[channel];
                    for s in samples.iter_mut() {
                        *s = b.tick(a.tick(*s));
                    }
                }
            }
        }
    }

    fn reset(&mut self) {
        self.filters.iter_mut().flatten().for_each(Biquad::reset);
    }
}

/// The audio track as the engine plays it.
pub struct Backing {
    audio: Arc<DecodedAudio>,
    output_rate: f32,
    sync: SyncMap,
    params: BackingParams,
    stretcher: Stretcher,
    filter: FilterBank,
    eq: Option<Eq>,
    left: Vec<f32>,
    right: Vec<f32>,
    gains: Option<(f32, f32)>,
    pub peak: f32,
}

impl Backing {
    pub fn new(audio: Arc<DecodedAudio>, output_rate: f32, max_block: usize) -> Self {
        let params = BackingParams::default();
        let step = Self::step_for(&audio, &params, output_rate);
        Self {
            stretcher: Stretcher::new(output_rate, step),
            filter: FilterBank::new(params.filter, output_rate),
            audio,
            output_rate,
            sync: SyncMap::default(),
            params,
            eq: None,
            left: vec![0.0; max_block],
            right: vec![0.0; max_block],
            gains: None,
            peak: 0.0,
        }
    }

    fn step_for(audio: &DecodedAudio, params: &BackingParams, output_rate: f32) -> f64 {
        params.pitch_ratio() * audio.rate as f64 / output_rate as f64
    }

    pub fn audio(&self) -> &Arc<DecodedAudio> {
        &self.audio
    }

    pub fn params(&self) -> &BackingParams {
        &self.params
    }

    pub fn set(&mut self, params: BackingParams, sync: SyncMap) {
        let step = Self::step_for(&self.audio, &params, self.output_rate);
        if (step - self.stretcher.step()).abs() > 1e-12 {
            self.stretcher = Stretcher::new(self.output_rate, step);
        }
        if params.filter != self.params.filter {
            self.filter = FilterBank::new(params.filter, self.output_rate);
        }
        if params.eq != self.params.eq || self.eq.is_none() {
            self.eq = (!params.eq.is_flat()).then(|| Eq::new(&params.eq.bands(), self.output_rate));
        }
        self.params = params;
        self.sync = sync;
    }

    pub fn reset(&mut self) {
        self.gains = None;
        self.stretcher.reset();
        self.filter.reset();
        if let Some(eq) = &mut self.eq {
            eq.reset();
        }
    }

    pub fn is_solo(&self) -> bool {
        self.params.enabled && self.params.solo
    }

    /// Adds the recording for the song span starting at `song_pos` (seconds,
    /// advancing `rate` song seconds per output second) into `out`.
    pub fn render(
        &mut self,
        song_pos: f64,
        rate: f64,
        playing: bool,
        audible: bool,
        out: (&mut [f32], &mut [f32]),
    ) {
        let n = out.0.len();
        let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
        let on = playing && self.params.enabled;
        if on {
            let per_sample = rate / self.output_rate as f64;
            let src_rate = self.audio.rate as f64;
            let sync = &self.sync;
            self.stretcher.render(&self.audio, (l, r), |i| {
                sync.audio_at(song_pos + i as f64 * per_sample) * src_rate
            });
            let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
            self.filter.process(l, r);
            if let Some(eq) = &mut self.eq {
                eq.process(l, r);
            }
        } else {
            l.fill(0.0);
            r.fill(0.0);
        }
        let gain = if on && audible && !self.params.mute {
            self.params.volume
        } else {
            0.0
        };
        let target = pan_gains(gain, self.params.pan);
        let peak = mix_into(
            (&self.left[..n], &self.right[..n]),
            out,
            self.gains.unwrap_or(target),
            target,
        );
        self.gains = Some(target);
        self.peak = self.peak.max(peak);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn tone(freq: f64, rate: u32, seconds: f64) -> DecodedAudio {
        let frames = (seconds * rate as f64) as usize;
        let left: Vec<f32> = (0..frames)
            .map(|i| (0.5 * (2.0 * PI * freq * i as f64 / rate as f64).sin()) as f32)
            .collect();
        DecodedAudio {
            rate,
            channels: 2,
            right: left.clone(),
            left,
        }
    }

    fn wav_bytes(rate: u32, channels: u16, frames: usize) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for i in 0..frames {
                let s = ((2.0 * PI * 440.0 * i as f64 / rate as f64).sin() * 16_000.0) as i16;
                for c in 0..channels {
                    writer.write_sample(if c == 0 { s } else { s / 2 }).unwrap();
                }
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    /// Frequency from zero crossings.
    fn frequency(samples: &[f32], rate: f64) -> f64 {
        let crossings = samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        crossings as f64 * rate / samples.len() as f64
    }

    #[test]
    fn decodes_wav_files_in_mono_and_stereo() {
        let stereo = decode(wav_bytes(44_100, 2, 44_100), Some("wav")).unwrap();
        assert_eq!(stereo.rate, 44_100);
        assert_eq!(stereo.channels, 2);
        assert_eq!(stereo.frames(), 44_100);
        assert!((stereo.duration() - 1.0).abs() < 1e-9);
        // The right channel was written at half the level.
        let peak = |s: &[f32]| s.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!((peak(&stereo.left) / peak(&stereo.right) - 2.0).abs() < 0.01);
        let mono = decode(wav_bytes(22_050, 1, 11_025), None).unwrap();
        assert_eq!(mono.channels, 1);
        assert_eq!(mono.left, mono.right);
        assert_eq!(mono.peaks().len(), 50);
        assert!(mono.peaks().iter().all(|p| *p > 0.2 && *p <= 1.0));
    }

    #[test]
    fn decodes_the_mp3_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../e2e/fixtures/backing-a440.mp3"
        );
        let audio = decode(std::fs::read(path).unwrap(), Some("mp3")).unwrap();
        assert!((audio.duration() - 2.0).abs() < 0.1, "{}", audio.duration());
        let middle = &audio.left[audio.rate as usize / 2..audio.rate as usize];
        let f = frequency(middle, audio.rate as f64);
        assert!((f - 440.0).abs() < 5.0, "{f} Hz");
    }

    #[test]
    fn rejects_files_that_are_not_audio() {
        assert!(decode(b"not audio at all".to_vec(), Some("mp3")).is_err());
        assert!(decode(Vec::new(), None).is_err());
    }

    #[test]
    fn sync_map_stretches_between_points_and_runs_freely_outside() {
        // Bar 1 at 0 s in the score is at 1 s in the recording; bar 5 (8 s)
        // is at 10 s (the band played slower).
        let map = SyncMap::new(vec![(8.0, 10.0), (0.0, 1.0)]);
        assert_eq!(map.audio_at(0.0), 1.0);
        assert_eq!(map.audio_at(4.0), 5.5);
        assert_eq!(map.audio_at(8.0), 10.0);
        assert_eq!(map.audio_at(9.0), 11.0);
        assert_eq!(map.audio_at(-1.0), 0.0);
        assert!((map.slope_at(2.0) - 9.0 / 8.0).abs() < 1e-12);
        assert_eq!(map.slope_at(20.0), 1.0);
        // Monotonic: crossing points are dropped.
        let crossed = SyncMap::new(vec![(0.0, 5.0), (4.0, 3.0), (8.0, 9.0)]);
        assert_eq!(crossed.points(), &[(0.0, 5.0), (8.0, 9.0)]);
        let mut last = f64::MIN;
        for i in 0..200 {
            let a = map.audio_at(i as f64 * 0.1 - 2.0);
            assert!(a > last);
            last = a;
        }
        assert_eq!(SyncMap::default().audio_at(3.0), 3.0);
    }

    #[test]
    fn interpolator_is_exact_on_samples_and_accurate_between() {
        let audio = tone(1_000.0, 48_000, 0.1);
        let interp = Interpolator::new(1.0);
        for i in [100usize, 1_000, 2_000] {
            assert!((interp.read(&audio.left, i as f64) - audio.left[i]).abs() < 1e-5);
        }
        // Halfway between samples: compare with the true sine.
        let mut worst = 0.0f64;
        for i in 200..400 {
            let pos = i as f64 + 0.5;
            let truth = 0.5 * (2.0 * PI * 1_000.0 * pos / 48_000.0).sin();
            worst = worst.max((interp.read(&audio.left, pos) as f64 - truth).abs());
        }
        assert!(worst < 1e-3, "error {worst}");
        // Out of range reads are silent.
        assert_eq!(interp.read(&audio.left, -100.0), 0.0);
        assert_eq!(interp.read(&audio.left, 1e9), 0.0);
    }

    fn stretch(audio: &DecodedAudio, step: f64, speed: f64, frames: usize) -> Vec<f32> {
        let mut s = Stretcher::new(RATE, step);
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        let ratio = audio.rate as f64 / RATE as f64;
        for start in (0..frames).step_by(64) {
            let end = (start + 64).min(frames);
            s.render(audio, (&mut l[start..end], &mut r[start..end]), |i| {
                (start + i) as f64 * speed * ratio
            });
        }
        l
    }

    #[test]
    fn unity_speed_reproduces_the_recording() {
        let audio = tone(440.0, 48_000, 1.0);
        let out = stretch(&audio, 1.0, 1.0, 40_000);
        let hop = Stretcher::new(RATE, 1.0).hop;
        // After the first half grain the output is the input, delayed by nothing.
        for (i, (a, b)) in out
            .iter()
            .zip(&audio.left)
            .enumerate()
            .take(38_000)
            .skip(hop)
        {
            assert!((a - b).abs() < 1e-4, "sample {i}");
        }
    }

    #[test]
    fn half_speed_keeps_the_pitch_and_doubles_the_length() {
        let audio = tone(440.0, 48_000, 2.0);
        let out = stretch(&audio, 1.0, 0.5, 96_000);
        let f = frequency(&out[10_000..90_000], RATE as f64);
        assert!((f - 440.0).abs() < 8.0, "{f} Hz");
        // The second half of the output plays the second second of the recording.
        let rms = |s: &[f32]| (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt();
        assert!(rms(&out[60_000..90_000]) > 0.25);
    }

    #[test]
    fn transposing_changes_the_pitch_not_the_speed() {
        let audio = tone(440.0, 44_100, 2.0);
        let params = BackingParams {
            semitones: 12,
            ..Default::default()
        };
        let step = params.pitch_ratio() * 44_100.0 / RATE as f64;
        let out = stretch(&audio, step, 1.0, 72_000);
        let f = frequency(&out[10_000..70_000], RATE as f64);
        assert!((f - 880.0).abs() < 15.0, "{f} Hz");
        assert!(
            (BackingParams {
                cents: 100,
                ..Default::default()
            }
            .pitch_ratio()
                - 2f64.powf(1.0 / 12.0))
            .abs()
                < 1e-12
        );
    }

    #[test]
    fn follows_the_sync_map_after_a_seek() {
        let audio = Arc::new(tone(220.0, 48_000, 4.0));
        let mut backing = Backing::new(audio.clone(), RATE, 64);
        backing.set(BackingParams::default(), SyncMap::new(vec![(0.0, 1.0)]));
        // Song second 2 → recording second 3.
        let (mut l, mut r) = (vec![0.0; 4_096], vec![0.0; 4_096]);
        for start in (0..4_096).step_by(64) {
            let pos = 2.0 + start as f64 / RATE as f64;
            backing.render(
                pos,
                1.0,
                true,
                true,
                (&mut l[start..start + 64], &mut r[start..start + 64]),
            );
        }
        let at = 3 * 48_000;
        let hop = backing.stretcher.hop;
        for (i, (a, b)) in l
            .iter()
            .zip(&audio.left[at..])
            .enumerate()
            .take(4_000)
            .skip(hop)
        {
            assert!((a - b).abs() < 1e-3, "sample {i}");
        }
    }

    #[test]
    fn filters_mutes_and_bad_settings() {
        let audio = Arc::new(tone(2_000.0, 48_000, 1.0));
        let mut backing = Backing::new(audio, RATE, 4_096);
        let mut render = |params: BackingParams| {
            backing.set(params, SyncMap::default());
            backing.reset();
            let (mut l, mut r) = (vec![0.0; 4_096], vec![0.0; 4_096]);
            for _ in 0..3 {
                l.fill(0.0);
                r.fill(0.0);
                backing.render(0.5, 1.0, true, true, (&mut l, &mut r));
            }
            l.iter().fold(0.0f32, |a, b| a.max(b.abs()))
        };
        let open = render(BackingParams::default());
        let bass = render(BackingParams {
            filter: BackingFilter::BassIsolate,
            ..Default::default()
        });
        assert!(bass < open * 0.1, "{bass} vs {open}");
        // A centred signal disappears with the centre cut.
        let cut = render(BackingParams {
            filter: BackingFilter::CentreCut,
            ..Default::default()
        });
        assert!(cut < open * 0.1);
        let muted = render(BackingParams {
            mute: true,
            ..Default::default()
        });
        assert_eq!(muted, 0.0);
        assert!(
            BackingParams {
                volume: 2.0,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            BackingParams {
                semitones: 30,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(BackingParams::default().validate().is_ok());
    }
}
