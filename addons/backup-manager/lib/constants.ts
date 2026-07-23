/** Must match the folder name. Changing it later orphans the module's data. */
export const MODULE_ID = "backup-manager";
export const MODULE_PATH = `/m/${MODULE_ID}`;
export const ADMIN_PATH = `/admin/modules/${MODULE_ID}`;

/** Bytes → something a person reads. */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Minutes past midnight → "02:00". */
export function formatTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
