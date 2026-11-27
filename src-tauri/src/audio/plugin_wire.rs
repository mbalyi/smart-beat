//! Shared host/helper audio protocol. Pipes carry commands, never audio samples.
use std::fs::{File, OpenOptions};
use std::path::Path;

use memmap2::{MmapMut, MmapOptions};
use serde::{Deserialize, Serialize};
use vst3_host::process_isolation::HostCommand;

pub const MAX_AUDIO_FRAMES: usize = 4096;
pub const AUDIO_PROTOCOL_VERSION: u32 = 2;
const CHANNEL_BYTES: usize = MAX_AUDIO_FRAMES * size_of::<f32>();
/// The most MIDI events one block carries to an instrument plugin (ADR 0006).
pub const MAX_BLOCK_EVENTS: usize = 512;
/// One event: frame offset (u32) and the three MIDI bytes, padded to eight bytes.
const EVENT_BYTES: usize = 8;
/// After the four audio channels: an event count (u32) and the events.
const EVENTS_AT: usize = CHANNEL_BYTES * 4;
const MAPPING_BYTES: usize = EVENTS_AT + 4 + MAX_BLOCK_EVENTS * EVENT_BYTES;

/// A MIDI message for an instrument plugin, at a frame of the block.
pub type BlockEvent = (u32, [u8; 3]);

