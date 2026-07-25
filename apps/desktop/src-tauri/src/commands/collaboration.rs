use serde::Deserialize;
use tauri::State;

use crate::collaboration::{
    self, AddRoomMemberInput, AddRoomMemberResponse, AuthPollResponse, AuthStartResponse,
    AuthStatusResponse, CollaborationConfig, CollaborationInvite, CollaborationResult,
    CollaborationRuntimeState, CreateInviteResponse, CreateRoomInput, CreateRoomResponse,
    DeviceIdentity, DevicesResponse, MintCapabilityResponse, ParseInviteInput, PutSnapshotInput,
    PutSnapshotResponse, RealtimeTicketResponse, RegisterDeviceInput, RoomDetailsResponse,
    RoomDeviceInput, RoomInput, RotateRoomKeyInput, SelfJoinResponse, SetDeviceIdentityInput,
    SetServerUrlInput, SnapshotResponse,
};
use crate::vault::VaultState;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MintRoomCapabilityInput {
    pub room_id: String,
    pub role: String,
    pub ttl_seconds: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinRoomWithCapabilityInput {
    pub room_id: String,
    pub secret: String,
    pub device_id: String,
    pub key_envelope: serde_json::Value,
}

#[tauri::command]
pub async fn collab_get_config(
    state: State<'_, AppState>,
) -> CollaborationResult<CollaborationConfig> {
    collaboration::get_config(&state.pool).await
}

#[tauri::command]
pub async fn collab_set_server_url(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    input: SetServerUrlInput,
) -> CollaborationResult<CollaborationConfig> {
    collaboration::set_server_url(&state.pool, &runtime, input).await
}

#[tauri::command]
pub async fn collab_auth_start(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
) -> CollaborationResult<AuthStartResponse> {
    collaboration::auth_start(&state.pool, &runtime).await
}

#[tauri::command]
pub async fn collab_auth_poll(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<AuthPollResponse> {
    collaboration::auth_poll(&state.pool, &runtime, &vault_state).await
}

#[tauri::command]
pub async fn collab_auth_status(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<AuthStatusResponse> {
    collaboration::auth_status(&state.pool, &runtime, &vault_state).await
}

#[tauri::command]
pub async fn collab_auth_sign_out(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<()> {
    collaboration::auth_sign_out(&state.pool, &runtime, &vault_state).await
}

#[tauri::command]
pub async fn collab_get_device_identity(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<Option<DeviceIdentity>> {
    collaboration::get_device_identity(&state.pool, &vault_state).await
}

#[tauri::command]
pub async fn collab_set_device_identity(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    input: SetDeviceIdentityInput,
) -> CollaborationResult<()> {
    collaboration::set_device_identity(&state.pool, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_register_device(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: RegisterDeviceInput,
) -> CollaborationResult<()> {
    collaboration::register_device(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_list_devices(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<DevicesResponse> {
    collaboration::list_devices(&state.pool, &runtime, &vault_state).await
}

#[tauri::command]
pub async fn collab_create_room(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: CreateRoomInput,
) -> CollaborationResult<CreateRoomResponse> {
    collaboration::create_room(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_add_room_member(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: AddRoomMemberInput,
) -> CollaborationResult<AddRoomMemberResponse> {
    collaboration::add_room_member(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_mint_room_capability(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: MintRoomCapabilityInput,
) -> CollaborationResult<MintCapabilityResponse> {
    collaboration::mint_room_capability(
        &state.pool,
        &runtime,
        &vault_state,
        &input.room_id,
        &input.role,
        input.ttl_seconds,
    )
    .await
}

#[tauri::command]
pub async fn collab_join_room_with_capability(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: JoinRoomWithCapabilityInput,
) -> CollaborationResult<SelfJoinResponse> {
    collaboration::join_room_with_capability(
        &state.pool,
        &runtime,
        &vault_state,
        &input.room_id,
        &input.secret,
        &input.device_id,
        input.key_envelope,
    )
    .await
}

#[tauri::command]
pub async fn collab_get_room(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: RoomDeviceInput,
) -> CollaborationResult<RoomDetailsResponse> {
    collaboration::get_room(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_issue_realtime_ticket(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: RoomDeviceInput,
) -> CollaborationResult<RealtimeTicketResponse> {
    collaboration::issue_realtime_ticket(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_rotate_room_key(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: RotateRoomKeyInput,
) -> CollaborationResult<()> {
    collaboration::rotate_room_key(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_get_snapshot(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: RoomInput,
) -> CollaborationResult<SnapshotResponse> {
    collaboration::get_snapshot(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_put_snapshot(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
    input: PutSnapshotInput,
) -> CollaborationResult<PutSnapshotResponse> {
    collaboration::put_snapshot(&state.pool, &runtime, &vault_state, input).await
}

#[tauri::command]
pub async fn collab_create_invite(
    state: State<'_, AppState>,
    runtime: State<'_, CollaborationRuntimeState>,
    vault_state: State<'_, VaultState>,
) -> CollaborationResult<CreateInviteResponse> {
    collaboration::create_invite(&state.pool, &runtime, &vault_state).await
}

#[tauri::command]
pub fn collab_parse_invite(input: ParseInviteInput) -> CollaborationResult<CollaborationInvite> {
    collaboration::parse_invite(input)
}
