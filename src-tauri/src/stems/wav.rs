//! 16-bit stereo WAV files: the stem writer (a [`StemSink`] that streams to disk), a block
//! reader, and an in-memory encoder for the rendered mix.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::StemInfo;
use crate::separation::{StemKind, StemSink};

const HEADER_BYTES: u64 = 44;
/// A RIFF size field is 32 bits.
const MAX_DATA_BYTES: u64 = u32::MAX as u64 - 36;

fn header(rate: u32, data_bytes: u32) -> [u8; HEADER_BYTES as usize] {
    let mut h = [0u8; HEADER_BYTES as usize];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&2u16.to_le_bytes()); // stereo
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * 4).to_le_bytes());
    h[32..34].copy_from_slice(&4u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

fn to_i16(x: f32) -> i16 {
    (x * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}

fn push_frames(out: &mut Vec<u8>, left: &[f32], right: &[f32]) {
    out.reserve(left.len() * 4);
    for (l, r) in left.iter().zip(right) {
        out.extend_from_slice(&to_i16(*l).to_le_bytes());
        out.extend_from_slice(&to_i16(*r).to_le_bytes());
    }
}

/// A whole 16-bit stereo WAV file in memory.
pub fn encode(rate: u32, left: &[f32], right: &[f32]) -> Result<Vec<u8>, String> {
    let data = left.len().min(right.len()) as u64 * 4;
    if data > MAX_DATA_BYTES {
        return Err("The rendered mix is too long for a WAV file".into());
    }
    let mut out = Vec::with_capacity(HEADER_BYTES as usize + data as usize);
    out.extend_from_slice(&header(rate, data as u32));
    push_frames(&mut out, left, right);
    Ok(out)
}

struct Writer {
    file: BufWriter<File>,
    frames: u64,
}

/// Writes every stem it is given to `<dir>/<kind>.wav`, as the separation hands them over, so
/// a long song never sits in memory. The header gets placeholder sizes first and the real ones
/// in [`WavSink::finish`].
pub struct WavSink {
    dir: PathBuf,
    rate: u32,
    writers: BTreeMap<StemKind, Writer>,
    scratch: Vec<u8>,
}

impl WavSink {
    pub fn new(dir: &Path, rate: u32) -> Self {
        Self {
            dir: dir.to_path_buf(),
            rate,
            writers: BTreeMap::new(),
            scratch: Vec::new(),
        }
    }

    /// Writes the final sizes into the headers and closes the files. Returns the stems that
    /// received audio, in the order of [`StemKind::ALL`].
    pub fn finish(self) -> Result<Vec<StemInfo>, String> {
        let mut out = Vec::new();
        for (kind, mut w) in self.writers {
            let data = w.frames * 4;
            let io = |e: std::io::Error| format!("The {} stem could not be saved: {e}", kind.id());
            w.file.flush().map_err(io)?;
            w.file.seek(SeekFrom::Start(4)).map_err(io)?;
            w.file
                .write_all(&(36 + data as u32).to_le_bytes())
                .map_err(io)?;
            w.file.seek(SeekFrom::Start(40)).map_err(io)?;
            w.file.write_all(&(data as u32).to_le_bytes()).map_err(io)?;
            w.file.flush().map_err(io)?;
            out.push(StemInfo {
                kind,
                bytes: HEADER_BYTES + data,
            });
        }
        Ok(out)
    }
}

impl StemSink for WavSink {
    fn write(&mut self, kind: StemKind, left: &[f32], right: &[f32]) -> Result<(), String> {
        if !self.writers.contains_key(&kind) {
            let path = self.dir.join(format!("{}.wav", kind.id()));
            let file = File::create(&path)
                .map_err(|e| format!("The {} stem could not be saved: {e}", kind.id()))?;
            let mut file = BufWriter::with_capacity(1 << 20, file);
            file.write_all(&header(self.rate, 0))
                .map_err(|e| format!("The {} stem could not be saved: {e}", kind.id()))?;
            self.writers.insert(kind, Writer { file, frames: 0 });
        }
        let w = self.writers.get_mut(&kind).expect("just inserted");
        let frames = left.len().min(right.len());
        if (w.frames + frames as u64) * 4 > MAX_DATA_BYTES {
            return Err("The recording is too long to save as WAV stems".into());
        }
        self.scratch.clear();
        push_frames(&mut self.scratch, left, right);
        w.file
            .write_all(&self.scratch)
            .map_err(|e| format!("The {} stem could not be saved: {e}", kind.id()))?;
        w.frames += frames as u64;
        Ok(())
    }
}

/// Reads a 16-bit stereo PCM WAV (as written above) block by block.
pub struct Pcm16 {
    reader: BufReader<File>,
    pub rate: u32,
    pub frames: u64,
    read: u64,
}

impl Pcm16 {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("A stem could not be opened: {e}"))?;
        let mut reader = BufReader::with_capacity(1 << 20, file);
        let bad = || "A stem file is damaged".to_string();
        let mut riff = [0u8; 12];
        reader.read_exact(&mut riff).map_err(|_| bad())?;
        if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
            return Err(bad());
        }
        let mut rate = 0u32;
        loop {
            let mut chunk = [0u8; 8];
            reader.read_exact(&mut chunk).map_err(|_| bad())?;
            let size = u32::from_le_bytes(chunk[4..8].try_into().expect("4 bytes"));
            match &chunk[0..4] {
                b"fmt " => {
                    let mut fmt = vec![0u8; size as usize];
                    reader.read_exact(&mut fmt).map_err(|_| bad())?;
                    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
                    let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                    let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
                    if tag != 1 || channels != 2 || bits != 16 {
                        return Err(bad());
                    }
                    rate = u32::from_le_bytes(fmt[4..8].try_into().expect("4 bytes"));
                    if size % 2 == 1 {
                        reader.seek_relative(1).map_err(|_| bad())?;
                    }
                }
                b"data" => {
                    if rate == 0 {
                        return Err(bad());
                    }
                    return Ok(Self {
                        reader,
                        rate,
                        frames: u64::from(size) / 4,
                        read: 0,
                    });
                }
                _ => {
                    let skip = i64::from(size) + i64::from(size % 2);
                    reader.seek_relative(skip).map_err(|_| bad())?;
                }
            }
        }
    }

    /// Appends up to `max` frames to `left` and `right` as floats; returns how many came.
    pub fn read_block(
        &mut self,
        left: &mut Vec<f32>,
        right: &mut Vec<f32>,
        max: usize,
    ) -> Result<usize, String> {
        let want = (self.frames - self.read).min(max as u64) as usize;
        let mut bytes = vec![0u8; want * 4];
        self.reader
            .read_exact(&mut bytes)
            .map_err(|_| "A stem file is damaged".to_string())?;
        for frame in bytes.as_chunks::<4>().0 {
            left.push(f32::from(i16::from_le_bytes([frame[0], frame[1]])) / 32768.0);
            right.push(f32::from(i16::from_le_bytes([frame[2], frame[3]])) / 32768.0);
        }
        self.read += want as u64;
        Ok(want)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_streamed_file_has_the_right_header_and_samples() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = WavSink::new(dir.path(), 44_100);
        let a: Vec<f32> = (0..1000).map(|i| (i as f32 / 1000.0) - 0.5).collect();
        let b: Vec<f32> = a.iter().map(|x| -x).collect();
        sink.write(StemKind::Bass, &a[..400], &b[..400]).unwrap();
        sink.write(StemKind::Drums, &a[..10], &b[..10]).unwrap();
        sink.write(StemKind::Bass, &a[400..], &b[400..]).unwrap();
        let stems = sink.finish().unwrap();
        // Drums sorts before bass.
        assert_eq!(stems[0].kind, StemKind::Drums);
        assert_eq!(stems[1].kind, StemKind::Bass);
        assert_eq!(stems[1].bytes, 44 + 4000);
        let path = dir.path().join("bass.wav");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 4044);
        // hound, a second implementation, agrees with the header.
        let mut reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(
            (spec.channels, spec.sample_rate, spec.bits_per_sample),
            (2, 44_100, 16)
        );
        assert_eq!(reader.duration(), 1000);
        let first: Vec<i16> = reader
            .samples::<i16>()
            .take(2)
            .map(|s| s.unwrap())
            .collect();
        assert_eq!(first, vec![to_i16(a[0]), to_i16(b[0])]);
        // And so does the reader.
        let mut pcm = Pcm16::open(&path).unwrap();
        assert_eq!((pcm.rate, pcm.frames), (44_100, 1000));
        let (mut l, mut r) = (Vec::new(), Vec::new());
        assert_eq!(pcm.read_block(&mut l, &mut r, 600).unwrap(), 600);
        assert_eq!(pcm.read_block(&mut l, &mut r, 600).unwrap(), 400);
        assert_eq!(pcm.read_block(&mut l, &mut r, 600).unwrap(), 0);
        for i in 0..1000 {
            assert!((l[i] - a[i]).abs() < 1.0 / 16_000.0);
            assert!((r[i] - b[i]).abs() < 1.0 / 16_000.0);
        }
    }

    #[test]
    fn out_of_range_samples_clip_instead_of_wrapping() {
        let bytes = encode(8000, &[2.0, -2.0], &[0.0, 1.0]).unwrap();
        let pcm: Vec<i16> = bytes[44..]
            .chunks(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(pcm, vec![32767, 0, -32768, 32767]);
    }

    #[test]
    fn the_reader_refuses_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.wav");
        std::fs::write(&path, b"not a wav file at all").unwrap();
        assert!(Pcm16::open(&path).is_err());
        let mono = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, mono).unwrap();
        w.write_sample(1i16).unwrap();
        w.finalize().unwrap();
        assert!(Pcm16::open(&path).is_err());
    }
}
