export interface UploadedFile { readonly attachmentId: string; readonly name: string; readonly bytes: number }
export type NativeUpload = UploadedFile
  | { readonly type: 'file'; readonly attachment: UploadedFile }
  | { readonly type: 'image'; readonly attachment: unknown }

/** Resolve the file face of the supported legacy and tagged native upload receipts. */
export function uploadedFile(upload: NativeUpload | undefined): UploadedFile | undefined {
  if (!upload) return undefined
  return 'type' in upload ? upload.type === 'file' ? upload.attachment : undefined : upload
}
