//! Reads the weights of a PyTorch model saved in the legacy (pre-1.6) `.pth` format, which is
//! what the Open-Unmix weights on Zenodo use: five pickles back to back (magic number, protocol,
//! system info, the state dict with storage references, the list of storage keys) followed by one
//! raw record per storage.
//!
//! A pickle is data plus instructions, so this is a tiny interpreter that understands only the
//! handful of opcodes a state dict uses. It builds plain values; it never imports or runs
//! anything named in the file, so a hostile file can at worst fail to parse.

use std::collections::HashMap;

/// One tensor of the state dict. Only 32-bit float tensors carry data.
#[derive(Debug, Clone, PartialEq)]
pub struct Tensor {
    pub shape: Vec<usize>,
    pub data: Vec<f32>,
}

#[derive(Debug, Clone)]
enum V {
    None,
    Bool,
    Int(i64),
    Str(String),
    Tuple(Vec<V>),
    List(Vec<V>),
    Dict(Vec<(V, V)>),
    Global(String),
    Storage {
        key: String,
        kind: String,
    },
    Tensor {
        key: String,
        kind: String,
        offset: usize,
        shape: Vec<usize>,
    },
    Mark,
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.bytes.len());
        let end = end.ok_or("The weights file ends too early")?;
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn line(&mut self) -> Result<String, String> {
        let start = self.pos;
        while self.u8()? != b'\n' {}
        Ok(String::from_utf8_lossy(&self.bytes[start..self.pos - 1]).into_owned())
    }
}

fn pop(stack: &mut Vec<V>) -> Result<V, String> {
    stack
        .pop()
        .ok_or_else(|| "Malformed weights file (pickle stack)".to_string())
}

fn to_usize(v: &V) -> Result<usize, String> {
    match v {
        V::Int(i) if *i >= 0 => Ok(*i as usize),
        _ => Err("Malformed weights file (size)".into()),
    }
}

