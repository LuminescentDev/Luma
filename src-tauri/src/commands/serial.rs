use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::errors::Result;
use crate::serial::{SerialConfig, SerialManager, SerialPortInfo};

const DEFAULT_DATA_BITS: u8 = 8;
const DEFAULT_PARITY: &str = "none";
const DEFAULT_STOP_BITS: u8 = 1;
const DEFAULT_FLOW_CONTROL: &str = "none";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSpawnRequest {
    pub path: String,
    pub baud_rate: u32,
    #[serde(default)]
    pub data_bits: Option<u8>,
    #[serde(default)]
    pub parity: Option<String>,
    #[serde(default)]
    pub stop_bits: Option<u8>,
    #[serde(default)]
    pub flow_control: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSpawnResponse {
    pub session_id: String,
    pub port_name: String,
}

#[tauri::command]
pub async fn serial_ports_list() -> Result<Vec<SerialPortInfo>> {
    SerialManager::list_ports()
}

#[tauri::command]
pub async fn serial_spawn(
    serial: State<'_, SerialManager>,
    request: SerialSpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<SerialSpawnResponse> {
    let port_name = request.path.clone();
    let config = SerialConfig {
        path: request.path,
        baud_rate: request.baud_rate,
        data_bits: request.data_bits.unwrap_or(DEFAULT_DATA_BITS),
        parity: request.parity.unwrap_or_else(|| DEFAULT_PARITY.into()),
        stop_bits: request.stop_bits.unwrap_or(DEFAULT_STOP_BITS),
        flow_control: request
            .flow_control
            .unwrap_or_else(|| DEFAULT_FLOW_CONTROL.into()),
    };

    let session_id = serial.open(
        config,
        move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes.to_vec()));
        },
        move |code| {
            let _ = on_exit.send(code);
        },
    )?;

    Ok(SerialSpawnResponse {
        session_id,
        port_name,
    })
}

#[tauri::command]
pub async fn serial_write(
    serial: State<'_, SerialManager>,
    session_id: String,
    data: String,
) -> Result<()> {
    serial.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub async fn serial_kill(serial: State<'_, SerialManager>, session_id: String) -> Result<()> {
    serial.kill(&session_id)
}
