export function extensionForImageMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function pastedImageFilename(mime: string, at: Date, index: number): string {
  const year = at.getFullYear();
  const month = pad2(at.getMonth() + 1);
  const day = pad2(at.getDate());
  const hour = pad2(at.getHours());
  const minute = pad2(at.getMinutes());
  const second = pad2(at.getSeconds());
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `pasted-${year}${month}${day}-${hour}${minute}${second}${suffix}.${extensionForImageMime(mime)}`;
}

export function pastedImagePath(targetDir: string, filename: string): string {
  const trimmedTargetDir = targetDir.replace(/^\/+|\/+$/g, "");
  return trimmedTargetDir ? `${trimmedTargetDir}/${filename}` : filename;
}

export function uniqueRepoPath(desired: string, existing: string[]): string {
  const used = new Set(existing);
  if (!used.has(desired)) return desired;

  const slashIdx = desired.lastIndexOf("/");
  const filenameStart = slashIdx >= 0 ? slashIdx + 1 : 0;
  const dotIdx = desired.lastIndexOf(".");
  const hasExtension = dotIdx > filenameStart;
  const base = hasExtension ? desired.slice(0, dotIdx) : desired;
  const ext = hasExtension ? desired.slice(dotIdx) : "";

  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}
