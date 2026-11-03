//! FLAC for the stems in a `.sbstems` file (see [`super::bundle`]): lossless, so a saved and
//! reopened song has exactly the samples of the cache's 16-bit WAV files, at about half the size.
//!
//! Encoding is `flacenc` (pure Rust, Apache-2.0) reading the WAV file block by block; decoding
//! is Symphonia, which the app already uses for every other audio file.

use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use flacenc::component::BitRepr;
use flacenc::error::{SourceError, SourceErrorReason, Verify};
use flacenc::source::{Fill, Source};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use super::wav::{Pcm16, WavSink};
use crate::separation::{StemKind, StemSink};

/// Frames per FLAC block (the encoder's default). Another size is taken when this one would leave
/// a last block shorter than [`MIN_FRAMES`].
const BLOCK_SIZE: usize = 4096;
/// Symphonia refuses blocks shorter than this, the last one included. A stem with fewer
/// frames in total cannot be FLAC (the file keeps it as WAV).
pub const MIN_FRAMES: u64 = 16;
/// The 16-bit stereo format of the cache's WAV files.
const BITS: usize = 16;
const CHANNELS: usize = 2;

/// An encoded stem.
#[derive(Debug)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub frames: u64,
}

/// The WAV file as the encoder's input. When `cancel` is set it ends the input early and notes
/// that in `stopped`; the caller then throws the half encoded stream away. (An error from the
/// source would make the encoder's worker threads panic.)
struct WavSource<'a> {
    pcm: Pcm16,
    cancel: &'a AtomicBool,
    stopped: bool,
    progress: &'a mut dyn FnMut(u64),
    done: u64,
    left: Vec<f32>,
    right: Vec<f32>,
    block: Vec<i32>,
}

impl Source for WavSource<'_> {
    fn channels(&self) -> usize {
        CHANNELS
    }

    fn bits_per_sample(&self) -> usize {
        BITS
    }

    fn sample_rate(&self) -> usize {
        self.pcm.rate as usize
    }

    fn read_samples<F: Fill>(
        &mut self,
        block_size: usize,
        dest: &mut F,
    ) -> Result<usize, SourceError> {
        if self.cancel.load(Ordering::Relaxed) {
            self.stopped = true;
            return Ok(0);
        }
        self.left.clear();
        self.right.clear();
        let read = self
            .pcm
            .read_block(&mut self.left, &mut self.right, block_size)
            .map_err(|_| SourceError::by_reason(SourceErrorReason::InvalidFormat))?;
        self.block.clear();
        for (l, r) in self.left.iter().zip(&self.right) {
            self.block.push(to_i32(*l));
            self.block.push(to_i32(*r));
        }
        dest.fill_interleaved(&self.block)?;
        if read > 0 {
            self.done += read as u64;
            (self.progress)(self.done);
        }
        Ok(read)
    }

    fn len_hint(&self) -> Option<usize> {
        Some(self.pcm.frames as usize)
    }
}

/// The 16-bit sample a float from [`Pcm16`] stands for (it is exactly `sample / 32768`).
fn to_i32(x: f32) -> i32 {
    (x * 32768.0).round() as i32
}

/// The block size for `frames` frames: [`BLOCK_SIZE`], or a slightly smaller one when that would
/// end with a block of fewer than [`MIN_FRAMES`] frames.
fn block_size_for(frames: u64) -> usize {
    (BLOCK_SIZE - 64..=BLOCK_SIZE)
        .rev()
        .find(|bs| {
            let rest = frames % *bs as u64;
            rest == 0 || rest >= MIN_FRAMES
        })
        .unwrap_or(BLOCK_SIZE)
}

