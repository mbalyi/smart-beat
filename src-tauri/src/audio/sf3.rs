//! Turns an SF3 SoundFont (samples compressed with Ogg Vorbis, as the bundled
//! Sonivox and FluidR3 sets are) into a plain SF2 the synthesizer can read:
//! every sample is decoded to 16-bit PCM and the sample headers are rewritten.
//! SF2 files pass through unchanged.

use std::collections::HashMap;
use std::io::Cursor;

/// Bit set in a sample header's type when the sample is Ogg Vorbis.
const VORBIS_FLAG: u16 = 0x10;
const SHDR_SIZE: usize = 46;
/// Zero samples after each sample, as the SF2 specification asks.
const SAMPLE_PADDING: usize = 46;

#[derive(Debug)]
pub struct Sf3Error(pub String);

impl std::fmt::Display for Sf3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(message: impl Into<String>) -> Sf3Error {
    Sf3Error(message.into())
}

fn u32_at(data: &[u8], at: usize) -> Result<u32, Sf3Error> {
    data.get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| err("the SoundFont is cut short"))
}

/// A chunk: its id and its byte range in the file (data only).
#[derive(Debug, Clone, Copy)]
struct Chunk<'a> {
    id: &'a [u8],
    start: usize,
    end: usize,
}

fn chunks(data: &[u8], mut at: usize, end: usize) -> Result<Vec<Chunk<'_>>, Sf3Error> {
    let mut out = Vec::new();
    while at + 8 <= end {
        let id = &data[at..at + 4];
        let size = u32_at(data, at + 4)? as usize;
        let start = at + 8;
        let chunk_end = start
            .checked_add(size)
            .filter(|&e| e <= end)
            .ok_or_else(|| err("a chunk runs past the end of the SoundFont"))?;
        out.push(Chunk {
            id,
            start,
            end: chunk_end,
        });
        at = chunk_end + (size & 1); // chunks are word aligned
    }
    Ok(out)
}

/// The `LIST` chunk whose type is `kind`, and its sub-chunks.
fn list<'a>(
    data: &'a [u8],
    top: &[Chunk<'a>],
    kind: &[u8],
) -> Result<(Chunk<'a>, Vec<Chunk<'a>>), Sf3Error> {
    let chunk = top
        .iter()
        .find(|c| c.id == b"LIST" && data.get(c.start..c.start + 4) == Some(kind))
        .copied()
        .ok_or_else(|| {
            err(format!(
                "the SoundFont has no {} list",
                String::from_utf8_lossy(kind)
            ))
        })?;
    Ok((chunk, chunks(data, chunk.start + 4, chunk.end)?))
}

fn decode_vorbis(bytes: &[u8]) -> Result<Vec<i16>, Sf3Error> {
    let mut reader = lewton::inside_ogg::OggStreamReader::new(Cursor::new(bytes))
        .map_err(|e| err(format!("a compressed sample cannot be read: {e}")))?;
    let mut pcm = Vec::new();
    while let Some(packet) = reader
        .read_dec_packet_itl()
        .map_err(|e| err(format!("a compressed sample cannot be decoded: {e}")))?
    {
        pcm.extend(packet);
    }
    Ok(pcm)
}

fn write_chunk(out: &mut Vec<u8>, id: &[u8], body: &[u8]) {
    out.extend_from_slice(id);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(0);
    }
}

