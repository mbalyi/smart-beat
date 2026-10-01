//! A song as the audio engine plays it: the MIDI events alphaTab generates for
//! the score (sent by the UI), with their times in seconds.

use serde::Deserialize;

/// Upper bounds, well above real songs, so a bad request cannot exhaust memory.
pub const MAX_EVENTS: usize = 2_000_000;
pub const MAX_TRACKS: usize = 64;

/// What the UI sends.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongData {
    /// Ticks per quarter note.
    pub division: u32,
    /// `[tick, status, data1, data2]` channel messages (status includes the channel).
    pub events: Vec<[u32; 4]>,
    /// `[tick, bpm]` tempo changes.
    pub tempos: Vec<(u32, f64)>,
    /// `[tick, accented]` metronome clicks (one per beat; accented on the first beat of a bar).
    #[serde(default)]
    pub metronome: Vec<(u32, bool)>,
    /// The MIDI channels of each track, in score order.
    pub tracks: Vec<Vec<u8>>,
    /// Song end (ticks).
    pub end_tick: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedEvent {
    /// Seconds from the start of the song (at normal speed).
    pub time: f64,
    pub track: u16,
    pub status: u8,
    pub data1: u8,
    pub data2: u8,
}

impl TimedEvent {
    pub fn channel(&self) -> u8 {
        self.status & 0x0f
    }

    pub fn is_note(&self) -> bool {
        matches!(self.status & 0xf0, 0x80 | 0x90)
    }
}

#[derive(Debug, Clone)]
pub struct Song {
    pub events: Vec<TimedEvent>,
    pub clicks: Vec<(f64, bool)>,
    pub track_channels: Vec<Vec<u8>>,
    /// Seconds.
    pub duration: f64,
    tempo: TempoMap,
}

/// Converts ticks to seconds along a tempo map.
#[derive(Debug, Clone, Default)]
struct TempoMap {
    /// (tick, seconds at that tick, seconds per tick from there on)
    segments: Vec<(u32, f64, f64)>,
}

impl TempoMap {
    fn new(division: u32, tempos: &[(u32, f64)]) -> Self {
        let per_tick = |bpm: f64| {
            let bpm = if bpm.is_finite() && bpm > 0.0 {
                bpm.clamp(1.0, 2_000.0)
            } else {
                120.0
            };
            60.0 / bpm / division as f64
        };
        let mut sorted: Vec<(u32, f64)> = tempos.to_vec();
        sorted.sort_by_key(|t| t.0);
        let mut segments = vec![(0u32, 0.0f64, per_tick(120.0))];
        for (tick, bpm) in sorted {
            let &(last_tick, last_time, last_rate) = segments.last().unwrap();
            let time = last_time + (tick - last_tick) as f64 * last_rate;
            if tick == last_tick {
                segments.last_mut().unwrap().2 = per_tick(bpm);
            } else {
                segments.push((tick, time, per_tick(bpm)));
            }
        }
        Self { segments }
    }

    fn seconds(&self, tick: u32) -> f64 {
        let i = self
            .segments
            .partition_point(|s| s.0 <= tick)
            .saturating_sub(1);
        let (start, time, rate) = self.segments[i];
        time + (tick - start) as f64 * rate
    }
}

impl Song {
    pub fn from_data(data: &SongData) -> Result<Self, String> {
        if data.division == 0 {
            return Err("the song has no tick resolution".into());
        }
        if data.events.len() > MAX_EVENTS {
            return Err("the song has too many events".into());
        }
        if data.tracks.len() > MAX_TRACKS {
            return Err("the song has too many tracks".into());
        }
        let map = TempoMap::new(data.division, &data.tempos);
        let track_of = |channel: u8| data.tracks.iter().position(|chs| chs.contains(&channel));
        let mut events: Vec<TimedEvent> = data
            .events
            .iter()
            .filter(|e| e[1] >= 0x80 && e[1] <= 0xef)
            .filter_map(|&[tick, status, d1, d2]| {
                let status = status as u8;
                track_of(status & 0x0f).map(|track| TimedEvent {
                    time: map.seconds(tick),
                    track: track as u16,
                    status,
                    data1: d1.min(127) as u8,
                    data2: d2.min(127) as u8,
                })
            })
            .collect();
        // Stable: at the same time, note-offs come before note-ons as generated.
        events.sort_by(|a, b| a.time.total_cmp(&b.time));
        let clicks = data
            .metronome
            .iter()
            .map(|&(tick, accent)| (map.seconds(tick), accent))
            .collect();
        Ok(Self {
            events,
            clicks,
            track_channels: data.tracks.clone(),
            duration: map.seconds(data.end_tick),
            tempo: map,
        })
    }

    /// Seconds from the start of the song to `tick` (at normal speed).
    pub fn seconds_at(&self, tick: u32) -> f64 {
        if self.tempo.segments.is_empty() {
            0.0
        } else {
            self.tempo.seconds(tick)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(events: Vec<[u32; 4]>, tempos: Vec<(u32, f64)>) -> SongData {
        SongData {
            division: 960,
            events,
            tempos,
            metronome: vec![(0, true), (960, false)],
            tracks: vec![vec![0, 1], vec![9]],
            end_tick: 960 * 8,
        }
    }

    #[test]
    fn converts_ticks_to_seconds_across_tempo_changes() {
        // 120 BPM for 4 beats (2 s), then 60 BPM.
        let song = Song::from_data(&data(
            vec![[960 * 4, 0x90, 60, 100], [960 * 5, 0x80, 60, 0]],
            vec![(0, 120.0), (960 * 4, 60.0)],
        ))
        .unwrap();
        assert!((song.events[0].time - 2.0).abs() < 1e-9);
        assert!((song.events[1].time - 3.0).abs() < 1e-9);
        assert!((song.duration - 6.0).abs() < 1e-9);
        assert!((song.clicks[1].0 - 0.5).abs() < 1e-9);
    }

    #[test]
    fn routes_channels_to_tracks_and_drops_unknown_ones() {
        let song = Song::from_data(&data(
            vec![
                [0, 0x91, 40, 90],
                [0, 0x99, 36, 100],
                [0, 0x95, 50, 100],
                [0, 0xf0, 0, 0],
            ],
            vec![],
        ))
        .unwrap();
        let tracks: Vec<u16> = song.events.iter().map(|e| e.track).collect();
        assert_eq!(tracks, vec![0, 1]);
        assert_eq!(song.events[1].channel(), 9);
    }

    #[test]
    fn rejects_bad_input_and_survives_bad_tempos() {
        let mut d = data(vec![], vec![(0, f64::NAN), (100, -5.0)]);
        assert!(Song::from_data(&d).is_ok());
        d.division = 0;
        assert!(Song::from_data(&d).is_err());
    }
}