/// Encodes the cache's WAV file `wav` as FLAC. `progress` receives the frames done so far.
/// A set `cancel` ends the encoding with `Err(stopped)`. Fails for fewer than [`MIN_FRAMES`]
/// frames.
pub fn encode_wav(
    wav: &Path,
    cancel: &AtomicBool,
    stopped: &str,
    progress: &mut dyn FnMut(u64),
) -> Result<Encoded, String> {
    let pcm = Pcm16::open(wav)?;
    let frames = pcm.frames;
    if frames < MIN_FRAMES {
        return Err("The stem is too short for FLAC".into());
    }
    let mut source = WavSource {
        pcm,
        cancel,
        stopped: false,
        progress,
        done: 0,
        left: Vec::new(),
        right: Vec::new(),
        block: Vec::new(),
    };
    let block_size = block_size_for(frames);
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|_| "The FLAC encoder is not set up correctly".to_string())?;
    let stream = flacenc::encode_with_fixed_block_size(&config, &mut source, block_size)
        .map_err(|e| format!("A stem could not be encoded: {e}"))?;
    if source.stopped {
        return Err(stopped.to_string());
    }
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|_| "A stem could not be encoded".to_string())?;
    let mut bytes = sink.as_slice().to_vec();
    fix_block_sizes(&mut bytes, frames, block_size);
    Ok(Encoded { bytes, frames })
}

/// flacenc writes the shortest block, the last one, as the minimum block size in STREAMINFO.
/// Symphonia then takes the stream for one with variable block sizes and refuses its fixed-size
/// frames. FLAC's own rule is that a stream of equal blocks has the same minimum and maximum
/// (the last block is not counted), so the two numbers are set that way.
fn fix_block_sizes(bytes: &mut [u8], frames: u64, block_size: usize) {
    // "fLaC", the 4-byte header of the STREAMINFO block, then the two 16-bit block sizes.
    let size = if frames > block_size as u64 {
        block_size as u16
    } else {
        frames as u16
    };
    if bytes.len() > 12 {
        bytes[8..10].copy_from_slice(&size.to_be_bytes());
        bytes[10..12].copy_from_slice(&size.to_be_bytes());
    }
}

/// What a decoded FLAC stem turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub struct Decoded {
    pub rate: u32,
    pub frames: u64,
}

