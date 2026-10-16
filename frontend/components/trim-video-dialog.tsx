"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { LibraryVideo } from "@/lib/videos";
import { useSession } from "@/providers/session-provider";
import { useVideoTasks } from "@/providers/video-task-provider";
import { AlertCircle, Clock, Info, Play, Scissors, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TrimVideoDialogProps {
  video: LibraryVideo | null;
  isOpen: boolean;
  onClose: () => void;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.0";
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins.toString().padStart(2, "0")}:${secs.padStart(4, "0")}`;
}

export default function TrimVideoDialog({
  video,
  isOpen,
  onClose,
}: TrimVideoDialogProps) {
  const session = useSession();
  const { startTrim } = useVideoTasks();

  const videoRef = useRef<HTMLVideoElement>(null);
  const totalDuration = video?.metadata?.duration || 0;

  const [start, setStart] = useState<number>(0);
  const [end, setEnd] = useState<number>(0);
  const [targetName, setTargetName] = useState<string>("");
  const [replaceOriginal, setReplaceOriginal] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const isPremium = session.user.type === "premium";
  const maxTrimDuration = isPremium ? 3600 : 300; // 1 hour for Premium, 5 min for Free
  const remainingOperations = session.user.remaining_operations ?? 0;
  const isOutOfOperations = !isPremium && remainingOperations <= 0;

  useEffect(() => {
    if (video && isOpen) {
      const dur = video.metadata?.duration || 0;
      setStart(0);
      setEnd(dur);

      const ext = video.originalName.includes(".")
        ? `.${video.originalName.split(".").pop()}`
        : "";
      const baseName = video.originalName.replace(ext, "");
      setTargetName(`${baseName}-trim${ext}`);
      setReplaceOriginal(false);
      setIsSubmitting(false);
    }
  }, [video, isOpen]);

  if (!video) return null;

  const trimDuration = Math.max(0, end - start);
  const isTooLong = trimDuration > maxTrimDuration;
  const isInvalidRange = start >= end || start < 0 || end > totalDuration + 0.1;
  const canSubmit = !isSubmitting && !isOutOfOperations && !isTooLong && !isInvalidRange && trimDuration > 0;

  const handleSetCurrentAsStart = () => {
    if (videoRef.current) {
      const current = Math.min(videoRef.current.currentTime, end - 0.1);
      setStart(Math.max(0, Number(current.toFixed(1))));
    }
  };

  const handleSetCurrentAsEnd = () => {
    if (videoRef.current) {
      const current = Math.max(videoRef.current.currentTime, start + 0.1);
      setEnd(Math.min(totalDuration, Number(current.toFixed(1))));
    }
  };

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await startTrim(video._id, {
        start,
        end,
        targetName: targetName.trim(),
        replaceOriginal,
      });
      onClose();
    } catch (error) {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between pr-4">
            <div className="flex items-center gap-2">
              <Scissors className="size-5 text-primary" />
              <DialogTitle>Recortar vídeo (Trim)</DialogTitle>
            </div>
            {isPremium ? (
              <Badge variant="secondary" className="gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <Sparkles className="size-3" />
                Premium (Até 1h / Ilimitado)
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <Clock className="size-3" />
                {remainingOperations}/5 operações diárias
              </Badge>
            )}
          </div>
          <DialogDescription>
            Defina o intervalo de tempo desejado para recortar o vídeo &quot;{video.originalName}&quot;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Player de pré-visualização */}
          <div className="overflow-hidden rounded-lg border bg-black/90">
            <video
              ref={videoRef}
              src={video.url}
              controls
              className="max-h-60 w-full object-contain"
            />
          </div>

          {/* Botões rápidos sincronizados com o player */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Duração total do vídeo: <strong>{formatTime(totalDuration)}</strong></span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleSetCurrentAsStart}
              >
                Definir Início no cursor
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleSetCurrentAsEnd}
              >
                Definir Fim no cursor
              </Button>
            </div>
          </div>

          {/* Seletores de início e fim */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <Label htmlFor="start-slider" className="font-medium">
                  Início do corte: {formatTime(start)} ({start}s)
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-primary"
                  onClick={() => handleSeek(start)}
                >
                  <Play className="mr-1 size-3" /> Ir para início
                </Button>
              </div>
              <Slider
                id="start-slider"
                min={0}
                max={Math.max(0, end - 0.1)}
                step={0.1}
                value={[start]}
                onValueChange={([val]) => {
                  setStart(val);
                  handleSeek(val);
                }}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <Label htmlFor="end-slider" className="font-medium">
                  Fim do corte: {formatTime(end)} ({end}s)
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-primary"
                  onClick={() => handleSeek(end)}
                >
                  <Play className="mr-1 size-3" /> Ir para fim
                </Button>
              </div>
              <Slider
                id="end-slider"
                min={Math.min(totalDuration, start + 0.1)}
                max={totalDuration}
                step={0.1}
                value={[end]}
                onValueChange={([val]) => {
                  setEnd(val);
                  handleSeek(val);
                }}
              />
            </div>

            {/* Inputs manuais precisos */}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="space-y-1">
                <Label htmlFor="start-input" className="text-xs">
                  Início exato (segundos)
                </Label>
                <Input
                  id="start-input"
                  type="number"
                  min={0}
                  max={Math.max(0, end - 0.1)}
                  step={0.1}
                  value={start}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (Number.isFinite(val) && val >= 0 && val < end) setStart(val);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="end-input" className="text-xs">
                  Fim exato (segundos)
                </Label>
                <Input
                  id="end-input"
                  type="number"
                  min={start + 0.1}
                  max={totalDuration}
                  step={0.1}
                  value={end}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (Number.isFinite(val) && val > start && val <= totalDuration) setEnd(val);
                  }}
                />
              </div>
            </div>
          </div>

          {/* Duração resultante do corte e alertas */}
          <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3 text-sm">
            <span className="font-medium">Duração do vídeo recortado:</span>
            <span className={`text-base font-bold ${isTooLong ? "text-destructive" : "text-primary"}`}>
              {formatTime(trimDuration)} ({trimDuration.toFixed(1)}s)
            </span>
          </div>

          {isTooLong && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Limite de duração excedido</AlertTitle>
              <AlertDescription>
                O seu plano permite recortes de até {maxTrimDuration / 60} minutos ({maxTrimDuration}s). O intervalo selecionado tem {trimDuration.toFixed(1)}s. Adira ao plano Premium para recortar até 1 hora.
              </AlertDescription>
            </Alert>
          )}

          {isOutOfOperations && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Quota diária esgotada</AlertTitle>
              <AlertDescription>
                A sua quota diária (5/5) foi atingida. Tente amanhã ou atualize para Premium para operações ilimitadas.
              </AlertDescription>
            </Alert>
          )}

          {/* Nome do ficheiro de destino */}
          <div className="space-y-2">
            <Label htmlFor="target-name">Nome do novo vídeo</Label>
            <Input
              id="target-name"
              value={targetName}
              disabled={replaceOriginal}
              onChange={(e) => setTargetName(e.target.value)}
              placeholder="ex: MeuCorte.mp4"
            />
          </div>

          {/* Opção Substituir Vídeo Original (FA2) */}
          <div className="flex items-start space-x-3 rounded-lg border p-3">
            <Checkbox
              id="replace-original"
              checked={replaceOriginal}
              onCheckedChange={(checked) => setReplaceOriginal(Boolean(checked))}
            />
            <div className="grid gap-1.5 leading-none">
              <Label
                htmlFor="replace-original"
                className="cursor-pointer text-sm font-medium"
              >
                Substituir vídeo original (FA2)
              </Label>
              <p className="text-xs text-muted-foreground">
                Se selecionado, o vídeo atual será substituído pelo novo ficheiro recortado após o processamento, poupando espaço de armazenamento.
              </p>
            </div>
          </div>

          {!isPremium && !isOutOfOperations && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="size-4 text-primary" />
              <span>Esta operação debitará 1 crédito da sua quota diária. Caso o recorte falhe ou seja cancelado, a operação será devolvida.</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            <Scissors className="mr-2 size-4" />
            {isSubmitting ? "A iniciar…" : "Recortar e Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
