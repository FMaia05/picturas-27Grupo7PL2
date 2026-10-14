"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import {
  cancelVideoUpload,
  completeVideoUpload,
  getVideo,
  startVideoUpload,
  uploadVideoPart,
  videoErrorMessage,
} from "@/lib/videos";
import { useSession } from "@/providers/session-provider";
import axios from "axios";
import { X } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState } from "react";

type UploadStatus =
  "queued" | "uploading" | "processing" | "ready" | "failed" | "cancelled";

interface UploadItem {
  localId: string;
  videoId?: string;
  file: File;
  status: UploadStatus;
  uploaded: number;
  rate: number;
  eta: number;
  error?: string;
}

interface VideoUploadContextValue {
  uploads: UploadItem[];
  addFiles: (files: File[]) => void;
  cancel: (localId: string) => void;
}

const VideoUploadContext = createContext<VideoUploadContextValue | undefined>(
  undefined,
);
const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function VideoUploadProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = useSession();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const cancelled = useRef(new Set<string>());
  const queue = useRef(Promise.resolve());

  const update = (localId: string, values: Partial<UploadItem>) =>
    setUploads((current) =>
      current.map((item) =>
        item.localId === localId ? { ...item, ...values } : item,
      ),
    );

  async function pollUntilFinished(localId: string, videoId: string) {
    for (;;) {
      if (cancelled.current.has(localId)) return;
      const video = await getVideo(session.user._id, session.token, videoId);
      if (video.status === "ready") {
        update(localId, {
          status: "ready",
          uploaded: video.size,
          rate: 0,
          eta: 0,
        });
        window.dispatchEvent(new Event("video-library-updated"));
        toast({
          title: "Video uploaded",
          description: `${video.originalName} is ready in your library.`,
        });
        return;
      }
      if (video.status === "failed")
        throw new Error(video.error || "The video is invalid.");
      await wait(1500);
    }
  }

  async function run(item: UploadItem) {
    const { localId, file } = item;
    const controller = new AbortController();
    controllers.current.set(localId, controller);
    let videoId: string | undefined;
    try {
      const upload = await startVideoUpload(
        session.user._id,
        session.token,
        file,
      );
      videoId = upload.videoId;
      update(localId, { videoId, status: "uploading" });
      const parts: { PartNumber: number; ETag: string }[] = [];
      let confirmed = 0;
      const startedAt = Date.now();

      for (
        let offset = 0, partNumber = 1;
        offset < file.size;
        offset += upload.partSize, partNumber++
      ) {
        const chunk = file.slice(
          offset,
          Math.min(offset + upload.partSize, file.size),
        );
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (controller.signal.aborted)
            throw new DOMException("Cancelled", "AbortError");
          try {
            const part = await uploadVideoPart(
              session.user._id,
              session.token,
              upload,
              partNumber,
              chunk,
              controller.signal,
              (loaded) => {
                const uploaded = confirmed + loaded;
                const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.1);
                const rate = uploaded / elapsed;
                update(localId, {
                  uploaded,
                  rate,
                  eta: rate ? (file.size - uploaded) / rate : 0,
                });
              },
            );
            parts.push(part);
            confirmed += chunk.size;
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (axios.isCancel(error) || controller.signal.aborted) throw error;
            await wait(1000 * 2 ** attempt);
          }
        }
        if (lastError) throw lastError;
      }

      await completeVideoUpload(session.user._id, session.token, upload, parts);
      update(localId, {
        status: "processing",
        uploaded: file.size,
        rate: 0,
        eta: 0,
      });
      await pollUntilFinished(localId, upload.videoId);
    } catch (error) {
      if (cancelled.current.has(localId) || axios.isCancel(error)) {
        if (videoId)
          await cancelVideoUpload(
            session.user._id,
            session.token,
            videoId,
          ).catch(() => {});
        return;
      }
      if (videoId)
        await cancelVideoUpload(session.user._id, session.token, videoId).catch(
          () => {},
        );
      const message = videoErrorMessage(error);
      update(localId, { status: "failed", error: message, rate: 0, eta: 0 });
      toast({
        title: "Video upload failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      controllers.current.delete(localId);
    }
  }

  function addFiles(files: File[]) {
    if (files.length > 5) {
      toast({
        title: "Too many videos",
        description: "Select at most 5 videos per batch.",
        variant: "destructive",
      });
      return;
    }
    const maxSize =
      session.user.type === "premium" ? 2000 * 1024 * 1024 : 200 * 1024 * 1024;
    const invalid = files.find((file) => {
      const extension = file.name.split(".").pop()?.toLowerCase() || "";
      return MIME_BY_EXTENSION[extension] !== file.type || file.size > maxSize;
    });
    if (invalid) {
      toast({
        title: "Unsupported video",
        description:
          "The file is unsupported or exceeds your plan's size limit.",
        variant: "destructive",
      });
      return;
    }
    const added = files.map((file) => ({
      localId: crypto.randomUUID(),
      file,
      status: "queued" as const,
      uploaded: 0,
      rate: 0,
      eta: 0,
    }));
    setUploads((current) => [
      ...current.filter((item) => item.status !== "cancelled"),
      ...added,
    ]);
    for (const item of added)
      queue.current = queue.current.then(() => run(item));
  }

  async function cancel(localId: string) {
    cancelled.current.add(localId);
    controllers.current.get(localId)?.abort();
    const item = uploads.find((upload) => upload.localId === localId);
    update(localId, { status: "cancelled", rate: 0, eta: 0 });
    if (item?.videoId)
      await cancelVideoUpload(
        session.user._id,
        session.token,
        item.videoId,
      ).catch(() => {});
  }

  const active = uploads.filter(
    (item) => !["ready", "cancelled"].includes(item.status),
  );
  const totalBytes = active.reduce((total, item) => total + item.file.size, 0);
  const totalUploaded = active.reduce(
    (total, item) => total + item.uploaded,
    0,
  );
  const overallPercent = totalBytes
    ? Math.round((totalUploaded / totalBytes) * 100)
    : 0;
  const value = useMemo(() => ({ uploads, addFiles, cancel }), [uploads]);

  return (
    <VideoUploadContext.Provider value={value}>
      {children}
      {active.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-xl border bg-background p-4 shadow-xl">
          <div className="mb-3 space-y-1">
            <div className="flex justify-between font-semibold">
              <p>Video uploads</p>
              <span>{overallPercent}% total</span>
            </div>
            <Progress value={overallPercent} />
          </div>
          <div className="space-y-4">
            {active.map((item) => {
              const percent = Math.round(
                (item.uploaded / item.file.size) * 100,
              );
              return (
                <div key={item.localId} className="space-y-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {item.file.name}
                    </span>
                    <span>
                      {item.status === "processing"
                        ? "Inspecting…"
                        : `${percent}%`}
                    </span>
                    {item.status !== "ready" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => cancel(item.localId)}
                        aria-label="Cancel upload"
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                  <Progress value={percent} />
                  {item.status === "uploading" && (
                    <p className="text-xs text-muted-foreground">
                      {(item.rate / 1024 / 1024).toFixed(1)} MB/s ·{" "}
                      {Math.ceil(item.eta)}s remaining
                    </p>
                  )}
                  {item.error && (
                    <p className="text-xs text-destructive">{item.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </VideoUploadContext.Provider>
  );
}

export function useVideoUploads() {
  const context = useContext(VideoUploadContext);
  if (!context)
    throw new Error("useVideoUploads must be used inside VideoUploadProvider");
  return context;
}
