export function readonlyLabel({ mirror, needsIdentity }: { mirror: boolean; needsIdentity: boolean }): string {
  if (mirror) return "此為鏡像repo，無法編輯";
  return needsIdentity ? "唯讀 · 先選身分" : "唯讀";
}