/// Runs one pickle starting at the reader's position and returns its result.
fn run_pickle(r: &mut Reader) -> Result<V, String> {
    let mut stack: Vec<V> = Vec::new();
    let mut memo: HashMap<u32, V> = HashMap::new();
    let mark_index = |stack: &Vec<V>| {
        stack
            .iter()
            .rposition(|v| matches!(v, V::Mark))
            .ok_or_else(|| "Malformed weights file (mark)".to_string())
    };
    loop {
        let op = r.u8()?;
        match op {
            0x80 => {
                r.u8()?; // PROTO
            }
            b'.' => return pop(&mut stack),
            b'}' => stack.push(V::Dict(Vec::new())),
            b']' => stack.push(V::List(Vec::new())),
            b')' => stack.push(V::Tuple(Vec::new())),
            b'N' => stack.push(V::None),
            0x88 => stack.push(V::Bool),
            0x89 => stack.push(V::Bool),
            b'(' => stack.push(V::Mark),
            b'K' => stack.push(V::Int(r.u8()? as i64)),
            b'M' => {
                let b = r.take(2)?;
                stack.push(V::Int(u16::from_le_bytes([b[0], b[1]]) as i64));
            }
            b'J' => stack.push(V::Int(r.u32()? as i32 as i64)),
            0x8a => {
                let n = r.u8()? as usize;
                let b = r.take(n)?;
                let mut v: i128 = 0;
                for (i, byte) in b.iter().enumerate().take(16) {
                    v |= (*byte as i128) << (8 * i);
                }
                stack.push(V::Int(v as i64));
            }
            b'X' => {
                let n = r.u32()? as usize;
                stack.push(V::Str(String::from_utf8_lossy(r.take(n)?).into_owned()));
            }
            0x8c => {
                let n = r.u8()? as usize;
                stack.push(V::Str(String::from_utf8_lossy(r.take(n)?).into_owned()));
            }
            b'c' => {
                let module = r.line()?;
                let name = r.line()?;
                stack.push(V::Global(format!("{module}.{name}")));
            }
            b'q' => {
                let i = r.u8()? as u32;
                memo.insert(
                    i,
                    stack
                        .last()
                        .cloned()
                        .ok_or("Malformed weights file (memo)")?,
                );
            }
            b'r' => {
                let i = r.u32()?;
                memo.insert(
                    i,
                    stack
                        .last()
                        .cloned()
                        .ok_or("Malformed weights file (memo)")?,
                );
            }
            b'h' => {
                let i = r.u8()? as u32;
                stack.push(
                    memo.get(&i)
                        .cloned()
                        .ok_or("Malformed weights file (memo)")?,
                );
            }
            b'j' => {
                let i = r.u32()?;
                stack.push(
                    memo.get(&i)
                        .cloned()
                        .ok_or("Malformed weights file (memo)")?,
                );
            }
            b't' | 0x85 | 0x86 | 0x87 => {
                let items = if op == b't' {
                    let m = mark_index(&stack)?;
                    let items = stack.split_off(m + 1);
                    stack.pop();
                    items
                } else {
                    let n = (op - 0x84) as usize;
                    if stack.len() < n {
                        return Err("Malformed weights file (tuple)".into());
                    }
                    stack.split_off(stack.len() - n)
                };
                stack.push(V::Tuple(items));
            }
            b'Q' => {
                // Persistent id: ('storage', torch.FloatStorage, key, location, numel).
                let V::Tuple(pid) = pop(&mut stack)? else {
                    return Err("Malformed weights file (storage reference)".into());
                };
                match pid.as_slice() {
                    [V::Str(tag), V::Global(kind), V::Str(key), ..] if tag == "storage" => {
                        stack.push(V::Storage {
                            key: key.clone(),
                            kind: kind.clone(),
                        });
                    }
                    _ => return Err("Malformed weights file (storage reference)".into()),
                }
            }
            b'R' => {
                let args = pop(&mut stack)?;
                let callable = pop(&mut stack)?;
                let value = match (&callable, &args) {
                    (V::Global(name), V::Tuple(a)) if name == "torch._utils._rebuild_tensor_v2" => {
                        match a.as_slice() {
                            [V::Storage { key, kind }, offset, V::Tuple(size), ..] => V::Tensor {
                                key: key.clone(),
                                kind: kind.clone(),
                                offset: to_usize(offset)?,
                                shape: size.iter().map(to_usize).collect::<Result<_, _>>()?,
                            },
                            _ => return Err("Malformed weights file (tensor)".into()),
                        }
                    }
                    (V::Global(name), _) if name == "collections.OrderedDict" => {
                        V::Dict(Vec::new())
                    }
                    _ => V::None,
                };
                stack.push(value);
            }
            b'b' => {
                pop(&mut stack)?; // BUILD: the state is not needed
            }
            b's' => {
                let value = pop(&mut stack)?;
                let key = pop(&mut stack)?;
                match stack.last_mut() {
                    Some(V::Dict(d)) => d.push((key, value)),
                    _ => return Err("Malformed weights file (dict)".into()),
                }
            }
            b'u' => {
                let m = mark_index(&stack)?;
                let items = stack.split_off(m + 1);
                stack.pop();
                match stack.last_mut() {
                    Some(V::Dict(d)) => {
                        for [key, value] in items.as_chunks::<2>().0 {
                            d.push((key.clone(), value.clone()));
                        }
                    }
                    _ => return Err("Malformed weights file (dict)".into()),
                }
            }
            b'a' => {
                let value = pop(&mut stack)?;
                match stack.last_mut() {
                    Some(V::List(l)) => l.push(value),
                    _ => return Err("Malformed weights file (list)".into()),
                }
            }
            b'e' => {
                let m = mark_index(&stack)?;
                let items = stack.split_off(m + 1);
                stack.pop();
                match stack.last_mut() {
                    Some(V::List(l)) => l.extend(items),
                    _ => return Err("Malformed weights file (list)".into()),
                }
            }
            other => {
                return Err(format!(
                    "Unsupported weights file (pickle opcode {other:#x})"
                ));
            }
        }
    }
}

