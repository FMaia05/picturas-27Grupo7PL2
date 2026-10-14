"use client";

import NewProjectDialog from "@/components/dashboard-sidebar/new-project-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useGetProjects } from "@/lib/queries/projects";
import { useSession } from "@/providers/session-provider";
import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";

export default function ProjectLibrary() {
  const session = useSession();
  const projects = useGetProjects(session.user._id, session.token);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Project library</h2>
          <p className="text-sm text-muted-foreground">
            Open an image-editing workspace or create a new project.
          </p>
        </div>
        <NewProjectDialog>
          <Button>
            <Plus className="mr-2 size-4" />
            New project
          </Button>
        </NewProjectDialog>
      </div>

      <div className="rounded-xl border-2 border-dashed border-muted p-4">
        {projects.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
            <FolderKanban />
            Loading projects…
          </div>
        ) : projects.data && projects.data.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {projects.data.map((project) => (
              <Card key={project._id}>
                <CardContent className="flex items-center gap-3 p-3">
                  <FolderKanban className="size-9 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/${project._id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {project.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      Open project
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
            <FolderKanban />
            Create your first project
          </div>
        )}
      </div>
    </section>
  );
}
