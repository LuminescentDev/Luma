export async function getVersion(): Promise<string> {
  return "0.8.0";
}
export async function getName(): Promise<string> {
  return "Luma";
}
export async function getTauriVersion(): Promise<string> {
  return "2.0.0";
}

export async function openUrl(_url?: string): Promise<void> {}
export async function openPath(_path?: string): Promise<void> {}
export async function revealItemInDir(_path?: string): Promise<void> {}

export async function open(): Promise<string | string[] | null> {
  return null;
}
export async function save(): Promise<string | null> {
  return null;
}
export async function ask(): Promise<boolean> {
  return false;
}
export async function confirm(): Promise<boolean> {
  return false;
}
export async function message(): Promise<void> {}

export async function relaunch(): Promise<void> {}
export async function exit(_code?: number): Promise<void> {}

export async function check(): Promise<null> {
  return null;
}
