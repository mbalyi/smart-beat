use rustysynth::*;
use std::{fs::File, sync::Arc};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let sf = Arc::new(SoundFont::new(&mut File::open(&a[1]).unwrap()).unwrap());
    let mid = Arc::new(MidiFile::new(&mut File::open(&a[2]).unwrap()).unwrap());
    let mut s = MidiFileSequencer::new(Synthesizer::new(&sf, &SynthesizerSettings::new(44100)).unwrap());
    s.play(&mid, false);
    let n = (44100.0 * (mid.get_length() + 2.0)) as usize;
    let (mut l, mut r) = (vec![0f32; n], vec![0f32; n]);
    s.render(&mut l, &mut r);
    let mut w = hound::WavWriter::create(&a[3], hound::WavSpec { channels: 1, sample_rate: 44100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }).unwrap();
    for i in 0..n { w.write_sample((((l[i] + r[i]) * 0.5).clamp(-1.0, 1.0) * 30000.0) as i16).unwrap(); }
}
