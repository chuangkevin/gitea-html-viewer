/**
 * 「在文件裡拖動既有圖片」用的 dataTransfer type。
 *
 * 刻意獨立成一個沒有任何相依的小模組：Workspace 與 CodeMirror 的圖片 widget
 * 都要用它，但 Workspace 不可以因此把整包 CodeMirror 拉進主 bundle
 * （編輯器是 lazy-load 的獨立 chunk）。
 */
export const IMAGE_MOVE_MIME = "application/x-note-img-move";
