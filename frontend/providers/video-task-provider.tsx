"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import {
  cancelVideoTask,
  getVideoTask,
  requestVideoTrim,
  TrimVideoPayload,
  videoErrorMessage,
  VideoTask,
} from "@/lib/videos";
import { useSession } from "@/providers/session-provider";
import { Scissors, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

interface VideoTaskContextValue {
  activeTasks: VideoTask[];
  startTrim: (videoId: string, payload: TrimVideoPayload) => Promise<string>;
  cancelTask: (taskId: string) => Promise<void>;
}

const VideoTaskContext = createContext<VideoTaskContextValue | undefined>(undefined);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function VideoTaskProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const [tasks, setTasks] = useState<VideoTask[]>([]);
  const cancelledTasks = useRef(new Set<string>());

  const updateTask = (taskId: string, values: Partial<VideoTask>) => {
    setTasks((current) =>
      current.map((task) => (task._id === taskId ? { ...task, ...values } : task)),
    );
  };

  async function pollTask(taskId: string) {
    for (;;) {
      if (cancelledTasks.current.has(taskId)) return;
      try {
        const task = await getVideoTask(session.user._id, session.token, taskId);
        updateTask(taskId, task);

        if (task.status === "completed") {
          window.dispatchEvent(new Event("video-library-updated"));
          toast({
            title: "Recorte concluído com sucesso!",
            description: `O vídeo "${task.targetName}" já está disponível na sua biblioteca.`,
            action: (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.dispatchEvent(new Event("video-library-updated"));
                  const el = document.getElementById("video-library-section");
                  el?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Ver na biblioteca
              </Button>
            ),
          });
          return;
        }

        if (task.status === "cancelled") {
          toast({
            title: "Recorte cancelado",
            description: "Recorte cancelado. Nenhuma operação foi contabilizada.",
          });
          return;
        }

        if (task.status === "failed") {
          toast({
            title: "Falha no processamento",
            description:
              task.error ||
              "Ocorreu um erro ao processar o seu vídeo. Nenhuma operação foi contabilizada.",
            variant: "destructive",
          });
          return;
        }

        await wait(1500);
      } catch (err) {
        console.error("Error polling video task:", err);
        await wait(3000);
      }
    }
  }

  async function startTrim(videoId: string, payload: TrimVideoPayload) {
    try {
      const response = await requestVideoTrim(
        session.user._id,
        session.token,
        videoId,
        payload,
      );

      const newTask: VideoTask = {
        _id: response.taskId,
        type: "trim",
        sourceVideoId: videoId,
        targetName: payload.targetName || "Vídeo recortado",
        replaceOriginal: Boolean(payload.replaceOriginal),
        start: payload.start,
        end: payload.end,
        duration: payload.end - payload.start,
        status: "queued",
        progress: 5,
        createdAt: new Date().toISOString(),
      };

      setTasks((prev) => [...prev.filter((t) => t._id !== response.taskId), newTask]);

      toast({
        title: "Tarefa de recorte iniciada",
        description: `O recorte de "${newTask.targetName}" foi colocado em fila de processamento.`,
      });

      // Start asynchronous polling in background
      pollTask(response.taskId);

      return response.taskId;
    } catch (error) {
      const message = videoErrorMessage(error);
      toast({
        title: "Erro ao iniciar recorte",
        description: message,
        variant: "destructive",
      });
      throw error;
    }
  }

  async function cancelTask(taskId: string) {
    cancelledTasks.current.add(taskId);
    updateTask(taskId, { status: "cancelled", progress: 0 });
    try {
      await cancelVideoTask(session.user._id, session.token, taskId);
      toast({
        title: "Recorte cancelado",
        description: "Recorte cancelado. Nenhuma operação foi contabilizada.",
      });
    } catch (err) {
      console.error("Error cancelling video task:", err);
    }
  }

  const active = useMemo(
    () => tasks.filter((t) => ["queued", "processing"].includes(t.status)),
    [tasks],
  );

  const value = useMemo(
    () => ({
      activeTasks: active,
      startTrim,
      cancelTask,
    }),
    [active],
  );

  return (
    <VideoTaskContext.Provider value={value}>
      {children}
      {active.length > 0 && (
        <div className="fixed bottom-24 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-xl border bg-background p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between font-semibold">
            <div className="flex items-center gap-2">
              <Scissors className="size-4 text-primary" />
              <span>Tarefas de edição de vídeo</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {active.length} ativa{active.length > 1 ? "s" : ""}
            </span>
          </div>

          <div className="space-y-4">
            {active.map((item) => (
              <div key={item._id} className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {item.targetName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.status === "queued" ? "Em fila" : "A processar…"}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => cancelTask(item._id)}
                    aria-label="Cancelar recorte"
                    title="Cancelar recorte"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <Progress value={item.progress || 15} />
                <p className="text-xs text-muted-foreground">
                  Recorte: {item.start.toFixed(1)}s a {item.end.toFixed(1)}s (
                  {item.duration.toFixed(1)}s)
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </VideoTaskContext.Provider>
  );
}

export function useVideoTasks() {
  const context = useContext(VideoTaskContext);
  if (!context) {
    throw new Error("useVideoTasks must be used inside VideoTaskProvider");
  }
  return context;
}
