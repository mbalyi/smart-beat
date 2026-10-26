//! Audio export as AAC (`.m4a`) through the operating system's own encoder.
//!
//! Every AAC encoder we could ship is LGPL or patent-encumbered (and MP3's are
//! LGPL too), so Smart Beat does not bundle one. macOS has one built in
//! (AVFoundation), which is what this module drives. The UI renders the song
//! to the same 16-bit WAV the WAV export writes and hands those bytes over;
//! the file appears complete or not at all (temporary file, then rename).
//!
//! Windows has one too (Media Foundation, an `IMFSinkWriter` with an MPEG-4
//! sink). Linux has no system AAC encoder, so it answers with an error and the
//! menu item is not shown.

use std::io::{self, Cursor};
use std::path::Path;

use crate::error::{CommandError, ErrorKind};
use crate::score_file::MAX_SIZE;

/// Lowest and highest sample rate the AAC encoder is given (Hz).
const MIN_RATE: u32 = 8_000;
const MAX_RATE: u32 = 96_000;

/// Frames given to the encoder at a time.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const CHUNK_FRAMES: usize = 32_768;

/// Whether this build can write `.m4a` files.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// Sound ready for the encoder: interleaved samples between -1 and 1.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

fn audio_error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

/// Reads a PCM WAV file (up to 32-bit integer, or 32-bit float), mono or stereo.
pub fn decode_wav(wav: &[u8]) -> Result<Pcm, CommandError> {
    let mut reader = hound::WavReader::new(Cursor::new(wav))
        .map_err(|_| audio_error("The rendered audio is not a valid WAV file."))?;
    let spec = reader.spec();
    if !(1..=2).contains(&spec.channels) {
        return Err(audio_error(
            "M4A export supports mono and stereo sound only.",
        ));
    }
    if !(MIN_RATE..=MAX_RATE).contains(&spec.sample_rate) {
        return Err(audio_error(format!(
            "M4A export does not support a sample rate of {} Hz.",
            spec.sample_rate
        )));
    }
    let damaged = |_: hound::Error| audio_error("The rendered audio is damaged.");
    let samples = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, bits @ 1..=32) => {
            let scale = 2f32.powi(i32::from(bits) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(damaged)?
        }
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .map_err(damaged)?,
        _ => {
            return Err(audio_error(
                "M4A export does not support this kind of WAV file.",
            ));
        }
    };
    if samples.len() < usize::from(spec.channels) {
        return Err(audio_error("There is no sound to export."));
    }
    Ok(Pcm {
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        samples,
    })
}

/// The bit rate for the AAC stream (bits per second): 128 kbps per channel is transparent for this music.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn bit_rate(channels: u16) -> u32 {
    if channels == 1 { 128_000 } else { 192_000 }
}