/// Reads every 32-bit float tensor of a legacy `.pth` state dict, by name.
pub fn read_state_dict(bytes: &[u8]) -> Result<HashMap<String, Tensor>, String> {
    let mut r = Reader { bytes, pos: 0 };
    let magic = run_pickle(&mut r)?;
    if !matches!(magic, V::Int(_)) {
        return Err("This is not a PyTorch weights file".into());
    }
    run_pickle(&mut r)?; // protocol version
    run_pickle(&mut r)?; // system info
    let V::Dict(entries) = run_pickle(&mut r)? else {
        return Err("The weights file holds no state dict".into());
    };
    let V::List(keys) = run_pickle(&mut r)? else {
        return Err("Malformed weights file (storage list)".into());
    };
    // Storage records, in key order: 8 bytes of element count, then the elements. The element
    // size comes from the storage class the tensors name.
    let mut kinds: HashMap<&str, &str> = HashMap::new();
    for (_, v) in &entries {
        if let V::Tensor { key, kind, .. } = v {
            kinds.insert(key, kind);
        }
    }
    let mut storages: HashMap<String, (usize, usize, bool)> = HashMap::new(); // start, count, float
    for key in &keys {
        let V::Str(key) = key else {
            return Err("Malformed weights file (storage key)".into());
        };
        let count = u64::from_le_bytes(r.take(8)?.try_into().unwrap()) as usize;
        let kind = kinds
            .get(key.as_str())
            .copied()
            .unwrap_or("torch.FloatStorage");
        let size = match kind {
            "torch.FloatStorage" | "torch.IntStorage" => 4,
            "torch.LongStorage" | "torch.DoubleStorage" => 8,
            "torch.HalfStorage" | "torch.ShortStorage" => 2,
            "torch.ByteStorage" | "torch.CharStorage" | "torch.BoolStorage" => 1,
            other => return Err(format!("Unsupported weights file (storage {other})")),
        };
        storages.insert(key.clone(), (r.pos, count, kind == "torch.FloatStorage"));
        r.take(
            count
                .checked_mul(size)
                .ok_or("Malformed weights file (size)")?,
        )?;
    }
    let mut out = HashMap::new();
    for (k, v) in entries {
        let (
            V::Str(name),
            V::Tensor {
                key, offset, shape, ..
            },
        ) = (k, v)
        else {
            continue;
        };
        let Some(&(start, count, float)) = storages.get(&key) else {
            continue;
        };
        let n: usize = shape.iter().product::<usize>().max(1);
        if !float || offset + n > count {
            continue; // an int64 counter, for example: not needed for inference
        }
        let data = bytes[start + offset * 4..start + (offset + n) * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        out.insert(name, Tensor { shape, data });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A legacy file with one float tensor `w` (shape 2x2) and one int64 counter `n`, built by
    /// hand in the layout PyTorch 1.x wrote.
    fn tiny_file() -> Vec<u8> {
        let mut f = Vec::new();
        // 1: magic (LONG1 of 10 bytes), 2: protocol 1001, 3: system info (empty dict).
        f.extend([
            0x80, 2, 0x8a, 10, 0x6c, 0xfc, 0x9c, 0x46, 0xf9, 0x20, 0x6a, 0xa8, 0x50, 0x19, b'.',
        ]);
        f.extend([0x80, 2, b'M', 0xe9, 0x03, b'.']);
        f.extend([0x80, 2, b'}', b'.']);
        // 4: OrderedDict { 'w': tensor(storage '1', float, 4), 'n': tensor(storage '2', long, 1) }
        let mut p = vec![0x80, 2];
        p.extend(
            b"ccollections
OrderedDict
)R(",
        );
        for (name, key, kind, size) in [
            ("w", "1", "FloatStorage", &[2u8, 2][..]),
            ("n", "2", "LongStorage", &[][..]),
        ] {
            p.extend([b'X', 1, 0, 0, 0]);
            p.extend(name.as_bytes());
            p.extend(
                b"ctorch._utils
_rebuild_tensor_v2
(",
            );
            // persistent id tuple
            p.extend([b'(', b'X', 7, 0, 0, 0]);
            p.extend(b"storage");
            p.extend(
                format!(
                    "ctorch
{kind}
"
                )
                .as_bytes(),
            );
            p.extend([b'X', 1, 0, 0, 0]);
            p.extend(key.as_bytes());
            p.extend([b'X', 3, 0, 0, 0]);
            p.extend(b"cpu");
            p.extend([b'K', if kind == "FloatStorage" { 4 } else { 1 }, b't', b'Q']);
            p.extend([b'K', 0]); // offset
            p.push(b'(');
            for d in size {
                p.extend([b'K', *d]);
            }
            p.push(b't');
            p.extend(b"(t"); // stride
            p.extend([0x89, b'N', b't', b'R']);
        }
        p.extend(b"u.");
        f.extend(p);
        // 5: storage keys list
        let mut l = vec![0x80, 2, b']', b'('];
        for k in ["1", "2"] {
            l.extend([b'X', 1, 0, 0, 0]);
            l.extend(k.as_bytes());
        }
        l.extend(b"e.");
        f.extend(l);
        // Records.
        f.extend(4u64.to_le_bytes());
        for v in [1.0f32, 2.0, 3.0, 4.5] {
            f.extend(v.to_le_bytes());
        }
        f.extend(1u64.to_le_bytes());
        f.extend(7i64.to_le_bytes());
        f
    }

    #[test]
    fn reads_float_tensors_and_skips_the_int_counter() {
        let sd = read_state_dict(&tiny_file()).unwrap();
        assert_eq!(sd.len(), 1);
        let w = &sd["w"];
        assert_eq!(w.shape, vec![2, 2]);
        assert_eq!(w.data, vec![1.0, 2.0, 3.0, 4.5]);
    }

    #[test]
    fn a_file_that_is_not_torch_is_refused_without_panicking() {
        assert!(read_state_dict(b"PK\x03\x04 not a legacy file").is_err());
        assert!(read_state_dict(&[]).is_err());
        let mut cut = tiny_file();
        cut.truncate(cut.len() - 20);
        assert!(read_state_dict(&cut).is_err());
    }
}