/// Returns an SF2 version of `data` (borrowed back unchanged if it already is one).
pub fn to_sf2(data: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, Sf3Error> {
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"sfbk" {
        return Err(err("this is not a SoundFont file"));
    }
    let riff_end = (8 + u32_at(data, 4)? as usize).min(data.len());
    let top = chunks(data, 12, riff_end)?;
    let (_, sdta) = list(data, &top, b"sdta")?;
    let (_, pdta) = list(data, &top, b"pdta")?;
    let smpl = sdta
        .iter()
        .find(|c| c.id == b"smpl")
        .ok_or_else(|| err("the SoundFont has no samples"))?;
    let shdr = pdta
        .iter()
        .find(|c| c.id == b"shdr")
        .ok_or_else(|| err("the SoundFont has no sample headers"))?;
    let headers = &data[shdr.start..shdr.end];
    if !headers.len().is_multiple_of(SHDR_SIZE) {
        return Err(err("the sample headers are damaged"));
    }
    let count = headers.len() / SHDR_SIZE;
    let compressed = (0..count).any(|i| {
        let t = u16::from_le_bytes([headers[i * SHDR_SIZE + 44], headers[i * SHDR_SIZE + 45]]);
        t & VORBIS_FLAG != 0
    });
    if !compressed {
        return Ok(std::borrow::Cow::Borrowed(data));
    }

    let samples = &data[smpl.start..smpl.end];
    let mut pcm: Vec<u8> = Vec::with_capacity(samples.len() * 8);
    let mut new_headers = headers.to_vec();
    // Stereo pairs and copies point at the same compressed range: decode once.
    let mut decoded: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    // The last header is the terminal "EOS" record.
    for i in 0..count.saturating_sub(1) {
        let h = &mut new_headers[i * SHDR_SIZE..(i + 1) * SHDR_SIZE];
        let field =
            |h: &[u8], at: usize| u32::from_le_bytes([h[at], h[at + 1], h[at + 2], h[at + 3]]);
        let (start, end) = (field(h, 20), field(h, 24));
        let (loop_start, loop_end) = (field(h, 28), field(h, 32));
        let kind = u16::from_le_bytes([h[44], h[45]]);
        if kind & VORBIS_FLAG == 0 {
            return Err(err(
                "SoundFonts that mix compressed and plain samples are not supported",
            ));
        }
        let (new_start, new_end) = match decoded.get(&(start, end)) {
            Some(&range) => range,
            None => {
                let bytes = samples
                    .get(start as usize..end as usize)
                    .ok_or_else(|| err("a sample points outside the sample data"))?;
                let frames = decode_vorbis(bytes)?;
                let new_start = (pcm.len() / 2) as u32;
                for s in &frames {
                    pcm.extend_from_slice(&s.to_le_bytes());
                }
                let new_end = (pcm.len() / 2) as u32;
                pcm.resize(pcm.len() + SAMPLE_PADDING * 2, 0);
                decoded.insert((start, end), (new_start, new_end));
                (new_start, new_end)
            }
        };
        // SF3 loop points count from the sample's own start.
        let put = |h: &mut [u8], at: usize, v: u32| h[at..at + 4].copy_from_slice(&v.to_le_bytes());
        put(h, 20, new_start);
        put(h, 24, new_end);
        put(h, 28, (new_start + loop_start).min(new_end));
        put(h, 32, (new_start + loop_end).min(new_end));
        h[44..46].copy_from_slice(&(kind & !VORBIS_FLAG).to_le_bytes());
    }

    // Rebuild the file: INFO as it is, new sdta, pdta with the new headers.
    let mut body = Vec::with_capacity(pcm.len() + data.len());
    body.extend_from_slice(b"sfbk");
    for chunk in &top {
        let kind = data.get(chunk.start..chunk.start + 4);
        if chunk.id == b"LIST" && kind == Some(b"sdta") {
            let mut list_body = b"sdta".to_vec();
            write_chunk(&mut list_body, b"smpl", &pcm);
            write_chunk(&mut body, b"LIST", &list_body);
        } else if chunk.id == b"LIST" && kind == Some(b"pdta") {
            let mut list_body = b"pdta".to_vec();
            for sub in &pdta {
                let content = if sub.id == b"shdr" {
                    &new_headers[..]
                } else {
                    &data[sub.start..sub.end]
                };
                write_chunk(&mut list_body, sub.id, content);
            }
            write_chunk(&mut body, b"LIST", &list_body);
        } else {
            write_chunk(&mut body, chunk.id, &data[chunk.start..chunk.end]);
        }
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    write_chunk(&mut out, b"RIFF", &body);
    Ok(std::borrow::Cow::Owned(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_files_that_are_not_soundfonts() {
        assert!(to_sf2(b"not a soundfont").is_err());
        assert!(to_sf2(b"RIFF\x04\x00\x00\x00WAVE").is_err());
    }

    #[test]
    fn rejects_a_truncated_chunk() {
        let mut data = b"RIFF\x20\x00\x00\x00sfbk".to_vec();
        data.extend_from_slice(b"LIST\xff\x00\x00\x00");
        assert!(to_sf2(&data).is_err());
    }
}
