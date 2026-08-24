import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { uploadUiFile } from "../api/client";

export type PendingRunAttachment = {
  key: string;
  file: File;
  status: "ready" | "uploading" | "uploaded" | "error";
  uploadId?: string;
  error?: string;
};

type RandomUuidSource = { randomUUID?: () => string };

export function createUploadRequestId(
  source: RandomUuidSource | null | undefined = globalThis.crypto,
): string | undefined {
  try {
    return source?.randomUUID?.();
  } catch {
    return undefined;
  }
}

export function attachmentKey(file: Pick<File, "name" | "size" | "lastModified">): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function mergeAttachmentFiles(current: PendingRunAttachment[], incoming: File[]): PendingRunAttachment[] {
  const seen = new Set(current.map((item) => item.key));
  const next = [...current];
  for (const file of incoming) {
    const key = attachmentKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ key, file, status: "ready" });
  }
  return next;
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`;
}

export function useRunAttachments() {
  const [attachments, setAttachments] = useState<PendingRunAttachment[]>([]);
  const [requestId, setRequestId] = useState<string | undefined>(() => createUploadRequestId());
  const requestIdRef = useRef(requestId);
  const lastSubmittedDraftRef = useRef<string | undefined>(undefined);
  const uploading = attachments.some((item) => item.status === "uploading");

  const addFiles = (files: File[]) => setAttachments((current) => mergeAttachmentFiles(current, files));
  const removeFile = (key: string) => setAttachments((current) => current.filter((item) => item.key !== key));
  const clearFiles = () => {
    setAttachments([]);
    const nextRequestId = createUploadRequestId();
    requestIdRef.current = nextRequestId;
    lastSubmittedDraftRef.current = undefined;
    setRequestId(nextRequestId);
  };

  const uploadFiles = async (draftIdentity: string): Promise<Readonly<{ requestId?: string; attachmentIds: string[] }>> => {
    const exactDraftIdentity = JSON.stringify([draftIdentity, attachments.map((item) => item.key)]);
    let selected = [...attachments];
    let activeRequestId = requestIdRef.current;
    if (lastSubmittedDraftRef.current !== undefined && lastSubmittedDraftRef.current !== exactDraftIdentity) {
      activeRequestId = createUploadRequestId();
      requestIdRef.current = activeRequestId;
      setRequestId(activeRequestId);
      selected = selected.map((item) => ({ ...item, status: "ready", uploadId: undefined, error: undefined }));
      setAttachments(selected);
    }
    lastSubmittedDraftRef.current = exactDraftIdentity;
    if (attachments.length > 0 && !activeRequestId) {
      throw new Error("이 브라우저에서는 안전한 파일 업로드 요청 ID를 만들 수 없습니다.");
    }
    const uploadIds: string[] = [];
    for (const item of selected) {
      if (item.status === "uploaded" && item.uploadId) {
        uploadIds.push(item.uploadId);
        continue;
      }
      setAttachments((current) => current.map((entry) => entry.key === item.key
        ? { ...entry, status: "uploading", error: undefined }
        : entry));
      try {
        const uploaded = await uploadUiFile(activeRequestId!, item.file);
        uploadIds.push(uploaded.uploadId);
        setAttachments((current) => current.map((entry) => entry.key === item.key
          ? { ...entry, status: "uploaded", uploadId: uploaded.uploadId, error: undefined }
          : entry));
      } catch (error) {
        const message = error instanceof Error ? error.message : "파일을 업로드할 수 없습니다.";
        setAttachments((current) => current.map((entry) => entry.key === item.key
          ? { ...entry, status: "error", error: message }
          : entry));
        throw new Error(`${item.file.name}: ${message}`);
      }
    }
    return { ...(activeRequestId ? { requestId: activeRequestId } : {}), attachmentIds: uploadIds };
  };

  return { attachments, uploading, requestId, addFiles, removeFile, clearFiles, uploadFiles };
}

interface RunAttachmentPickerProps {
  attachments: PendingRunAttachment[];
  disabled?: boolean;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
  compact?: boolean;
}

export function RunAttachmentPicker({
  attachments,
  disabled = false,
  onAddFiles,
  onRemoveFile,
  compact = false,
}: RunAttachmentPickerProps) {
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    onAddFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  };
  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    onAddFiles(Array.from(event.dataTransfer.files));
  };

  return <div
    className={`run-attachments ${compact ? "is-compact" : ""}`}
    onDragOver={(event) => event.preventDefault()}
    onDrop={dropFiles}
    aria-label="실행 첨부 파일"
  >
    <label className="attachment-picker">
      <span aria-hidden="true">＋</span>
      <span>{compact ? "파일" : "파일 선택 또는 끌어놓기"}</span>
      <input type="file" multiple disabled={disabled} onChange={selectFiles} aria-label="실행에 첨부할 파일 선택" />
    </label>
    {attachments.length > 0 && <div className="attachment-list" aria-live="polite">
      {attachments.map((item) => <span className={`attachment-chip is-${item.status}`} key={item.key} title={item.error}>
        <span><b>{item.file.name}</b><small>{item.status === "uploading" ? "업로드 중" : item.status === "uploaded" ? "준비 완료" : item.status === "error" ? item.error : formatAttachmentSize(item.file.size)}</small></span>
        <button type="button" onClick={() => onRemoveFile(item.key)} disabled={disabled || item.status === "uploading"} aria-label={`${item.file.name} 첨부 삭제`}>×</button>
      </span>)}
    </div>}
  </div>;
}
