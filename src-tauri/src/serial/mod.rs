use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};

use crate::errors::{LumaError, Result};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_millis(100);
pub const MIN_BAUD_RATE: u32 = 300;
pub const MAX_BAUD_RATE: u32 = 4_000_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct SerialConfig {
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow_control: String,
}

struct ValidatedSerialConfig {
    data_bits: DataBits,
    parity: Parity,
    stop_bits: StopBits,
    flow_control: FlowControl,
}

impl SerialConfig {
    fn validate(&self) -> Result<ValidatedSerialConfig> {
        if self.path.trim().is_empty() {
            return Err(LumaError::InvalidInput("serial port path is empty".into()));
        }
        if self.path.contains('\0') {
            return Err(LumaError::InvalidInput(
                "serial port path contains a NUL byte".into(),
            ));
        }
        if self.path.len() > MAX_PATH_BYTES {
            return Err(LumaError::InvalidInput(
                "serial port path is too long".into(),
            ));
        }
        if !(MIN_BAUD_RATE..=MAX_BAUD_RATE).contains(&self.baud_rate) {
            return Err(LumaError::InvalidInput(format!(
                "baud rate must be between {MIN_BAUD_RATE} and {MAX_BAUD_RATE}"
            )));
        }

        let data_bits = match self.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => {
                return Err(LumaError::InvalidInput(
                    "data bits must be one of: 5, 6, 7, 8".into(),
                ));
            }
        };
        let parity = match self.parity.as_str() {
            "none" => Parity::None,
            "odd" => Parity::Odd,
            "even" => Parity::Even,
            _ => {
                return Err(LumaError::InvalidInput(
                    "parity must be one of: none, odd, even".into(),
                ));
            }
        };
        let stop_bits = match self.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => {
                return Err(LumaError::InvalidInput(
                    "stop bits must be one of: 1, 2".into(),
                ));
            }
        };
        let flow_control = match self.flow_control.as_str() {
            "none" => FlowControl::None,
            "software" => FlowControl::Software,
            "hardware" => FlowControl::Hardware,
            _ => {
                return Err(LumaError::InvalidInput(
                    "flow control must be one of: none, software, hardware".into(),
                ));
            }
        };

        Ok(ValidatedSerialConfig {
            data_bits,
            parity,
            stop_bits,
            flow_control,
        })
    }
}

struct SerialSession {
    writer: Mutex<Box<dyn SerialPort>>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SerialSession>>>>,
}

impl SerialManager {
    pub fn list_ports() -> Result<Vec<SerialPortInfo>> {
        let ports = serialport::available_ports()
            .map_err(|error| LumaError::Serial(format!("failed to list serial ports: {error}")))?;

        Ok(ports
            .into_iter()
            .map(|port| SerialPortInfo {
                path: port.port_name,
                kind: match port.port_type {
                    SerialPortType::UsbPort(_) => "usb",
                    SerialPortType::BluetoothPort => "bluetooth",
                    SerialPortType::PciPort => "pci",
                    SerialPortType::Unknown => "unknown",
                }
                .into(),
            })
            .collect())
    }

    /// Open a serial device. Bytes are delivered on a dedicated blocking reader
    /// thread through `on_data`; `on_exit` fires once after the reader stops and
    /// the session has been removed.
    pub fn open(
        &self,
        config: SerialConfig,
        mut on_data: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> Result<String> {
        let validated = config.validate()?;
        let port = serialport::new(&config.path, config.baud_rate)
            .data_bits(validated.data_bits)
            .parity(validated.parity)
            .stop_bits(validated.stop_bits)
            .flow_control(validated.flow_control)
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(|error| LumaError::Serial(format!("failed to open serial port: {error}")))?;
        let mut reader = port.try_clone().map_err(|error| {
            LumaError::Serial(format!("failed to create serial port reader: {error}"))
        })?;

        let id = uuid::Uuid::new_v4().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let session = Arc::new(SerialSession {
            writer: Mutex::new(port),
            stop: Arc::clone(&stop),
        });
        self.sessions.lock().unwrap().insert(id.clone(), session);

        let sessions = Arc::clone(&self.sessions);
        let reader_id = id.clone();
        let spawn_result = std::thread::Builder::new()
            .name(format!("serial-reader-{reader_id}"))
            .spawn(move || {
                let mut buf = vec![0u8; READ_BUFFER_BYTES];
                while !stop.load(Ordering::Acquire) {
                    match reader.read(&mut buf) {
                        Ok(0) => continue,
                        Ok(count) => on_data(&buf[..count]),
                        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(error) => {
                            tracing::warn!("serial session {reader_id} read failed: {error}");
                            break;
                        }
                    }
                }

                sessions.lock().unwrap().remove(&reader_id);
                on_exit(None);
                tracing::info!("serial session {reader_id} closed");
            });

        if let Err(error) = spawn_result {
            if let Some(session) = self.sessions.lock().unwrap().remove(&id) {
                session.stop.store(true, Ordering::Release);
            }
            return Err(LumaError::Serial(format!(
                "failed to start serial reader thread: {error}"
            )));
        }

        tracing::info!("opened serial session {id}");
        Ok(id)
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<()> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(LumaError::InvalidInput("input too large".into()));
        }

        let session = self.get(session_id)?;
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| LumaError::Serial(format!("write failed: {error}")))
    }

    pub fn kill(&self, session_id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown serial session".into()))?;
        session.stop.store(true, Ordering::Release);
        drop(session);
        Ok(())
    }

    /// Close every serial device; used during application shutdown so no device
    /// handle or reader thread remains active.
    pub fn kill_all(&self) {
        let sessions: Vec<(String, Arc<SerialSession>)> =
            self.sessions.lock().unwrap().drain().collect();
        for (id, session) in sessions {
            session.stop.store(true, Ordering::Release);
            drop(session);
            tracing::info!("closed serial session {id} on shutdown");
        }
    }

    fn get(&self, session_id: &str) -> Result<Arc<SerialSession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| LumaError::InvalidInput("unknown serial session".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_config() -> SerialConfig {
        SerialConfig {
            path: "test-port".into(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow_control: "none".into(),
        }
    }

    #[test]
    fn rejects_empty_path() {
        let mut config = valid_config();
        config.path = "   ".into();
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));
    }

    #[test]
    fn rejects_bad_baud_rate() {
        let mut config = valid_config();
        config.baud_rate = MIN_BAUD_RATE - 1;
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));

        config.baud_rate = MAX_BAUD_RATE + 1;
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));
    }

    #[test]
    fn rejects_bad_enum_values() {
        let mut config = valid_config();
        config.data_bits = 9;
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));

        let mut config = valid_config();
        config.parity = "mark".into();
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));

        let mut config = valid_config();
        config.stop_bits = 3;
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));

        let mut config = valid_config();
        config.flow_control = "dtr-dsr".into();
        assert!(matches!(config.validate(), Err(LumaError::InvalidInput(_))));
    }
}