/// Encodes the WAV file `wav` as AAC and writes it to `path` (an `.m4a` file),
/// replacing any file there.
pub fn encode(wav: &[u8], path: &Path) -> Result<(), CommandError> {
    let name = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("m4a"))
    {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{name}” is not an .m4a file."),
        ));
    }
    if wav.len() as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!(
                "The sound for “{name}” is larger than {} MB.",
                MAX_SIZE / (1024 * 1024)
            ),
        ));
    }
    if !SUPPORTED {
        return Err(audio_error(
            "M4A export is not available on this system. Export a WAV file instead.",
        ));
    }
    let pcm = decode_wav(wav)?;

    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let io_error = |error: &io::Error| match error.kind() {
        io::ErrorKind::NotFound => CommandError::new(
            ErrorKind::NotFound,
            format!("The folder for “{name}” does not exist."),
        ),
        _ => CommandError::new(
            ErrorKind::Io,
            format!("“{name}” could not be saved: {error}"),
        ),
    };
    if path.is_dir() {
        return Err(CommandError::new(
            ErrorKind::Io,
            format!("“{name}” is a folder."),
        ));
    }
    // The encoder picks the file type from the extension, so the temporary file has it too.
    // Only the path is kept: an open handle would lock the file against the
    // encoder on Windows. The file is still removed if the encoding fails.
    let temp = tempfile::Builder::new()
        .prefix(".smart-beat-")
        .suffix(".m4a")
        .tempfile_in(dir)
        .map_err(|e| io_error(&e))?
        .into_temp_path();
    write_aac(&pcm, &temp)?;
    // Keep the permissions of the file being replaced, as the other saves do.
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&temp, metadata.permissions());
    }
    temp.persist(path).map_err(|e| io_error(&e.error))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_aac(pcm: &Pcm, path: &Path) -> Result<(), CommandError> {
    use std::slice;

    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_avf_audio::{
        AVAudioFile, AVAudioPCMBuffer, AVEncoderAudioQualityKey, AVEncoderBitRateKey,
        AVFormatIDKey, AVNumberOfChannelsKey, AVSampleRateKey,
    };
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

    /// `kAudioFormatMPEG4AAC` ('aac ').
    const AAC: u32 = 0x6161_6320;
    /// `AVAudioQuality.high`.
    const QUALITY_HIGH: i64 = 96;

    let channels = usize::from(pcm.channels);
    let failed = |what: &str, detail: String| audio_error(format!("{what}: {detail}"));
    let path_text = path
        .to_str()
        .ok_or_else(|| audio_error("The file name is not valid text."))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path_text));

    // SAFETY: the keys are constants of the AVFAudio framework, set once by the system.
    let keys: [&NSString; 5] = unsafe {
        [
            AVFormatIDKey,
            AVSampleRateKey,
            AVNumberOfChannelsKey,
            AVEncoderBitRateKey,
            AVEncoderAudioQualityKey,
        ]
        .map(|key| key.expect("AVFAudio defines its settings keys"))
    };
    let number = |value: Retained<NSNumber>| -> Retained<AnyObject> {
        // An NSNumber is an NSValue is an NSObject: the settings take any object.
        value.into_super().into_super().into_super()
    };
    let values = [
        number(NSNumber::numberWithUnsignedInt(AAC)),
        number(NSNumber::numberWithDouble(f64::from(pcm.sample_rate))),
        number(NSNumber::numberWithUnsignedInt(u32::from(pcm.channels))),
        number(NSNumber::numberWithUnsignedInt(bit_rate(pcm.channels))),
        number(NSNumber::numberWithLongLong(QUALITY_HIGH)),
    ];
    let settings = NSDictionary::<NSString, AnyObject>::from_retained_objects(&keys, &values);

    // SAFETY: the settings dictionary holds NSNumbers under the documented keys.
    let file = unsafe {
        AVAudioFile::initForWriting_settings_error(AVAudioFile::alloc(), &url, &settings)
    }
    .map_err(|error| {
        failed(
            "The system's AAC encoder could not start",
            error.localizedDescription().to_string(),
        )
    })?;
    // SAFETY: plain property read of an open file.
    let format = unsafe { file.processingFormat() };
    // SAFETY: the buffer's format is the file's own processing format.
    let buffer = unsafe {
        AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
            AVAudioPCMBuffer::alloc(),
            &format,
            CHUNK_FRAMES as u32,
        )
    }
    .ok_or_else(|| audio_error("The system could not make an audio buffer."))?;

    for chunk in pcm.samples.chunks(CHUNK_FRAMES * channels) {
        let frames = chunk.len() / channels;
        // SAFETY: the processing format is deinterleaved 32-bit float, so
        // `floatChannelData` holds one pointer per channel, each with room for
        // `CHUNK_FRAMES` samples, and `frames` never exceeds that.
        unsafe {
            let planes = buffer.floatChannelData();
            if planes.is_null() {
                return Err(audio_error("The system's audio buffer is not usable."));
            }
            for channel in 0..channels {
                let plane = slice::from_raw_parts_mut((*planes.add(channel)).as_ptr(), frames);
                for (frame, sample) in plane.iter_mut().enumerate() {
                    *sample = chunk[frame * channels + channel];
                }
            }
            buffer.setFrameLength(frames as u32);
            file.writeFromBuffer_error(&buffer).map_err(|error| {
                failed(
                    "The system's AAC encoder failed",
                    error.localizedDescription().to_string(),
                )
            })?;
        }
    }
    // Releasing the file is what finishes the `.m4a` (index and sizes).
    drop(file);
    Ok(())
}

