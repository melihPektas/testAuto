import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface VisualComparison {
  /** Fraction of pixels that differ, 0..1. */
  readonly ratio: number;
  readonly diffPixels: number;
  readonly totalPixels: number;
  readonly width: number;
  readonly height: number;
  /** The two images were different sizes and could not be compared pixel-wise. */
  readonly sizeMismatch: boolean;
  /** A PNG highlighting the differing pixels, when the sizes matched. */
  readonly diff: Buffer | undefined;
}

export interface CompareOptions {
  /**
   * Per-pixel colour tolerance, 0..1 (pixelmatch's `threshold`). Higher ignores
   * more antialiasing and subpixel noise. 0.1 is a sane default for real pages.
   */
  readonly pixelThreshold?: number;
}

/**
 * Compare a screenshot against a baseline, pixel by pixel. A size mismatch is
 * reported rather than guessed at — a page that changed dimensions did not
 * "differ by N%", it became a different shape, and saying so is more useful
 * than a meaningless number.
 *
 * @public
 */
export function compareScreenshots(
  current: Buffer,
  baseline: Buffer,
  options: CompareOptions = {},
): VisualComparison {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);

  if (a.width !== b.width || a.height !== b.height) {
    return {
      ratio: 1,
      diffPixels: 0,
      totalPixels: 0,
      width: b.width,
      height: b.height,
      sizeMismatch: true,
      diff: undefined,
    };
  }

  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: options.pixelThreshold ?? 0.1,
  });
  const totalPixels = a.width * a.height;

  return {
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    diffPixels,
    totalPixels,
    width: a.width,
    height: a.height,
    sizeMismatch: false,
    diff: PNG.sync.write(diff),
  };
}
