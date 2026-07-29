import { useState } from "react";
import { api, type TeamInfo } from "../lib/api";

/**
 * 團隊模式的「你是誰」下拉。選了誰，之後的讀寫就用那個人的 token，
 * commit 也記在那個人名下。
 *
 * ⚠️ 這不是登入：選名字只是宣稱身分，沒有任何驗證。要真驗證走個人 OAuth。
 */
export default function IdentityPicker({
  team,
  onChange,
  size = "sm",
}: {
  team: TeamInfo;
  onChange: () => void;
  size?: "sm" | "lg";
}) {
  const [busy, setBusy] = useState(false);

  async function pick(value: string) {
    setBusy(true);
    try {
      await api.selectIdentity(value === "" ? null : Number(value));
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const base =
    size === "lg"
      ? "rounded-lg bg-zinc-900 border px-4 py-2.5 text-base"
      : "rounded-lg bg-zinc-900 border px-3 py-1.5 text-sm";

  return (
    <select
      value={team.selected ? String(team.selected.index) : ""}
      disabled={busy}
      onChange={(e) => void pick(e.target.value)}
      title="選擇你是誰——之後的存檔會記在這個人名下"
      className={`${base} outline-none focus:border-sky-600 disabled:opacity-50 ${
        team.selected ? "border-zinc-700 text-zinc-200" : "border-sky-700 text-sky-300"
      }`}
    >
      <option value="">👤 你是誰？（選了才能編輯）</option>
      {team.members.map((m, i) => (
        <option key={`${m.name}-${i}`} value={i}>
          {m.name}
          {m.email ? ` — ${m.email}` : ""}
        </option>
      ))}
    </select>
  );
}
