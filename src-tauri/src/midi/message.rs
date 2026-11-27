//! MIDI messages as the input side sees them: note on and off (velocity 0 is a note off),
//! controllers, pitch bend, channel pressure, program changes, and the MIDI Machine Control
//! transport messages a pad controller's Play, Stop and Record buttons send.

use serde::Serialize;

/// A transport button (MIDI Machine Control).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    Stop,
    Play,
    Record,
    Pause,
}

/// One message from a device, decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidiMessage {
    NoteOn { chan: u8, key: u8, vel: u8 },
    NoteOff { chan: u8, key: u8 },
    Cc { chan: u8, cc: u8, value: u8 },
    Bend { chan: u8, value: i16 },
    Pressure { chan: u8, value: u8 },
    PolyPressure { chan: u8, key: u8, value: u8 },
    Program { chan: u8, program: u8 },
    Transport(Transport),
}

impl MidiMessage {
    /// Decodes one complete message (`None`: clock, sense, an unknown or cut-off message).
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let status = *bytes.first()?;
        let d = |i: usize| bytes.get(i).copied().filter(|b| *b < 0x80);
        let chan = status & 0x0f;
        Some(match status & 0xf0 {
            0x90 => {
                let (key, vel) = (d(1)?, d(2)?);
                if vel == 0 {
                    MidiMessage::NoteOff { chan, key }
                } else {
                    MidiMessage::NoteOn { chan, key, vel }
                }
            }
            0x80 => MidiMessage::NoteOff { chan, key: d(1)? },
            0xb0 => MidiMessage::Cc {
                chan,
                cc: d(1)?,
                value: d(2)?,
            },
            0xe0 => MidiMessage::Bend {
                chan,
                value: ((d(2)? as i16) << 7 | d(1)? as i16) - 8192,
            },
            0xd0 => MidiMessage::Pressure { chan, value: d(1)? },
            0xa0 => MidiMessage::PolyPressure {
                chan,
                key: d(1)?,
                value: d(2)?,
            },
            0xc0 => MidiMessage::Program {
                chan,
                program: d(1)?,
            },
            _ if status == 0xf0 => return Self::mmc(bytes),
            _ => return None,
        })
    }

    /// MIDI Machine Control: `F0 7F <device> 06 <command> F7`.
    fn mmc(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 6 || bytes[1] != 0x7f || bytes[3] != 0x06 {
            return None;
        }
        Some(MidiMessage::Transport(match bytes[4] {
            0x01 => Transport::Stop,
            0x02 | 0x03 => Transport::Play,
            0x06 => Transport::Record,
            0x09 => Transport::Pause,
            _ => return None,
        }))
    }

    /// The three bytes an instrument plays (none for transport messages).
    pub fn bytes(self) -> Option<[u8; 3]> {
        Some(match self {
            MidiMessage::NoteOn { chan, key, vel } => [0x90 | chan, key, vel],
            MidiMessage::NoteOff { chan, key } => [0x80 | chan, key, 0],
            MidiMessage::Cc { chan, cc, value } => [0xb0 | chan, cc, value],
            MidiMessage::Bend { chan, value } => {
                let v = (value + 8192).clamp(0, 16_383) as u16;
                [0xe0 | chan, (v & 0x7f) as u8, (v >> 7) as u8]
            }
            MidiMessage::Pressure { chan, value } => [0xd0 | chan, value, 0],
            MidiMessage::PolyPressure { chan, key, value } => [0xa0 | chan, key, value],
            MidiMessage::Program { chan, program } => [0xc0 | chan, program, 0],
            MidiMessage::Transport(_) => return None,
        })
    }

    /// The message's channel (none for transport).
    pub fn channel(self) -> Option<u8> {
        match self {
            MidiMessage::NoteOn { chan, .. }
            | MidiMessage::NoteOff { chan, .. }
            | MidiMessage::Cc { chan, .. }
            | MidiMessage::Bend { chan, .. }
            | MidiMessage::Pressure { chan, .. }
            | MidiMessage::PolyPressure { chan, .. }
            | MidiMessage::Program { chan, .. } => Some(chan),
            MidiMessage::Transport(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_notes_controllers_and_bends() {
        assert_eq!(
            MidiMessage::decode(&[0x99, 36, 100]),
            Some(MidiMessage::NoteOn {
                chan: 9,
                key: 36,
                vel: 100
            })
        );
        assert_eq!(
            MidiMessage::decode(&[0x90, 36, 0]),
            Some(MidiMessage::NoteOff { chan: 0, key: 36 }),
            "velocity 0 is a note off"
        );
        assert_eq!(
            MidiMessage::decode(&[0xb3, 64, 127]),
            Some(MidiMessage::Cc {
                chan: 3,
                cc: 64,
                value: 127
            })
        );
        assert_eq!(
            MidiMessage::decode(&[0xe0, 0, 64]),
            Some(MidiMessage::Bend { chan: 0, value: 0 })
        );
        assert_eq!(
            MidiMessage::decode(&[0xe0, 0x7f, 0x7f]),
            Some(MidiMessage::Bend {
                chan: 0,
                value: 8191
            })
        );
        assert_eq!(MidiMessage::decode(&[0x90, 36]), None, "cut off");
        assert_eq!(MidiMessage::decode(&[0xf8]), None, "clock is ignored");
        assert_eq!(
            MidiMessage::decode(&[0x90, 200, 1]),
            None,
            "data bytes are 7-bit"
        );
    }

    #[test]
    fn decodes_transport_buttons() {
        let mmc = |cmd| MidiMessage::decode(&[0xf0, 0x7f, 0x7f, 0x06, cmd, 0xf7]);
        assert_eq!(mmc(0x02), Some(MidiMessage::Transport(Transport::Play)));
        assert_eq!(mmc(0x01), Some(MidiMessage::Transport(Transport::Stop)));
        assert_eq!(mmc(0x06), Some(MidiMessage::Transport(Transport::Record)));
        assert_eq!(mmc(0x44), None);
    }

    #[test]
    fn encodes_back_to_bytes() {
        for bytes in [
            [0x99, 36, 100],
            [0x83, 60, 0],
            [0xb0, 1, 64],
            [0xe5, 0x10, 0x40],
        ] {
            let message = MidiMessage::decode(&bytes).unwrap();
            assert_eq!(message.bytes(), Some(bytes));
        }
        assert_eq!(MidiMessage::Transport(Transport::Play).bytes(), None);
    }
}
