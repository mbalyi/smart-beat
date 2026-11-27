//! A VST3 or CLAP instrument as a MIDI lane's sound (ADR 0006).
//!
//! The plugin runs in its helper process like an effect. The audio thread hands it fixed blocks
//! of silence with the MIDI events played in each block (at their frames), and plays what the
//! plugin made of the previous block: one block of extra delay, like effect plugins. When the
//! helper is late or gone the lane is silent (an instrument has no dry sound to fall back to).

use std::sync::Arc;

use super::engine::{BLOCK, Instrument};
use super::plugin::PluginWorker;
use super::plugin_wire::BlockEvent;

/// The most events one block carries (more in one block are dropped).
const MAX_EVENTS: usize = 128;

pub struct PluginInstrument {
    worker: Arc<PluginWorker>,
    seen: u64,
    events: Vec<BlockEvent>,
    /// Frames of the current block already rendered.
    fill: usize,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    silence: Vec<f32>,
}

impl PluginInstrument {
    pub fn new(worker: Arc<PluginWorker>) -> Self {
        Self {
            worker,
            seen: 0,
            events: Vec::with_capacity(MAX_EVENTS),
            fill: 0,
            out_l: vec![0.0; BLOCK],
            out_r: vec![0.0; BLOCK],
            silence: vec![0.0; BLOCK],
        }
    }

    fn queue(&mut self, bytes: [u8; 3]) {
        if self.events.len() < MAX_EVENTS {
            self.events.push((self.fill as u32, bytes));
        }
    }
}

impl Instrument for PluginInstrument {
    fn midi(&mut self, channel: i32, command: i32, data1: i32, data2: i32) {
        let status = (command as u8 & 0xf0) | (channel as u8 & 0x0f);
        self.queue([status, data1.clamp(0, 127) as u8, data2.clamp(0, 127) as u8]);
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let mut i = 0;
        while i < n {
            let take = (n - i).min(BLOCK - self.fill);
            left[i..i + take].copy_from_slice(&self.out_l[self.fill..self.fill + take]);
            right[i..i + take].copy_from_slice(&self.out_r[self.fill..self.fill + take]);
            self.fill += take;
            i += take;
            if self.fill == BLOCK {
                self.worker
                    .push_with_events(&self.silence, &self.silence, &self.events);
                self.events.clear();
                if !self
                    .worker
                    .take_into(&mut self.seen, &mut self.out_l, &mut self.out_r)
                {
                    self.out_l.fill(0.0);
                    self.out_r.fill(0.0);
                }
                self.fill = 0;
            }
        }
    }

    fn reset(&mut self) {
        self.note_off_all(true);
    }

    fn note_off_all(&mut self, _immediate: bool) {
        // All notes off and all sound off on every channel.
        self.events.clear();
        for chan in 0..16u8 {
            self.queue([0xb0 | chan, 123, 0]);
            self.queue([0xb0 | chan, 120, 0]);
        }
    }
}
