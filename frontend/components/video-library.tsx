"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { deleteVideo, getVideos, LibraryVideo } from "@/lib/videos";
import { useSession } from "@/providers/session-provider";
import { useVideoUploads } from "@/providers/video-upload-provider";
import { Film, Scissors, Trash2, Upload, Camera, Repeat2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import TrimVideoDialog from "@/components/trim-video-dialog";
import ExtractFramesDialog from "@/components/extract-frames-dialog";

import ConvertVideoDialog from "@/components/convert-video-dialog";
import VideoConversionTasks from "@/components/video-conversion-tasks";

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

export default function VideoLibrary() {
  const session = useSession();
  const { addFiles } = useVideoUploads();
  const input = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selectedVideoForTrim, setSelectedVideoForTrim] = useState<LibraryVideo | null>(null);
  const [selectedVideoForExtract, setSelectedVideoForExtract] = useState<LibraryVideo | null>(null);

  const [conversionVideo, setConversionVideo] = useState<LibraryVideo | null>(null);

  const refresh = useCallback(() => {
    getVideos(session.user._id, session.token)
      .then(setVideos)
      .catch(() => {
        toast({
          title: "Unable to load video library",
          variant: "destructive",
        });
      });
  }, [session.token, session.user._id]);

  useEffect(() => {
    refresh();
    window.addEventListener("video-library-updated", refresh);
    return () => window.removeEventListener("video-library-updated", refresh);
  }, [refresh]);

  async function remove(video: LibraryVideo) {
    await deleteVideo(session.user._id, session.token, video._id);
    refresh();
  }

  function handleExtractClick(video: LibraryVideo) {
    // REQ-VID-FRAME-015 / Exceção 1: Formatos aceites MP4 (H.264) e MOV
    const ext = "." + (video.originalName.split(".").pop() || "").toLowerCase();
    const isSupportedExt = ext === ".mp4" || ext === ".mov";
    const codec = video.metadata?.videoCodec?.toLowerCase();
    const isSupportedCodec = !codec || codec === "h264" || codec === "avc1";

    if (!isSupportedExt || !isSupportedCodec) {
      toast({
        title: "Formato de vídeo não suportado",
        description: "Formato de vídeo não suportado. Formatos aceites: MP4 (H.264) e MOV.",
        variant: "destructive",
      });
      return;
    }

    setSelectedVideoForExtract(video);
  }

  return (
    <section id="video-library-section" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Video library</h2>
          <p className="text-sm text-muted-foreground">
            MP4/MOV (H.264/AAC) or WebM (VP9/Opus), up to 5 at a time.
          </p>
        </div>
        <Button onClick={() => input.current?.click()}>
          <Upload className="mr-2 size-4" />
          Upload video
        </Button>
        <input
          ref={input}
          className="hidden"
          type="file"
          multiple
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          onChange={(event) => {
            addFiles(Array.from(event.target.files || []));
            event.target.value = "";
          }}
        />
      </div>
      <div
        className={`rounded-xl border-2 border-dashed p-4 transition-colors ${dragging ? "border-primary bg-primary/10" : "border-muted"}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {videos.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
            <Film />
            Drop videos here to build your library
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {videos.map((video) => (
              <Card key={video._id}>
                <CardContent className="flex items-center gap-3 p-3">
                  <Film className="size-9 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <a
                      href={video.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-medium hover:underline"
                    >
                      {video.originalName}
                    </a>
                    {video.metadata && (
                      <p className="text-xs text-muted-foreground">
                        {video.metadata.width}×{video.metadata.height} ·{" "}
                        {formatDuration(video.metadata.duration)} ·{" "}
                        {video.metadata.fps.toFixed(2)} fps
                      </p>
                    )}
                  </div>
                  {session.user.type !== "anonymous" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleExtractClick(video)}
                      aria-label={`Extrair fotogramas de ${video.originalName}`}
                      title="Extrair fotogramas"
                    >
                      <Camera className="size-4 text-primary" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setSelectedVideoForTrim(video)}
                    aria-label={`Recortar ${video.originalName}`}
                    title="Recortar vídeo"
                  >
                    <Scissors className="size-4 text-primary" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setConversionVideo(video)}
                    disabled={session.user.type === "anonymous"} aria-label={`Converter vídeo ${video.originalName}`} title="Converter vídeo">
                    <Repeat2 className="size-4 text-primary" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(video)}
                    aria-label={`Delete ${video.originalName}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <ConvertVideoDialog video={conversionVideo} onClose={() => setConversionVideo(null)} />
      {session.user.type !== "anonymous" && <VideoConversionTasks />}

      <TrimVideoDialog
        video={selectedVideoForTrim}
        isOpen={Boolean(selectedVideoForTrim)}
        onClose={() => setSelectedVideoForTrim(null)}
      />

      <ExtractFramesDialog
        video={selectedVideoForExtract}
        isOpen={Boolean(selectedVideoForExtract)}
        onClose={() => setSelectedVideoForExtract(null)}
      />
    </section>
  );
}
