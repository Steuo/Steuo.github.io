# Steno

IMG/PDF compressor. No backend.

## Img

- Live preview, no Compress btn.
- Quality: JPG/WEBP. Re-encode strips EXIF, applies rotation.
- Format: keep/JPG/WEBP/PNG/ICO. Alpha → white in JPG. GIF/AVIF/BMP/JXL → WEBP (or JPG).
- Resize: max side px, no upscale. >16 MP always downscaled.
- Target size: JPG/WEBP. Max quality that fits, then shrinks dims.
- Output > original: original returned, unless format/size changed.
- Animated: 1st frame only.

| In | Out |
|---|---|
| JPG, PNG, WebP | same |
| GIF, BMP, AVIF | WEBP/JPG |
| ICO | largest only, max 256 px |
| SVG | stays vector (metadata stripped) or rasterized; no `.svgz` |
| HEIC | JPG; native in Safari, else heic2any |
| RAW | largest embedded JPEG, JPG |
| JXL | if browser decodes, or set `window.StenoJxlDecode = async (buf) => ImageData` |

## PDF

- Smart (default): re-encodes DCT imgs in place (incl. Form XObjects), keeps `/SMask`. Text/vectors untouched.
  - Skipped: CMYK/Indexed/Separation, masks, `/Decode`, ICC, EXIF rot, non-8-bit, extra filters, no gain.
  - Fallback: object-stream cleanup → original. Never larger.
  - >16 MP always downscaled.
- Scanned: pdf.js → JPEG pages (~144 dpi), same page size, text lost. Original if larger.
- Encrypted: smart fails. Owner-pw only works in scanned; open-pw fails.

## Limits

- Smart mode: JPEG only (not Flate/JPX/CCITT).
- Not visited: annots, tiling patterns, Forms w/o own `/Resources`.
- No font subsetting.
- Large files may fail on mobile.

## License

MIT
