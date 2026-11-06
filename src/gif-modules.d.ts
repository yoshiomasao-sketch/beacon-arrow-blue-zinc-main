declare module "gifenc/dist/gifenc.esm.js" {
  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; repeat?: number; dispose?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array, maxColors: number): number[][];
  export function applyPalette(rgba: Uint8Array, palette: number[][]): Uint8Array;
}

declare module "jpeg-js" {
  const jpeg: {
    decode(
      jpegData: Uint8Array | Buffer,
      opts?: { useTArray?: boolean; formatAsRGBA?: boolean },
    ): { data: Uint8Array; width: number; height: number };
  };
  export default jpeg;
}

declare module "pngjs" {
  const png: {
    PNG: {
      sync: {
        read(buffer: Buffer): { data: Buffer; width: number; height: number };
      };
    };
  };
  export default png;
}
