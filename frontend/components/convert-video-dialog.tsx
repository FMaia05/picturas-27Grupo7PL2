"use client";
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { LibraryVideo, videoErrorMessage } from '@/lib/videos';
import { validateSession } from '@/lib/session';
import { useSession } from '@/providers/session-provider';
import { ConversionConfiguration, ConversionResolution, ConversionTarget, conversionRequest, useVideoConversions } from '@/providers/video-conversion-provider';
import { toast } from '@/hooks/use-toast';
export default function ConvertVideoDialog({ video, onClose }: { video: LibraryVideo | null; onClose: () => void }) {
  const session = useSession();
  const { refresh } = useVideoConversions();
  const [configuration, setConfiguration] = useState<ConversionConfiguration | null>(null);
  const [remaining, setRemaining] = useState<number | null | undefined>(undefined);
  const [target, setTarget] = useState<ConversionTarget>('mp4');
  const [resolution, setResolution] = useState<ConversionResolution>('preserve');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let current = true;
    setConfiguration(null); setError(''); setRemaining(undefined); setTarget('mp4'); setResolution('preserve');
    if (video) Promise.all([
      conversionRequest<ConversionConfiguration>(session.user._id, session.token, `source/${video._id}`, {}),
      validateSession({ userId: session.user._id, token: session.token }),
    ]).then(([config, validated]) => {
      if (current) { setConfiguration(config); setRemaining(validated.user.remaining_operations); }
    }).catch(e => { if (current) setError(videoErrorMessage(e)); });
    return () => { current = false; };
  }, [video, session.user._id, session.token]);
  async function submit() {
    if (!video || submitting) return;
    setSubmitting(true);
    try {
      const result = await conversionRequest<{ taskId: string }>(session.user._id, session.token, `source/${video._id}/convert`, { target, resolution });
      toast({ title: 'Conversão em fila', description: `Tarefa ${result.taskId}. O original será preservado.` });
      await refresh(); onClose();
    } catch (e) { setError(videoErrorMessage(e)); }
    finally { setSubmitting(false); }
  }
  const source = configuration?.source;
  return <Dialog open={Boolean(video)} onOpenChange={open => { if (!open && !submitting) onClose(); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Converter vídeo</DialogTitle><DialogDescription>Converta o vídeo completo para um novo ficheiro. O original é preservado.</DialogDescription></DialogHeader>
      {!configuration && !error && <p role="status">A analisar o vídeo e a consultar a quota…</p>}
      {source && configuration && <>
        <div className="rounded-md bg-muted p-3 text-sm space-y-1">
          <p className="break-all font-medium">{configuration.name}</p>
          <p>{source.container.toUpperCase()} · {source.videoCodec} · {source.duration.toFixed(2)} s · {(configuration.size / 1000000).toFixed(2)} MB</p>
          <p>{source.width}×{source.height} (orientação aplicada) · {source.fps.toFixed(2)} fps</p>
          <p>Áudio: {source.channels ? `${source.audioCodec}, ${source.channels === 1 ? 'mono' : 'estéreo'}` : 'Sem áudio'}</p>
        </div>
        <Label htmlFor="conversion-target">Destino</Label>
        <select id="conversion-target" className="rounded-md border bg-background p-2" value={target} onChange={e => setTarget(e.target.value as ConversionTarget)} disabled={submitting}>
          <option value="mp4">MP4 / H.264 / AAC</option><option value="webm">WebM / VP9 / Opus</option>
        </select>
        <Label htmlFor="conversion-resolution">Resolução</Label>
        <select id="conversion-resolution" className="rounded-md border bg-background p-2" value={resolution} onChange={e => setResolution(e.target.value as ConversionResolution)} disabled={submitting}>
          <option value="preserve">Preservar resolução</option><option value="720p">Reduzir até 720p</option>
        </select>
        <div className="text-sm space-y-2" aria-live="polite">
          <p>Resumo: {target === 'mp4' ? 'MP4 / H.264' : 'WebM / VP9'} · {resolution === 'preserve' ? `Preservar ${source.width}×${source.height}` : 'Até 1280×720, sem ampliação'} · {source.channels ? (target === 'mp4' ? 'AAC' : 'Opus') : 'Sem áudio'}.</p>
          <p>{remaining === null ? 'Sem limite diário' : `Operações disponíveis: ${remaining ?? '…'}. Reserva 1 operação; confirma apenas no sucesso.`}</p>
          <p className="text-muted-foreground">Limite da entrada: {configuration.limits.bytes / 1000000} MB / {configuration.limits.seconds} s. Prazo total: 900 s. Pode sair desta página enquanto processa.</p>
        </div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={submitting}>Fechar</Button>
        <Button onClick={submit} disabled={!configuration || submitting || remaining === 0}>{submitting ? 'A submeter…' : 'Confirmar conversão'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