#[cfg(windows)]
fn write_aac(pcm: &Pcm, path: &Path) -> Result<(), CommandError> {
    use windows::Win32::Media::MediaFoundation::{
        IMFAttributes, IMFMediaType, MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
        MF_MT_AAC_PAYLOAD_TYPE, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
        MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
        MF_MT_AVG_BITRATE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_TRANSCODE_CONTAINERTYPE, MF_VERSION,
        MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateAttributes, MFCreateMediaType,
        MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio,
        MFSTARTUP_FULL, MFShutdown, MFStartup, MFTranscodeContainerType_MPEG4,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    use windows::core::HSTRING;

    /// Ends Media Foundation when the encoding is over, however it ends.
    struct Started;
    impl Drop for Started {
        fn drop(&mut self) {
            // SAFETY: paired with the successful `MFStartup` below.
            let _ = unsafe { MFShutdown() };
        }
    }

    /// The system's AAC encoder only takes these rates.
    const RATES: [u32; 2] = [44_100, 48_000];
    /// 100-nanosecond ticks in a second (Media Foundation's time unit).
    const TICKS: i64 = 10_000_000;

    if !RATES.contains(&pcm.sample_rate) {
        return Err(audio_error(format!(
            "The Windows AAC encoder needs a sample rate of 44100 or 48000 Hz, not {} Hz.",
            pcm.sample_rate
        )));
    }
    let failed = |what: &str, error: windows::core::Error| {
        audio_error(format!("{what}: {}", error.message()))
    };
    let start = |e| failed("The system's AAC encoder could not start", e);
    let write = |e| failed("The system's AAC encoder failed", e);
    let path_text = path
        .to_str()
        .ok_or_else(|| audio_error("The file name is not valid text."))?;
    let channels = u32::from(pcm.channels);
    let rate = pcm.sample_rate;
    let frame_bytes = 2 * channels;

    // SAFETY: plain Media Foundation / COM calls; every pointer passed is a
    // reference to a live local, and each COM object is released when dropped.
    unsafe {
        // The thread may already be set up for COM in another mode: that is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(start)?;
        let _started = Started;

        // Without this the writer picks the container from the file name.
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 1).map_err(start)?;
        let attributes =
            attributes.ok_or_else(|| audio_error("The system could not make an encoder."))?;
        attributes
            .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
            .map_err(start)?;
        let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path_text), None, &attributes)
            .map_err(start)?;

        let aac: IMFMediaType = MFCreateMediaType().map_err(start)?;
        aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(start)?;
        aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(start)?;
        aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(start)?;
        aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)
            .map_err(start)?;
        aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)
            .map_err(start)?;
        aac.SetUINT32(
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            bit_rate(pcm.channels) / 8,
        )
        .map_err(start)?;
        aac.SetUINT32(&MF_MT_AVG_BITRATE, bit_rate(pcm.channels))
            .map_err(start)?;
        // Raw AAC frames in the MP4, AAC-LC level 2.
        aac.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0).map_err(start)?;
        aac.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)
            .map_err(start)?;
        let stream = writer.AddStream(&aac).map_err(start)?;

        let input: IMFMediaType = MFCreateMediaType().map_err(start)?;
        input
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(start)?;
        input
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(start)?;
        input
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(start)?;
        input
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)
            .map_err(start)?;
        input
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)
            .map_err(start)?;
        input
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, frame_bytes)
            .map_err(start)?;
        input
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * frame_bytes)
            .map_err(start)?;
        writer
            .SetInputMediaType(stream, &input, None)
            .map_err(start)?;
        writer.BeginWriting().map_err(start)?;

        let mut written_frames: i64 = 0;
        for chunk in pcm.samples.chunks(CHUNK_FRAMES * usize::from(pcm.channels)) {
            let frames = (chunk.len() / usize::from(pcm.channels)) as u32;
            let bytes = frames * frame_bytes;
            let buffer = MFCreateMemoryBuffer(bytes).map_err(write)?;
            let mut data: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None).map_err(write)?;
            // SAFETY: the buffer holds `bytes` bytes, which is `chunk.len()` 16-bit samples.
            let target = std::slice::from_raw_parts_mut(data.cast::<i16>(), chunk.len());
            for (out, sample) in target.iter_mut().zip(chunk) {
                *out = (sample.clamp(-1.0, 1.0) * 32_767.0).round() as i16;
            }
            buffer.Unlock().map_err(write)?;
            buffer.SetCurrentLength(bytes).map_err(write)?;

            let sample = MFCreateSample().map_err(write)?;
            sample.AddBuffer(&buffer).map_err(write)?;
            sample
                .SetSampleTime(written_frames * TICKS / i64::from(rate))
                .map_err(write)?;
            sample
                .SetSampleDuration(i64::from(frames) * TICKS / i64::from(rate))
                .map_err(write)?;
            writer.WriteSample(stream, &sample).map_err(write)?;
            written_frames += i64::from(frames);
        }
        // Finalizing writes the index and sizes that make the `.m4a` complete.
        writer.Finalize().map_err(write)?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn write_aac(_pcm: &Pcm, _path: &Path) -> Result<(), CommandError> {
    Err(audio_error(
        "M4A export is not available on this system. Export a WAV file instead.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WAV file of `samples` (interleaved), 16-bit.
    fn wav16(channels: u16, rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let spec = hound::WavSpec {
                channels,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::new(Cursor::new(&mut bytes), spec).unwrap();
            for &sample in samples {
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        bytes
    }

    #[test]
    fn reads_16_bit_stereo_as_floats() {
        let wav = wav16(2, 44_100, &[0, 16_384, -32_768, 32_767]);
        let pcm = decode_wav(&wav).unwrap();
        assert_eq!((pcm.sample_rate, pcm.channels), (44_100, 2));
        assert_eq!(pcm.samples.len(), 4);
        assert_eq!(pcm.samples[0], 0.0);
        assert_eq!(pcm.samples[1], 0.5);
        assert_eq!(pcm.samples[2], -1.0);
        assert!((pcm.samples[3] - 1.0).abs() < 0.001);
    }

    #[test]
    fn reads_float_wav_files() {
        let mut bytes = Vec::new();
        {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = hound::WavWriter::new(Cursor::new(&mut bytes), spec).unwrap();
            writer.write_sample(0.25f32).unwrap();
            writer.finalize().unwrap();
        }
        let pcm = decode_wav(&bytes).unwrap();
        assert_eq!((pcm.channels, pcm.samples.as_slice()), (1, &[0.25][..]));
    }

    #[test]
    fn refuses_files_that_are_not_usable_sound() {
        assert_eq!(
            decode_wav(b"not a wav file").unwrap_err().kind,
            ErrorKind::Audio
        );
        // No samples at all.
        assert_eq!(
            decode_wav(&wav16(2, 44_100, &[])).unwrap_err().message,
            "There is no sound to export."
        );
        // More than stereo, and rates the encoder is not given.
        assert!(
            decode_wav(&wav16(3, 44_100, &[0; 6]))
                .unwrap_err()
                .message
                .contains("mono and stereo")
        );
        assert!(
            decode_wav(&wav16(2, 1_000, &[0; 4]))
                .unwrap_err()
                .message
                .contains("1000 Hz")
        );
    }

    #[test]
    fn mono_gets_a_lower_bit_rate_than_stereo() {
        assert!(bit_rate(1) < bit_rate(2));
    }

    #[test]
    fn refuses_other_extensions_without_creating_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let wav = wav16(2, 44_100, &[0; 8]);
        for name in ["song.wav", "song.mp3", "song"] {
            let path = dir.path().join(name);
            let error = encode(&wav, &path).unwrap_err();
            assert_eq!(error.kind, ErrorKind::UnsupportedType, "{name}");
            assert!(!path.exists(), "{name}");
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn refuses_a_missing_folder_and_a_folder_as_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let wav = wav16(2, 44_100, &[0; 8]);
        let error = encode(&wav, &dir.path().join("nope/song.m4a")).unwrap_err();
        let expected = if SUPPORTED {
            ErrorKind::NotFound
        } else {
            ErrorKind::Audio
        };
        assert_eq!(error.kind, expected);
        let target = dir.path().join("folder.m4a");
        std::fs::create_dir(&target).unwrap();
        assert!(encode(&wav, &target).is_err());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn says_so_where_there_is_no_system_encoder() {
        let dir = tempfile::tempdir().unwrap();
        let error = encode(&wav16(2, 44_100, &[0; 8]), &dir.path().join("a.m4a")).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Audio);
        assert!(error.message.contains("not available on this system"));
    }
}
