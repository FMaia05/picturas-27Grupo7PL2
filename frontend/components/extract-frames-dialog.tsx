"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { fetchProjects, Project } from "@/lib/projects";
import { LibraryVideo } from "@/lib/videos";
import { useSession } from "@/providers/session-provider";
import { useVideoTasks } from "@/providers/video-task-provider";
import {
  AlertCircle,
  Camera,
  Clock,
  Film,
  Info,
  Layers,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ExtractFramesDialogProps {
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

export default function ExtractFramesDialog({
  video,
  isOpen,
  onClose,
}: ExtractFramesDialogProps) {
  const session = useSession();
  const { startExtractFrames } = useVideoTasks();

  const videoRef = useRef<HTMLVideoElement>(null);
  const totalDuration = video?.metadata?.duration || 0;

  const [start, setStart] = useState<number>(0);
  const [end, setEnd] = useState<number>(0);
  const [step, setStep] = useState<number>(5);
  const [format, setFormat] = useState<"png" | "jpeg">("png");
  const [destinationType, setDestinationType] = useState<"new" | "existing">("new");
  const [projectName, setProjectName] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [userProjects, setUserProjects] = useState<Project[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const isPremium = session.user.type === "premium";
  const maxIntervalDuration = isPremium ? 1800 : 120; // 1800s Premium, 120s Registado (RN3)
  const maxFrames = isPremium ? 200 : 30; // 200 Premium, 30 Registado (RN5)
  const remainingOperations = session.user.remaining_operations ?? 0;
  const isOutOfOperations = !isPremium && remainingOperations <= 0;

  useEffect(() => {
    if (video && isOpen) {
      const dur = video.metadata?.duration || 0;
      setStart(0);
      setEnd(dur);
      setStep(5);
      setFormat("png");
      setDestinationType("new");
      setSelectedProjectId("");
      setIsSubmitting(false);

      const ext = video.originalName.includes(".")
        ? `.${video.originalName.split(".").pop()}`
        : "";
      const baseName = video.originalName.replace(ext, "");
      setProjectName(`${baseName} - Fotogramas`);

      // Load user projects for existing project destination (FA2)
      fetchProjects(session.user._id, session.token)
        .then((projs) => {
          setUserProjects(projs);
          if (projs.length > 0) {
            setSelectedProjectId(projs[0]._id);
          }
        })
        .catch(() => {});
    }
  }, [video, isOpen, session.user._id, session.token]);

  if (!video) return null;

  const intervalDuration = Math.max(0, end - start);
  const validStep = Math.max(1, Math.min(60, Math.floor(step || 5)));
  const totalFrames = intervalDuration > 0 ? Math.floor(intervalDuration / validStep) + 1 : 0;

  const maxFileSizeBytes = isPremium ? 2000 * 1024 * 1024 : 200 * 1024 * 1024;
  const isFileSizeExceeded = video.size > maxFileSizeBytes;

  const maxPixels = isPremium ? 3840 * 2160 : 1920 * 1080;
  const videoPixels = (video.metadata?.width || 0) * (video.metadata?.height || 0);
  const isResolutionExceeded = videoPixels > maxPixels;

  const isTooLong = intervalDuration > maxIntervalDuration;
  const isTooManyFrames = totalFrames > maxFrames;
  const isInvalidRange = start >= end || start < 0 || end > totalDuration + 0.1;
  const isStepInvalid = !step || step < 1 || step > 60 || !Number.isInteger(Number(step));

  // Suggestion for step when frames exceed limit (Exceção 3, REQ-VID-FRAME-016)
  const suggestedMinStep = Math.ceil(intervalDuration / (maxFrames - 1));

  const canSubmit =
    !isSubmitting &&
    !isOutOfOperations &&
    !isFileSizeExceeded &&
    !isResolutionExceeded &&
    !isTooLong &&
    !isTooManyFrames &&
    !isInvalidRange &&
    !isStepInvalid &&
    totalFrames > 0 &&
    (destinationType === "new" ? projectName.trim().length > 0 : Boolean(selectedProjectId));

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
      await startExtractFrames(video._id, {
        start,
        end,
        step: validStep,
        format,
        destinationType,
        targetName: destinationType === "new" ? projectName.trim() : undefined,
        destinationProjectId: destinationType === "existing" ? selectedProjectId : undefined,
      });
      onClose();
    } catch {
      setIsSubmitting(false);
    }
  };

  const fileSizeMB = (video.size / (1024 * 1024)).toFixed(1);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between pr-4">
            <div className="flex items-center gap-2">
              <Camera className="size-5 text-primary" />
              <DialogTitle>Extrair fotogramas de vídeo</DialogTitle>
            </div>
            {isPremium ? (
              <Badge variant="secondary" className="gap-1 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <Sparkles className="size-3" />
                Premium (Até 200 fotogramas / Sem limite)
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1">
                <Clock className="size-3" />
                {remainingOperations}/5 operações diárias
              </Badge>
            )}
          </div>
          <DialogDescription>
            Configure o intervalo e o passo de amostragem para extrair imagens do vídeo &quot;{video.originalName}&quot;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Metadados do vídeo (REQ-VID-FRAME-012) */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1 font-medium text-foreground">
              <Film className="size-3.5 text-primary" />
              <span>{video.originalName}</span>
            </div>
            <span>·</span>
            <span>Resolução: <strong>{video.metadata ? `${video.metadata.width}×${video.metadata.height}` : "N/D"}</strong></span>
            <span>·</span>
            <span>Duração: <strong>{formatTime(totalDuration)}</strong></span>
            <span>·</span>
            <span>Tamanho: <strong>{fileSizeMB} MB</strong></span>
            <span>·</span>
            <span>Formato: <strong>{video.metadata?.videoCodec?.toUpperCase() || "H.264"}</strong></span>
          </div>

          {/* Player de pré-visualização */}
          <div className="overflow-hidden rounded-lg border bg-black/90">
            <video
              ref={videoRef}
              src={video.url}
              controls
              className="max-h-56 w-full object-contain"
            />
          </div>

          {/* Botões sincronizados com o player */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Posicione o vídeo no instante pretendido:</span>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="extract-start" className="text-xs">
                Início: <strong>{formatTime(start)}</strong>
              </Label>
              <Input
                id="extract-start"
                type="number"
                step="0.1"
                min={0}
                max={Math.max(0, end - 0.1)}
                value={start}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setStart(val);
                  handleSeek(val);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="extract-end" className="text-xs">
                Fim: <strong>{formatTime(end)}</strong>
              </Label>
              <Input
                id="extract-end"
                type="number"
                step="0.1"
                min={start + 0.1}
                max={totalDuration}
                value={end}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setEnd(val);
                  handleSeek(val);
                }}
              />
            </div>
          </div>

          {/* Slider visual do intervalo */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0s</span>
              <span>Intervalo: {intervalDuration.toFixed(1)}s (máx. {maxIntervalDuration}s)</span>
              <span>{totalDuration.toFixed(1)}s</span>
            </div>
            <Slider
              value={[start, end]}
              min={0}
              max={Math.max(0.1, totalDuration)}
              step={0.1}
              onValueChange={([s, e]) => {
                if (s !== start) {
                  setStart(s);
                  handleSeek(s);
                } else if (e !== end) {
                  setEnd(e);
                  handleSeek(e);
                }
              }}
            />
          </div>

          {/* Passo de amostragem e Formato de saída (RN4, RN7) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="extract-step" className="text-xs">
                Passo de amostragem (segundos)
              </Label>
              <Input
                id="extract-step"
                type="number"
                min={1}
                max={60}
                step={1}
                value={step}
                onChange={(e) => setStep(parseInt(e.target.value, 10) || 1)}
              />
              <p className="text-[11px] text-muted-foreground">
                Entre 1 e 60 s (omissão: 5 s).
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Formato das imagens</Label>
              <Select
                value={format}
                onValueChange={(val: "png" | "jpeg") => setFormat(val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">PNG (Sem perdas)</SelectItem>
                  <SelectItem value="jpeg">JPEG (Qualidade 90)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Resolução original sem redução de qualidade.
              </p>
            </div>
          </div>

          {/* Destino das imagens (FA2, REQ-VID-FRAME-005, 040) */}
          <div className="space-y-3 rounded-lg border p-3">
            <Label className="text-xs font-semibold">Destino dos fotogramas</Label>
            <div className="flex gap-4 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="destType"
                  checked={destinationType === "new"}
                  onChange={() => setDestinationType("new")}
                />
                <span>Criar novo projeto</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="destType"
                  checked={destinationType === "existing"}
                  onChange={() => setDestinationType("existing")}
                />
                <span>Adicionar a projeto existente</span>
              </label>
            </div>

            {destinationType === "new" ? (
              <div className="space-y-1 pt-1">
                <Label htmlFor="project-name" className="text-xs text-muted-foreground">
                  Nome do novo projeto
                </Label>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Nome do projeto..."
                />
              </div>
            ) : (
              <div className="space-y-1 pt-1">
                <Label className="text-xs text-muted-foreground">
                  Selecione o projeto existente
                </Label>
                {userProjects.length > 0 ? (
                  <Select
                    value={selectedProjectId}
                    onValueChange={(val) => setSelectedProjectId(val)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Escolha um projeto" />
                    </SelectTrigger>
                    <SelectContent>
                      {userProjects.map((p) => (
                        <SelectItem key={p._id} value={p._id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Não existem projetos na conta. Selecione &quot;Criar novo projeto&quot;.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Resumo dinâmico e Alertas (REQ-VID-FRAME-012, Exceções 2, 3, 4) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg bg-primary/5 p-3 text-xs">
              <div className="flex items-center gap-2">
                <Layers className="size-4 text-primary" />
                <span>
                  Fotogramas a extrair: <strong>{totalFrames}</strong> imagens
                </span>
              </div>
              <Badge variant={isTooManyFrames ? "destructive" : "secondary"}>
                Limite: {maxFrames} fotogramas
              </Badge>
            </div>

            {isFileSizeExceeded && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Tamanho de vídeo excedido</AlertTitle>
                <AlertDescription className="text-xs">
                  O tamanho do vídeo ({fileSizeMB} MB) excede o limite do seu perfil ({isPremium ? "2 GB" : "200 MB"}). {isPremium ? "" : "Atualize para o plano Premium."}
                </AlertDescription>
              </Alert>
            )}

            {isResolutionExceeded && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Resolução de vídeo excedida</AlertTitle>
                <AlertDescription className="text-xs">
                  A resolução do vídeo ({video.metadata ? `${video.metadata.width}×${video.metadata.height}` : ""}) excede o limite do seu perfil ({isPremium ? "3840×2160 (4K)" : "1920×1080 (1080p)"}). {isPremium ? "" : "Atualize para o plano Premium."}
                </AlertDescription>
              </Alert>
            )}

            {isTooManyFrames && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Limite de fotogramas excedido</AlertTitle>
                <AlertDescription className="text-xs">
                  O número estimado de fotogramas ({totalFrames}) excede o limite do seu perfil ({maxFrames}).
                  {suggestedMinStep > step && (
                    <span className="block mt-1 font-medium">
                      Sugestão: utilize um passo de pelo menos {suggestedMinStep} s para cumprir o limite.
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {isTooLong && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Intervalo demasiado longo</AlertTitle>
                <AlertDescription className="text-xs">
                  A duração selecionada ({intervalDuration.toFixed(1)} s) excede o limite do perfil ({maxIntervalDuration} s). Reduza o intervalo selecionado.
                </AlertDescription>
              </Alert>
            )}

            {isOutOfOperations && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Quota diária atingida</AlertTitle>
                <AlertDescription className="text-xs">
                  Quota diária de operações atingida. Atualize para o plano Premium ou tente novamente amanhã.
                </AlertDescription>
              </Alert>
            )}

            {!isFileSizeExceeded && !isResolutionExceeded && !isTooManyFrames && !isTooLong && !isOutOfOperations && !isInvalidRange && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="size-3.5 text-primary" />
                Esta extração consumirá 1 operação da sua conta. As imagens serão guardadas por ordem cronológica.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            <Camera className="size-4" />
            {isSubmitting ? "A iniciar…" : `Extrair ${totalFrames > 0 ? totalFrames : ""} fotogramas`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
