# Approved QR page — preserve unchanged

Erwin approved the current QR page. Do not redesign, restyle, replace its assets, or alter its layout unless he explicitly requests a QR-page change. Work on the main page must not change this page.

## Keep intact
- `/qr` shows two scannable codes: Demo → https://demo.petrogrid.xyz and Main Page → https://petrogrid.xyz.
- Titles appear above their respective codes. There is no grey domain explanation below them.
- Outlines trace the existing hexagonal grid edges; interiors gently tone down the grid, not large rectangular white backgrounds.
- Codes sit side by side on larger screens and stack on phones.
- Preserve the supplied SVG assets and their scan-safe quiet zones.
- Preserve the native-scrolling grid and the transparent PetroGrid brand.

## Files to protect
`src/routes/qr.tsx`, `src/components/hex-qr.tsx`, `public/qr/ezqr-demo.svg`, and `public/qr/ezqr-main.svg`, plus their QR-specific rules in `src/styles.css` and the `qr` branch in the shared `HexScroll` scene.

Shared-file changes for another page must leave QR output unchanged. If a QR change is explicitly requested, verify both destination URLs by scanning the rendered codes on phone and desktop.