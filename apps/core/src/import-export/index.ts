/**
 * WXR import and export (Tools → Import, Tools → Export): the public API.
 * See docs/architecture/import-export.md and ADR 0013.
 *
 * For scripts and the CLI:
 *
 *   await importWxr(kernel, { path: 'site.xml' }, { userId: 1, fetchAttachments: true });
 *   await exportWxr(kernel, { content: 'post' }, fs.createWriteStream('site.xml'));
 *
 * For other sources (a WordPress database, say): implement ImportSource and
 * call runImport(kernel, source, options).
 */

export {
  type ExportOptions,
  type ExportOutput,
  exportablePostTypes,
  exportFilename,
  exportWxr,
  generateWxr,
  WXR_VERSION,
} from './exporter';
export { isSerialized, maybeUnserialize, metaToWordPress, phpSerialize } from './php-serialize';
export type {
  ImportAuthor,
  ImportComment,
  ImportMeta,
  ImportPost,
  ImportPostTerm,
  ImportRecord,
  ImportSite,
  ImportSource,
  ImportTerm,
} from './records';
export {
  type FetchOptions,
  fetchRemoteFile,
  isPrivateAddress,
  RemoteFileError,
} from './remote-file';
export {
  IMPORT_JOB,
  type ImportWxrOptions,
  importWxr,
  registerImportJobs,
} from './service';
export {
  type AuthorChoice,
  ImportError,
  type ImportOptions,
  type ImportPostData,
  type ImportProgress,
  type ImportReport,
  ImportWriter,
  type ReportItem,
  runImport,
} from './writer';
export { scanWxr, type WxrInput, WxrReader, type WxrSummary } from './wxr-reader';
