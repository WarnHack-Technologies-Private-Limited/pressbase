/**
 * Stands in for `@wordpress/vips/worker` (aliased in next.config.ts).
 *
 * The real module is a ~22 MB WebAssembly image processor that
 * @wordpress/upload-media loads only for client-side media processing
 * (`window.__clientSideMediaProcessing`), which Pressbase doesn't turn on:
 * uploads are processed by the server. Aliasing it keeps that weight out of
 * the build. These functions are never reached; if they were, they say why.
 */

const off = (): never => {
  throw new Error('Client-side media processing is turned off in Pressbase.');
};

export const vipsCompressImage = off;
export const vipsConvertImageFormat = off;
export const vipsGetUltraHdrInfo = off;
export const vipsHasTransparency = off;
export const vipsResizeImage = off;
export const vipsRotateImage = off;
export const vipsCancelOperations = () => false;
export const terminateVipsWorker = () => {};
