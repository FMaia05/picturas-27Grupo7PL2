"use client";

import { useSession } from "@/providers/session-provider";
import { Badge } from "@/components/ui/badge";

export default function OperationsCounter() {
  const session = useSession();
  const user = session.user;

  // Só interessa para free/anonymous
  if (user.type === "premium") return null;

  const remaining = user.remaining_operations;

  // Se ainda não tivermos o valor (primeiros ms), não mostra nada
  if (remaining === undefined || remaining === null) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Operações diárias restantes</span>
      <Badge className="rounded-full border-blue-500/30 bg-blue-500/15 px-2 text-blue-600 shadow-none hover:bg-blue-500/15 dark:text-blue-400">
        {remaining}
      </Badge>
    </div>
  );
}
