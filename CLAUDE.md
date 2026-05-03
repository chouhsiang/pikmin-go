# 皮皮探險器 — 開發備注

## 圖片處理

`postcard/` 目錄下新增的圖片（PNG / JPEG），在放到網站前必須先轉成 WebP：

```bash
cwebp postcard/檔名.jpeg -o postcard/檔名.webp
```

批次轉換：

```bash
for f in postcard/*.png postcard/*.jpeg postcard/*.jpg; do
  [ -f "$f" ] || continue
  cwebp "$f" -o "${f%.*}.webp"
done
```

轉換完成後保留原檔或刪除原檔均可，網站引用請使用 `.webp` 版本。
