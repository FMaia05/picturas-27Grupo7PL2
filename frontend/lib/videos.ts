import axios from "axios";
import { api } from "./axios";

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  fps: number;
  rotation: number;
}

export interface LibraryVideo {
  _id: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: "uploading" | "processing" | "ready" | "failed";
  metadata?: VideoMetadata;
  error?: string;
  url?: string;
  createdAt: string;
}

export interface TrimVideoPayload {
  start: number;
  end: number;
  targetName?: string;
  replaceOriginal?: boolean;
}

export interface ExtractFramesPayload {
  start: number;
  end: number;
  step: number;
  format: "png" | "jpeg";
  destinationType: "new" | "existing";
  targetName?: string;
  destinationProjectId?: string;
}

export interface VideoTask {
  _id: string;
  type: "trim" | "extract_frames";
  sourceVideoId: string;
  targetName: string;
  replaceOriginal?: boolean;
  start: number;
  end: number;
  duration: number;
  step?: number;
  format?: "png" | "jpeg";
  destinationType?: "new" | "existing";
  destinationProjectId?: string;
  totalFramesCount?: number;
  extractedFramesCount?: number;
  resultProjectId?: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  resultVideoId?: string;
  error?: string;
  createdAt: string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function startVideoUpload(
  userId: string,
  token: string,
  file: File,
) {
  const response = await api.post(
    `/videos/${userId}/uploads`,
    { name: file.name, size: file.size, mimeType: file.type },
    { headers: auth(token) },
  );
  return response.data as {
    videoId: string;
    uploadId: string;
    partSize: number;
  };
}

export async function uploadVideoPart(
  userId: string,
  token: string,
  session: { videoId: string; uploadId: string },
  partNumber: number,
  chunk: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
) {
  const response = await api.put(
    `/videos/${userId}/uploads/${session.videoId}/parts/${partNumber}`,
    chunk,
    {
      params: { uploadId: session.uploadId },
      headers: { ...auth(token), "Content-Type": "application/octet-stream" },
      signal,
      onUploadProgress: (event) => onProgress(event.loaded),
    },
  );
  return { PartNumber: partNumber, ETag: response.data.etag };
}

export async function completeVideoUpload(
  userId: string,
  token: string,
  session: { videoId: string; uploadId: string },
  parts: { PartNumber: number; ETag: string }[],
) {
  await api.post(
    `/videos/${userId}/uploads/${session.videoId}/complete`,
    { uploadId: session.uploadId, parts },
    { headers: auth(token) },
  );
}

export async function cancelVideoUpload(
  userId: string,
  token: string,
  videoId: string,
) {
  await api.delete(`/videos/${userId}/uploads/${videoId}`, {
    headers: auth(token),
  });
}

export async function getVideo(userId: string, token: string, videoId: string) {
  const response = await api.get<LibraryVideo>(`/videos/${userId}/${videoId}`, {
    headers: auth(token),
  });
  return response.data;
}

export async function getVideos(userId: string, token: string) {
  const response = await api.get<LibraryVideo[]>(`/videos/${userId}`, {
    headers: auth(token),
  });
  return response.data;
}

export async function deleteVideo(
  userId: string,
  token: string,
  videoId: string,
) {
  await api.delete(`/videos/${userId}/${videoId}`, { headers: auth(token) });
}

export async function requestVideoTrim(
  userId: string,
  token: string,
  videoId: string,
  payload: TrimVideoPayload,
) {
  const response = await api.post<{ taskId: string; status: string }>(
    `/videos/${userId}/${videoId}/trim`,
    payload,
    { headers: auth(token) },
  );
  return response.data;
}

export async function requestFrameExtraction(
  userId: string,
  token: string,
  videoId: string,
  payload: ExtractFramesPayload,
) {
  const response = await api.post<{ taskId: string; status: string }>(
    `/videos/${userId}/${videoId}/extract-frames`,
    payload,
    { headers: auth(token) },
  );
  return response.data;
}

export async function getVideoTask(
  userId: string,
  token: string,
  taskId: string,
) {
  const response = await api.get<VideoTask>(
    `/videos/${userId}/tasks/${taskId}`,
    { headers: auth(token) },
  );
  return response.data;
}

export async function getVideoTasks(userId: string, token: string) {
  const response = await api.get<VideoTask[]>(`/videos/${userId}/tasks`, {
    headers: auth(token),
  });
  return response.data;
}

export async function cancelVideoTask(
  userId: string,
  token: string,
  taskId: string,
) {
  const response = await api.post<{ message: string }>(
    `/videos/${userId}/tasks/${taskId}/cancel`,
    {},
    { headers: auth(token) },
  );
  return response.data;
}

export function videoErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.error || error.message;
  }
  return error instanceof Error ? error.message : "Video upload failed.";
}