#[derive(Debug, Serialize, Deserialize)]
pub enum AudioCommand {
    AttachAudio {
        path: std::path::PathBuf,
        version: u32,
    },
    ProcessShared {
        frames: usize,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Command {
    Audio(AudioCommand),
    Host(HostCommand),
}

/// Four planar channels, two input and two output. Access is serialized by
/// request/reply: the host finishes writing before requesting processing, and
/// the helper finishes writing before replying. Neither side resizes the file.
pub struct SharedAudio {
    map: MmapMut,
}

impl SharedAudio {
    pub fn create() -> Result<(tempfile::NamedTempFile, Self), String> {
        let file = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        file.as_file()
            .set_len(MAPPING_BYTES as u64)
            .map_err(|e| e.to_string())?;
        let mut audio = Self::map(file.as_file())?;
        audio.map.fill(0);
        Ok((file, audio))
    }

    pub fn open(path: &Path, version: u32) -> Result<Self, String> {
        if version != AUDIO_PROTOCOL_VERSION {
            return Err("The plugin helper audio protocol is incompatible".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        Self::map(&file)
    }

    fn map(file: &File) -> Result<Self, String> {
        if file.metadata().map_err(|e| e.to_string())?.len() != MAPPING_BYTES as u64 {
            return Err("The plugin audio mapping has the wrong size".into());
        }
        // SAFETY: the host creates a private fixed-size file and retains it
        // until the helper exits. Both mappings obey the request/reply access
        // protocol above, and no code in either endpoint truncates the file.
        let map = unsafe { MmapOptions::new().len(MAPPING_BYTES).map_mut(file) }
            .map_err(|e| e.to_string())?;
        Ok(Self { map })
    }

    pub fn write(&mut self, output: bool, left: &[f32], right: &[f32]) -> Result<(), String> {
        Self::check_frames(left.len())?;
        if left.len() != right.len() {
            return Err("Plugin audio channels have different lengths".into());
        }
        let first = if output { 2 } else { 0 };
        for (channel, samples) in [left, right].into_iter().enumerate() {
            let start = (first + channel) * CHANNEL_BYTES;
            // The range is a whole number of samples: CHANNEL_BYTES is a
            // multiple of four and both channels have the same length.
            let (words, _) = self.map[start..start + samples.len() * 4].as_chunks_mut::<4>();
            for (word, sample) in words.iter_mut().zip(samples) {
                word.copy_from_slice(&sample.to_ne_bytes());
            }
        }
        Ok(())
    }

    pub fn read(&self, output: bool, frames: usize) -> Result<(Vec<f32>, Vec<f32>), String> {
        Self::check_frames(frames)?;
        let first = if output { 2 } else { 0 };
        let channel = |index: usize| {
            let start = (first + index) * CHANNEL_BYTES;
            let (words, _) = self.map[start..start + frames * 4].as_chunks::<4>();
            words.iter().map(|word| f32::from_ne_bytes(*word)).collect()
        };
        Ok((channel(0), channel(1)))
    }

    /// Writes the MIDI events of the next block (more than fit are dropped).
    pub fn write_events(&mut self, events: &[BlockEvent]) {
        let count = events.len().min(MAX_BLOCK_EVENTS);
        self.map[EVENTS_AT..EVENTS_AT + 4].copy_from_slice(&(count as u32).to_ne_bytes());
        for (i, (offset, bytes)) in events.iter().take(count).enumerate() {
            let at = EVENTS_AT + 4 + i * EVENT_BYTES;
            self.map[at..at + 4].copy_from_slice(&offset.to_ne_bytes());
            self.map[at + 4..at + 7].copy_from_slice(bytes);
        }
    }

    /// The MIDI events of the block (a damaged count reads as none).
    pub fn read_events(&self) -> Vec<BlockEvent> {
        let mut word = [0u8; 4];
        word.copy_from_slice(&self.map[EVENTS_AT..EVENTS_AT + 4]);
        let count = u32::from_ne_bytes(word) as usize;
        if count > MAX_BLOCK_EVENTS {
            return Vec::new();
        }
        (0..count)
            .map(|i| {
                let at = EVENTS_AT + 4 + i * EVENT_BYTES;
                word.copy_from_slice(&self.map[at..at + 4]);
                let mut bytes = [0u8; 3];
                bytes.copy_from_slice(&self.map[at + 4..at + 7]);
                (u32::from_ne_bytes(word), bytes)
            })
            .collect()
    }

    fn check_frames(frames: usize) -> Result<(), String> {
        if frames == 0 || frames > MAX_AUDIO_FRAMES {
            return Err("Plugin audio block exceeds the shared buffer".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mappings_exchange_stereo_without_serializing_samples() {
        let (file, mut host) = SharedAudio::create().unwrap();
        let mut helper = SharedAudio::open(file.path(), AUDIO_PROTOCOL_VERSION).unwrap();
        host.write(false, &[0.25, -0.5], &[0.75, 1.0]).unwrap();
        assert_eq!(
            helper.read(false, 2).unwrap(),
            (vec![0.25, -0.5], vec![0.75, 1.0])
        );
        helper.write(true, &[0.5, -1.0], &[1.5, 2.0]).unwrap();
        assert_eq!(
            host.read(true, 2).unwrap(),
            (vec![0.5, -1.0], vec![1.5, 2.0])
        );
        let command =
            serde_json::to_string(&Command::Audio(AudioCommand::ProcessShared { frames: 2 }))
                .unwrap();
        assert_eq!(command, r#"{"ProcessShared":{"frames":2}}"#);
        assert!(host.read(false, MAX_AUDIO_FRAMES + 1).is_err());
        assert!(host.write(false, &[0.0], &[]).is_err());
        assert!(SharedAudio::open(file.path(), AUDIO_PROTOCOL_VERSION + 1).is_err());
    }

    #[test]
    fn mappings_carry_midi_events_for_instruments() {
        let (file, mut host) = SharedAudio::create().unwrap();
        let helper = SharedAudio::open(file.path(), AUDIO_PROTOCOL_VERSION).unwrap();
        assert!(helper.read_events().is_empty());
        host.write_events(&[(0, [0x90, 60, 100]), (31, [0x80, 60, 0])]);
        assert_eq!(
            helper.read_events(),
            vec![(0, [0x90, 60, 100]), (31, [0x80, 60, 0])]
        );
        let many: Vec<BlockEvent> = (0..MAX_BLOCK_EVENTS as u32 + 10)
            .map(|i| (i, [0xb0, 1, 2]))
            .collect();
        host.write_events(&many);
        assert_eq!(helper.read_events().len(), MAX_BLOCK_EVENTS);
        host.write_events(&[]);
        assert!(helper.read_events().is_empty());
    }
}