/// Decodes a 16-bit stereo FLAC file into `sink` as stem `kind`. A frame that fails its CRC is
/// dropped by the decoder, so the caller compares the frame count (and the checksum of the
/// file) with what was saved. `progress` receives the frames done so far.
pub fn decode_flac(
    bytes: Vec<u8>,
    kind: StemKind,
    sink: &mut WavSink,
    cancel: &AtomicBool,
    stopped: &str,
    progress: &mut dyn FnMut(u64),
) -> Result<Decoded, String> {
    let damaged = |why: &dyn std::fmt::Display| format!("The {} stem is damaged: {why}", kind.id());
    let mut hint = Hint::new();
    hint.with_extension("flac");
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| damaged(&e))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| damaged(&"no audio"))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| damaged(&"no audio"))?;
    let bits = params.bits_per_sample.unwrap_or(0) as usize;
    let channels = params.channels.as_ref().map_or(0, |c| c.count());
    let rate = params.sample_rate.unwrap_or(0);
    if bits != BITS || channels != CHANNELS || rate == 0 {
        return Err(damaged(&"it is not 16-bit stereo"));
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| damaged(&e))?;

    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut interleaved: Vec<f32> = Vec::new();
    let mut frames = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(stopped.to_string());
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // The end of the stream shows up as an I/O error; a cut-off file is caught by the
            // frame count and the checksum of the caller.
            Err(DecodeError::IoError(_)) => break,
            Err(e) => return Err(damaged(&e)),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = decoder.decode(&packet).map_err(|e| damaged(&e))?;
        if buffer.spec().channels().count() != CHANNELS || buffer.spec().rate() != rate {
            return Err(damaged(&"the format changes in the middle"));
        }
        interleaved.resize(buffer.samples_interleaved(), 0.0);
        buffer.copy_to_slice_interleaved(&mut interleaved);
        left.clear();
        right.clear();
        for frame in interleaved.as_chunks::<CHANNELS>().0 {
            left.push(frame[0]);
            right.push(frame[1]);
        }
        sink.write(kind, &left, &right)?;
        frames += left.len() as u64;
        progress(frames);
    }
    Ok(Decoded { rate, frames })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::stems::wav;

    /// A 16-bit stereo WAV file with the given interleaved samples.
    pub(crate) fn write_pcm(path: &Path, rate: u32, samples: &[i16]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
    }

    /// Music-like samples that also hit the extremes: two tones, a click, a stretch of silence,
    /// full-scale values and a little noise, so every FLAC predictor and residual path runs.
    pub(crate) fn signal(frames: usize) -> Vec<i16> {
        let mut seed = 0x9e37_79b9u32;
        let mut noise = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed % 41) as f32 - 20.0
        };
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let t = i as f32 / 44_100.0;
            let l = (t * 440.0 * std::f32::consts::TAU).sin() * 9_000.0
                + (t * 1_250.0 * std::f32::consts::TAU).sin() * 3_000.0
                + noise();
            let r = (t * 330.0 * std::f32::consts::TAU).sin() * 12_000.0 + noise();
            let (l, r) = match i % 20_000 {
                0 => (32_767.0, -32_768.0),
                1 => (-32_768.0, 32_767.0),
                2..=3_000 => (0.0, 0.0),
                _ => (l, r),
            };
            out.push(l.clamp(-32_768.0, 32_767.0) as i16);
            out.push(r.clamp(-32_768.0, 32_767.0) as i16);
        }
        out
    }

    fn pcm_of(path: &Path) -> Vec<i16> {
        hound::WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|s| s.unwrap())
            .collect()
    }

    fn decode(bytes: Vec<u8>, dir: &Path) -> Result<Decoded, String> {
        let mut sink = WavSink::new(dir, 44_100);
        let decoded = decode_flac(
            bytes,
            StemKind::Bass,
            &mut sink,
            &AtomicBool::new(false),
            "stopped",
            &mut |_| {},
        )?;
        sink.finish()?;
        Ok(decoded)
    }

    #[test]
    fn a_stem_comes_back_from_flac_sample_for_sample() {
        let dir = tempfile::tempdir().unwrap();
        let frames = 150_000;
        let samples = signal(frames);
        let wav = dir.path().join("in.wav");
        write_pcm(&wav, 44_100, &samples);
        let mut seen = Vec::new();
        let encoded = encode_wav(&wav, &AtomicBool::new(false), "stopped", &mut |n| {
            seen.push(n)
        })
        .unwrap();
        assert_eq!(encoded.frames, frames as u64);
        assert_eq!(&encoded.bytes[..4], b"fLaC");
        assert!(
            encoded.bytes.len() < frames * 4,
            "FLAC is smaller than the WAV file"
        );
        // Progress counts frames up to the end.
        assert!(seen.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(seen.last(), Some(&(frames as u64)));

        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let decoded = decode(encoded.bytes, &out).unwrap();
        assert_eq!(
            decoded,
            Decoded {
                rate: 44_100,
                frames: frames as u64
            }
        );
        assert_eq!(pcm_of(&out.join("bass.wav")), samples);
    }

    #[test]
    fn silence_and_awkward_lengths_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        for frames in [16usize, 17, 4_096, 4_097, 4_096 + 15, 8_192 + 3, 100_000] {
            let samples: Vec<i16> = if frames == 4_096 {
                vec![0; frames * 2]
            } else {
                signal(frames)
            };
            let wav = dir.path().join("in.wav");
            write_pcm(&wav, 48_000, &samples);
            let encoded =
                encode_wav(&wav, &AtomicBool::new(false), "stopped", &mut |_| {}).unwrap();
            let out = dir.path().join(format!("out{frames}"));
            std::fs::create_dir(&out).unwrap();
            let mut sink = WavSink::new(&out, 48_000);
            let decoded = decode_flac(
                encoded.bytes,
                StemKind::Bass,
                &mut sink,
                &AtomicBool::new(false),
                "stopped",
                &mut |_| {},
            )
            .unwrap();
            sink.finish().unwrap();
            assert_eq!((decoded.rate, decoded.frames), (48_000, frames as u64));
            assert_eq!(pcm_of(&out.join("bass.wav")), samples, "{frames} frames");
        }
    }

    #[test]
    fn a_stem_below_the_flac_minimum_is_refused_not_mangled() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("in.wav");
        write_pcm(&wav, 44_100, &signal(15));
        assert!(encode_wav(&wav, &AtomicBool::new(false), "x", &mut |_| {}).is_err());
        assert_eq!(block_size_for(4_096 * 5 + 3), 4_093);
        assert_eq!(block_size_for(4_096 * 5), 4_096);
        assert_eq!(block_size_for(4_096 * 5 + 16), 4_096);
    }

    #[test]
    fn a_stop_ends_both_directions_with_the_given_message() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("in.wav");
        write_pcm(&wav, 44_100, &signal(20_000));
        let err = encode_wav(&wav, &AtomicBool::new(true), "stopped!", &mut |_| {}).unwrap_err();
        assert_eq!(err, "stopped!");
        let encoded = encode_wav(&wav, &AtomicBool::new(false), "x", &mut |_| {}).unwrap();
        let mut sink = WavSink::new(dir.path(), 44_100);
        let err = decode_flac(
            encoded.bytes,
            StemKind::Bass,
            &mut sink,
            &AtomicBool::new(true),
            "stopped!",
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err, "stopped!");
    }

    #[test]
    fn damaged_or_foreign_data_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("in.wav");
        write_pcm(&wav, 44_100, &signal(30_000));
        let good = encode_wav(&wav, &AtomicBool::new(false), "x", &mut |_| {})
            .unwrap()
            .bytes;
        assert!(decode(b"this is not flac".to_vec(), dir.path()).is_err());
        assert!(decode(Vec::new(), dir.path()).is_err());
        let mut flipped = good.clone();
        let middle = flipped.len() / 2;
        flipped[middle] ^= 0xff;
        // Symphonia drops a frame whose CRC fails, so the result is an error or too short; the
        // checksum in the manifest is what refuses the file before it gets here.
        if let Ok(decoded) = decode(flipped, dir.path()) {
            assert!(decoded.frames < 30_000);
        }
        // Cut off in the middle: fewer frames than the encoder wrote, or an error.
        let cut = good[..good.len() / 2].to_vec();
        if let Ok(decoded) = decode(cut, dir.path()) {
            assert!(decoded.frames < 30_000);
        }
        // A mono FLAC file is refused: the cache holds stereo only.
        let mono: Vec<i32> = (0..2_000).map(|i| (i % 100) * 10).collect();
        let source = flacenc::source::MemSource::from_samples(&mono, 1, 16, 44_100);
        let config = flacenc::config::Encoder::default().into_verified().unwrap();
        let stream = flacenc::encode_with_fixed_block_size(&config, source, 4096).unwrap();
        let mut sink = flacenc::bitsink::ByteSink::new();
        stream.write(&mut sink).unwrap();
        let mut bytes = sink.as_slice().to_vec();
        fix_block_sizes(&mut bytes, 2_000, 4_096);
        let err = decode(bytes, dir.path()).unwrap_err();
        assert!(err.contains("16-bit stereo"), "{err}");
    }

    #[test]
    fn the_measured_size_of_a_minute_of_music_like_stems() {
        // Not an assertion about a ratio (it depends on the signal), only that it shrinks.
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("in.wav");
        write_pcm(&wav, 44_100, &signal(44_100 * 10));
        let encoded = encode_wav(&wav, &AtomicBool::new(false), "x", &mut |_| {}).unwrap();
        let wav_bytes = std::fs::metadata(&wav).unwrap().len();
        assert!((encoded.bytes.len() as u64) < wav_bytes);
        assert_eq!(wav::Pcm16::open(&wav).unwrap().frames, encoded.frames);
    }
}
