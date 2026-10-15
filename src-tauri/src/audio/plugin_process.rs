//! Bounded request/reply transport. Even a blocked stdin write is timed out.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use super::plugin_wire::Command;
use vst3_host::process_isolation::HostResponse;

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

pub(super) struct HelperProcess {
    child: Child,
    requests: SyncSender<Vec<u8>>,
    responses: Receiver<Result<HostResponse, String>>,
    dead: bool,
}

impl HelperProcess {
    pub fn new(helper: &Path) -> Result<Self, String> {
        let mut child = ProcessCommand::new(helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // A hosted plugin prints where it likes. Keep those lines instead of
            // throwing them away: a plugin that fails to load usually says why.
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("The plugin helper cannot start: {e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (requests, request_rx) = mpsc::sync_channel::<Vec<u8>>(1);
        let (response_tx, responses) = mpsc::sync_channel(1);
        let spawn = std::thread::Builder::new()
            .name("plugin-pipe".into())
            .spawn(move || {
                while let Ok(bytes) = request_rx.recv() {
                    let result = (|| {
                        stdin.write_all(&bytes).map_err(|e| e.to_string())?;
                        stdin.flush().map_err(|e| e.to_string())?;
                        let mut line = Vec::new();
                        stdout
                            .by_ref()
                            .take(MAX_RESPONSE_BYTES + 1)
                            .read_until(b'\n', &mut line)
                            .map_err(|e| e.to_string())?;
                        if line.is_empty() {
                            return Err("The plugin helper exited".to_string());
                        }
                        if line.len() as u64 > MAX_RESPONSE_BYTES || !line.ends_with(b"\n") {
                            return Err("The plugin helper sent an invalid response".to_string());
                        }
                        serde_json::from_slice(&line).map_err(|e| e.to_string())
                    })();
                    let failed = result.is_err();
                    if response_tx.send(result).is_err() || failed {
                        break;
                    }
                }
            });
        if let Err(e) = spawn {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
        Ok(Self {
            child,
            requests,
            responses,
            dead: false,
        })
    }

    pub fn send(&mut self, command: Command, timeout: Duration) -> Result<HostResponse, String> {
        if self.dead {
            return Err("The plugin helper stopped responding".into());
        }
        let mut bytes = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let result = self
            .requests
            .try_send(bytes)
            .map_err(|e| e.to_string())
            .and_then(|()| {
                self.responses
                    .recv_timeout(timeout)
                    .map_err(|_| "The plugin helper timed out or exited".to_string())?
            });
        if result.is_err() {
            self.dead = true;
            let _ = self.child.kill();
        }
        result
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
