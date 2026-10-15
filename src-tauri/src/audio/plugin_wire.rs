//! Shared host/helper audio protocol. Pipes carry commands, never audio samples.
use std::fs::{File, OpenOptions};
use std::path::Path;

use memmap2::{MmapMut, MmapOptions};
use serde::{Deserialize, Serialize};
use vst3_host::process_isolation::HostCommand;

pub const MAX_AUDIO_FRAMES: usize = 4096;
pub const AUDIO_PROTOCOL_VERSION: u32 = 1;
const CHANNEL_BYTES: usize = MAX_AUDIO_FRAMES * size_of::<f32>();
const MAPPING_BYTES: usize = CHANNEL_BYTES * 4;

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
            for (bytes, sample) in self.map[start..start + samples.len() * 4]
                .chunks_exact_mut(4)
                .zip(samples)
            {
                bytes.copy_from_slice(&sample.to_ne_bytes());
            }
        }
        Ok(())
    }

    pub fn read(&self, output: bool, frames: usize) -> Result<(Vec<f32>, Vec<f32>), String> {
        Self::check_frames(frames)?;
        let first = if output { 2 } else { 0 };
        let channel = |index: usize| {
            let start = (first + index) * CHANNEL_BYTES;
            self.map[start..start + frames * 4]
                .chunks_exact(4)
                .map(|b| f32::from_ne_bytes(b.try_into().unwrap()))
                .collect()
        };
        Ok((channel(0), channel(1)))
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
}
