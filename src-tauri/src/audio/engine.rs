//! The native audio engine: one synthesizer per track (all sharing one
//! SoundFont), each with its own bus (effect chain, volume, pan, mute, solo,
//! meter), mixed into a master bus with its own chain.
//!
//! [`Engine::render`] is plain code with no I/O: the audio output calls it
//! from its callback, and tests and exports call it directly (offline).

use std::sync::Arc;

use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use serde::{Deserialize, Serialize};

use super::chain::{Chain, ChainPlayer};
use super::song::Song;

/// Frames rendered at a time; events are placed with this precision.
pub const BLOCK: usize = 64;
/// Synth voices per track.
const POLYPHONY: usize = 64;
/// How long playback continues after the last bar (release tails).
const TAIL_SECONDS: f64 = 1.5;
const CLICK_SECONDS: f64 = 0.03;

/// Mixer state of one track bus (the same values as the score's mixer).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusMix {
    /// 0…1 (a gain multiplier on top of the volume written in the score).
    pub volume: f32,
    /// -1 (left) … 1 (right), applied on top of the score's pan.
    #[serde(default)]
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for BusMix {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }
}

struct TrackBus {
    synth: Synthesizer,
    chain: ChainPlayer,
    mix: BusMix,
    left: Vec<f32>,
    right: Vec<f32>,
    /// Peak level since the meters were last read.
    peak: f32,
}

/// What the UI shows while playing.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    pub tracks: Vec<f32>,
    pub master: f32,
}

pub struct Engine {
    sample_rate: f32,
    sound_font: Arc<SoundFont>,
    song: Option<Arc<Song>>,
    tracks: Vec<TrackBus>,
    master: ChainPlayer,
    master_volume: f32,
    /// Song time in seconds.
    position: f64,
    next_event: usize,
    next_click: usize,
    playing: bool,
    rate: f64,
    loop_range: Option<(f64, f64)>,
    metronome_volume: f32,
    click_phase: f64,
    click_left: f64,
    click_accent: bool,
    master_peak: f32,
    /// Plays single notes the user picks (drum kit preview), on the master bus.
    preview: Option<Synthesizer>,
    preview_buf: [Vec<f32>; 2],
}

impl Engine {
    pub fn new(sound_font: Arc<SoundFont>, sample_rate: f32) -> Self {
        Self {
            sample_rate,
            sound_font,
            song: None,
            tracks: Vec::new(),
            master: ChainPlayer::new(Chain::empty(), sample_rate, BLOCK),
            master_volume: 1.0,
            position: 0.0,
            next_event: 0,
            next_click: 0,
            playing: false,
            rate: 1.0,
            loop_range: None,
            metronome_volume: 0.0,
            click_phase: 0.0,
            click_left: 0.0,
            click_accent: false,
            master_peak: 0.0,
            preview: None,
            preview_buf: [vec![0.0; BLOCK], vec![0.0; BLOCK]],
        }
    }

