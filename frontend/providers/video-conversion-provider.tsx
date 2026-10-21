"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSession } from './session-provider';
import { api } from '@/lib/axios';
import { type VideoMetadata, videoErrorMessage } from '@/lib/videos';
import { toast } from '@/hooks/use-toast';

// Data and API requests used by the conversion dialog and task list.
export type ConversionTarget = 'mp4' | 'webm';
export type ConversionResolution = 'preserve' | '720p';
export interface ConversionSource extends VideoMetadata { channels: number; container: string }
export interface ConversionConfiguration { source: ConversionSource; name: string; size: number; limits: { bytes: number; seconds: number } }
export interface ConversionTask {
  _id: string;
  sourceVideoId: string;
  targetName: string;
  target: ConversionTarget;
  resolution: ConversionResolution;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  resultVideoId: string;
}
export const activeConversion = (task: ConversionTask) => ['queued', 'processing'].includes(task.status);
export async function conversionRequest<T>(userId: string, token: string, suffix: string, data?: unknown): Promise<T> {
  const response = await api.request<T>({ url: `/video-conversions/${userId}/${suffix}`,
    method: data === undefined ? 'GET' : 'POST', data,
    headers: { Authorization: `Bearer ${token}` } });
  return response.data;
}

// Persisted tasks are polled here so navigation does not interrupt monitoring.
const Context = createContext<{ tasks: ConversionTask[]; error: string; refresh: () => Promise<void>; cancel: (id: string) => Promise<void>; download: (id: string) => Promise<void>; remove: (id: string) => void } | null>(null);
export function VideoConversionProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useSession();
  const [tasks, setTasks] = useState<ConversionTask[]>([]);
  const [removed, setRemoved] = useState<{ userId: string; ids: string[] }>({ userId: user._id, ids: [] });
  const [error, setError] = useState('');
  const previous = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const identity = useRef({ userId: user._id, token });
  identity.current = { userId: user._id, token };
  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    if (user.type === 'anonymous') return;
    const number = ++requestNumber.current;
    try {
      const next = await conversionRequest<ConversionTask[]>(user._id, token, 'tasks');
      if (!mounted.current || number !== requestNumber.current || identity.current.userId !== user._id || identity.current.token !== token) return;
      for (const task of next) {
        const before = previous.current.get(task._id);
        if (before && before !== task.status && !activeConversion(task)) {
          toast({ title: task.status === 'completed' ? 'Conversão concluída' : 'Conversão terminada',
            description: task.error || task.targetName, variant: task.status === 'failed' ? 'destructive' : 'default' });
          window.dispatchEvent(new Event('video-library-updated'));
        }
        previous.current.set(task._id, task.status);
      }
      setTasks(next); setError('');
    } catch (e) { if (mounted.current && number === requestNumber.current && identity.current.userId === user._id && identity.current.token === token) setError(videoErrorMessage(e)); }
  }, [user._id, user.type, token]);
  useEffect(() => {
    mounted.current = true; previous.current.clear(); setTasks([]);
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 2000); };
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);
  async function cancel(id: string) {
    try { await conversionRequest(user._id, token, `tasks/${id}/cancel`, {}); await refresh(); }
    catch (e) { toast({ title: 'Não foi possível cancelar', description: videoErrorMessage(e), variant: 'destructive' }); await refresh(); }
  }
  async function download(id: string) {
    // Fetch an authorised, short lived storage capability only after the user requests it.
    try {
      const { url } = await conversionRequest<{ url: string }>(user._id, token, `tasks/${id}/download`);
      const link = document.createElement('a'); link.href = url; link.download = ''; link.rel = 'noopener noreferrer'; link.click();
    } catch (e) { toast({ title: 'Download indisponível', description: videoErrorMessage(e), variant: 'destructive' }); }
  }
  function remove(id: string) {
    setRemoved(current => ({ userId: user._id,
      ids: [...new Set([...(current.userId === user._id ? current.ids : []), id])] }));
  }
  // Keep monitoring hidden tasks without letting polling restore their cards.
  const visibleTasks = tasks.filter(task => removed.userId !== user._id || !removed.ids.includes(task._id));
  const active = tasks.filter(activeConversion);
  return <Context.Provider value={{ tasks: visibleTasks, error, refresh, cancel, download, remove }}>
    {children}
    {active.length > 0 && <div className="fixed bottom-4 left-4 z-40 rounded-lg border bg-background p-3 shadow-lg" role="status">
      Conversões ativas: {active.length}. Pode acompanhar na biblioteca de vídeos.
    </div>}
  </Context.Provider>;
}
export function useVideoConversions() {
  const context = useContext(Context);
  if (!context) throw new Error('VideoConversionProvider em falta');
  return context;
}
