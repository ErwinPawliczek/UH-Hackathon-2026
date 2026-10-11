// A QR code as crisp SVG, made in the page (vendor/qrcode.js): dark modules
// on white with the four-module quiet zone scanners expect.

import { useMemo } from 'react';
import qrcode from '../vendor/qrcode';

/** The dark modules of the QR code for `text`, as rows of booleans. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

export function Qr({ text, size, testId }: { text: string; size: number; testId?: string }) {
  const path = useMemo(() => {
    const m = qrMatrix(text);
    let d = '';
    m.forEach((row, r) => row.forEach((dark, c) => { if (dark) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
    return { d, n: m.length + 8 };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${text}`} data-testid={testId}>
      <rect width={path.n} height={path.n} fill="#ffffff" />
      <path d={path.d} fill="#0a0a0a" />
    </svg>
  );
}
