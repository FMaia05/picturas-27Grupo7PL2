"use client";
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { activeConversion, useVideoConversions } from '@/providers/video-conversion-provider';
import { Trash2 } from 'lucide-react';
const names = { queued: 'Em fila', processing: 'A processar', completed: 'Concluído', failed: 'Falhado', cancelled: 'Cancelado' };
export default function VideoConversionTasks() {
  const { tasks, error, cancel, download, remove } = useVideoConversions();
  return <div className="space-y-3">
    <h3 className="font-semibold">Conversões de vídeo</h3>
    {error && <p role="alert" className="text-sm text-destructive">Não foi possível atualizar as conversões: {error}</p>}
    {!tasks.length && !error && <p className="text-sm text-muted-foreground">Ainda não existem conversões.</p>}
    <div className="max-h-80 space-y-3 overflow-y-auto">
      {tasks.map(task => <div className="rounded-lg border p-3 space-y-2" key={task._id}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-all text-sm font-medium">{task.targetName}</p>
          <div className="flex items-center gap-2">
            <span className="text-sm">{names[task.status]} · {task.progress}%</span>
            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive"
              title="Remover da lista" aria-label={`Remover ${task.targetName} da lista`} onClick={() => remove(task._id)}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground break-all">ID: {task._id} · {task.target.toUpperCase()} · {task.resolution === '720p' ? 'Até 720p' : 'Preservar resolução'}</p>
        {activeConversion(task) && <><Progress value={task.progress} aria-label={`Progresso estimado de ${task.targetName}`} /><Button variant="outline" size="sm" onClick={() => cancel(task._id)}>Cancelar conversão</Button></>}
        {task.error && <p className="text-sm">{task.error}</p>}
        {task.status === 'completed' && <Button size="sm" onClick={() => download(task._id)}>Descarregar vídeo</Button>}
      </div>)}
    </div>
  </div>;
}
