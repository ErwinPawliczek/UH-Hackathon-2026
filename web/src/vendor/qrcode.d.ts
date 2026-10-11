// Types for the part of the vendored QR generator this app uses.
export interface QrCode {
  addData(data: string, mode?: 'Byte' | 'Numeric' | 'Alphanumeric'): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
/** `typeNumber` 0 picks the smallest size that fits. */
declare const qrcode: (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QrCode;
export default qrcode;