    /// Plays one note now (e.g. a drum from the kit picker), whether or not
    /// the song plays. Allocates the preview synthesizer the first time.
    pub fn preview(&mut self, channel: u8, key: u8, velocity: u8) -> Result<(), String> {
        if self.preview.is_none() {
            self.preview = Some(self.new_synth()?);
        }
        let synth = self.preview.as_mut().expect("just created");
        let channel = (channel & 0x0f) as i32;
        synth.note_off_all_channel(channel, false);
        synth.process_midi_message(channel, 0x90, key.min(127) as i32, velocity.min(127) as i32);
        Ok(())
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    fn new_synth(&self) -> Result<Synthesizer, String> {
        let mut settings = SynthesizerSettings::new(self.sample_rate as i32);
        settings.block_size = BLOCK;
        settings.maximum_polyphony = POLYPHONY;
        // Reverb and chorus are left to the effect chains.
        settings.enable_reverb_and_chorus = false;
        Synthesizer::new(&self.sound_font, &settings).map_err(|e| e.to_string())
    }

    /// Loads a song with one bus per track. Allocates.
    pub fn load(&mut self, song: Arc<Song>) -> Result<(), String> {
        let mut tracks = Vec::with_capacity(song.track_channels.len());
        for _ in &song.track_channels {
            tracks.push(TrackBus {
                synth: self.new_synth()?,
                chain: ChainPlayer::new(Chain::empty(), self.sample_rate, BLOCK),
                mix: BusMix::default(),
                left: vec![0.0; BLOCK],
                right: vec![0.0; BLOCK],
                peak: 0.0,
            });
        }
        self.tracks = tracks;
        self.song = Some(song);
        self.playing = false;
        self.seek(0.0);
        Ok(())
    }

    pub fn duration(&self) -> f64 {
        self.song.as_ref().map_or(0.0, |s| s.duration)
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn play(&mut self) {
        if self.song.is_some() {
            self.playing = true;
        }
    }

    pub fn pause(&mut self) {
        self.playing = false;
        for track in &mut self.tracks {
            track.synth.note_off_all(false);
        }
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = if rate.is_finite() {
            rate.clamp(0.1, 4.0)
        } else {
            1.0
        };
    }

    pub fn set_loop(&mut self, range: Option<(f64, f64)>) {
        self.loop_range = range.filter(|(a, b)| a.is_finite() && b.is_finite() && b > a);
    }

    pub fn set_metronome_volume(&mut self, volume: f32) {
        self.metronome_volume = volume.clamp(0.0, 3.0);
    }

    pub fn set_master_volume(&mut self, volume: f32) {
        self.master_volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_mix(&mut self, track: usize, mix: BusMix) {
        if let Some(bus) = self.tracks.get_mut(track) {
            bus.mix = BusMix {
                volume: mix.volume.clamp(0.0, 1.0),
                pan: mix.pan.clamp(-1.0, 1.0),
                ..mix
            };
        }
    }

    /// Crossfades a track to a new chain; returns the old one to drop elsewhere.
    pub fn set_track_chain(&mut self, track: usize, chain: Chain) -> Option<Chain> {
        self.tracks
            .get_mut(track)
            .and_then(|bus| bus.chain.replace(chain))
    }

    pub fn set_master_chain(&mut self, chain: Chain) -> Option<Chain> {
        self.master.replace(chain)
    }

    /// Jumps to `seconds`: stops sounding notes and restores every channel's
    /// controllers, program and pitch bend as they are at that point.
    pub fn seek(&mut self, seconds: f64) {
        let Some(song) = self.song.clone() else {
            return;
        };
        let seconds = if seconds.is_finite() {
            seconds.clamp(0.0, song.duration)
        } else {
            0.0
        };
        for track in &mut self.tracks {
            track.synth.reset();
            track.chain.reset();
        }
        self.master.reset();
        let index = song.events.partition_point(|e| e.time < seconds);
        for event in &song.events[..index] {
            if !event.is_note() {
                self.dispatch(event.track as usize, event.status, event.data1, event.data2);
            }
        }
        self.next_event = index;
        self.next_click = song.clicks.partition_point(|c| c.0 < seconds);
        self.position = seconds;
        self.click_left = 0.0;
    }

    fn dispatch(&mut self, track: usize, status: u8, data1: u8, data2: u8) {
        if let Some(bus) = self.tracks.get_mut(track) {
            bus.synth.process_midi_message(
                (status & 0x0f) as i32,
                (status & 0xf0) as i32,
                data1 as i32,
                data2 as i32,
            );
        }
    }

    fn any_solo(&self) -> bool {
        self.tracks.iter().any(|t| t.mix.solo)
    }

    /// Renders `left.len()` frames (any length) into the buffers.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut done = 0;
        while done < left.len() {
            let n = (left.len() - done).min(BLOCK);
            self.render_block(&mut left[done..done + n], &mut right[done..done + n]);
            done += n;
        }
    }

    fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let step = n as f64 / self.sample_rate as f64 * self.rate;
        if self.playing
            && let Some(song) = self.song.clone()
        {
            let block_end = self.position + step;
            while let Some(event) = song.events.get(self.next_event) {
                if event.time >= block_end {
                    break;
                }
                self.dispatch(event.track as usize, event.status, event.data1, event.data2);
                self.next_event += 1;
            }
            if let Some(&(time, accent)) = song.clicks.get(self.next_click)
                && time < block_end
            {
                self.next_click += 1;
                self.click_left = CLICK_SECONDS;
                self.click_phase = 0.0;
                self.click_accent = accent;
            }
        }

        out_l.fill(0.0);
        out_r.fill(0.0);
        let solo = self.any_solo();
        for bus in &mut self.tracks {
            let (l, r) = (&mut bus.left[..n], &mut bus.right[..n]);
            bus.synth.render(l, r);
            bus.chain.process(l, r);
            let audible = !bus.mix.mute && (!solo || bus.mix.solo);
            let gain = if audible { bus.mix.volume } else { 0.0 };
            // Constant-power pan on top of the score's own pan.
            let angle = (bus.mix.pan + 1.0) * std::f32::consts::FRAC_PI_4;
            let (gl, gr) = (
                gain * angle.cos() * std::f32::consts::SQRT_2,
                gain * angle.sin() * std::f32::consts::SQRT_2,
            );
            let mut peak = bus.peak;
            for i in 0..n {
                let (a, b) = (l[i] * gl, r[i] * gr);
                peak = peak.max(a.abs()).max(b.abs());
                out_l[i] += a;
                out_r[i] += b;
            }
            bus.peak = peak;
        }

        if let Some(preview) = self.preview.as_mut() {
            let [pl, pr] = &mut self.preview_buf;
            preview.render(&mut pl[..n], &mut pr[..n]);
            for i in 0..n {
                out_l[i] += pl[i];
                out_r[i] += pr[i];
            }
        }

        if self.click_left > 0.0 && self.metronome_volume > 0.0 {
            let freq = if self.click_accent { 1_760.0 } else { 1_320.0 };
            let dt = 1.0 / self.sample_rate as f64;
            for i in 0..n {
                if self.click_left <= 0.0 {
                    break;
                }
                let envelope = (self.click_left / CLICK_SECONDS) as f32;
                let s = (self.click_phase * std::f64::consts::TAU).sin() as f32
                    * 0.3
                    * envelope
                    * self.metronome_volume;
                out_l[i] += s;
                out_r[i] += s;
                self.click_phase += freq * dt;
                self.click_left -= dt;
            }
        }

        self.master.process(out_l, out_r);
        let mut peak = self.master_peak;
        for (a, b) in out_l.iter_mut().zip(out_r.iter_mut()) {
            *a = (*a * self.master_volume).clamp(-1.0, 1.0);
            *b = (*b * self.master_volume).clamp(-1.0, 1.0);
            peak = peak.max(a.abs()).max(b.abs());
        }
        self.master_peak = peak;

        if self.playing {
            self.position += step;
            if let Some((start, end)) = self.loop_range
                && self.position >= end
            {
                self.seek(start);
            } else if self.position >= self.duration() + TAIL_SECONDS {
                self.playing = false;
                self.position = self.duration();
            }
        }
    }

    /// Peak levels since the last call (then resets them).
    pub fn take_meters(&mut self) -> Meters {
        let tracks = self
            .tracks
            .iter_mut()
            .map(|t| std::mem::take(&mut t.peak))
            .collect();
        Meters {
            tracks,
            master: std::mem::take(&mut self.master_peak),
        }
    }

    pub fn chain_problems(&self, track: Option<usize>) -> Vec<super::chain::BlockProblem> {
        match track {
            Some(i) => self
                .tracks
                .get(i)
                .map(|t| t.chain.current().problems.clone())
                .unwrap_or_default(),
            None => self.master.current().problems.clone(),
        }
    }
}
