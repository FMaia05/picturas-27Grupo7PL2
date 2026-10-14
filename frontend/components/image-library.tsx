"use client";

import NewProjectDialog from "@/components/dashboard-sidebar/new-project-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { getProjectImages, ProjectImage } from "@/lib/projects";
import { useGetProjects } from "@/lib/queries/projects";
import { extractZipImages } from "@/lib/utils";
import { useSession } from "@/providers/session-provider";
import { ImageIcon, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface LibraryImage extends ProjectImage {
  projectId: string;
  projectName: string;
}

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/jpg"]);

export default function ImageLibrary() {
  const session = useSession();
  const projects = useGetProjects(session.user._id, session.token);
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadImages() {
      if (!projects.data) {
        setImages([]);
        setLoading(projects.isLoading);
        return;
      }
      setLoading(true);

      try {
        const projectImages = await Promise.all(
          projects.data.map(async (project) => {
            const items = await getProjectImages(
              session.user._id,
              project._id,
              session.token,
            );

            return items.map((image) => ({
              ...image,
              projectId: project._id,
              projectName: project.name,
            }));
          }),
        );

        if (!cancelled) setImages(projectImages.flat());
      } catch {
        if (!cancelled) {
          toast({
            title: "Unable to load image library",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadImages();
    return () => {
      cancelled = true;
    };
  }, [projects.data, projects.isLoading, session.token, session.user._id]);

  async function prepareFiles(droppedFiles: File[]) {
    const compatibleFiles: File[] = [];
    let rejected = false;

    for (const file of droppedFiles) {
      if (
        file.type === "application/zip" ||
        file.name.toLowerCase().endsWith(".zip")
      ) {
        compatibleFiles.push(...(await extractZipImages(file)));
      } else if (supportedImageTypes.has(file.type)) {
        compatibleFiles.push(file);
      } else {
        rejected = true;
      }
    }

    if (rejected) {
      toast({
        title: "Unsupported file",
        description: "Upload PNG or JPEG images, or a .zip containing images.",
        variant: "destructive",
      });
    }

    if (compatibleFiles.length > 0) setFiles(compatibleFiles);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Image library</h2>
          <p className="text-sm text-muted-foreground">
            PNG/JPG images or a .zip. New uploads are organized in a project.
          </p>
        </div>
        <NewProjectDialog files={files} setFiles={setFiles}>
          <Button>
            <Upload className="mr-2 size-4" />
            Upload images
          </Button>
        </NewProjectDialog>
      </div>

      <div
        className={`rounded-xl border-2 border-dashed p-4 transition-colors ${
          dragging ? "border-primary bg-primary/10" : "border-muted"
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void prepareFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {loading || projects.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
            <ImageIcon />
            Loading images…
          </div>
        ) : images.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
            <ImageIcon />
            Drop images here to create a project
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {images.map((image) => (
              <Card key={`${image.projectId}:${image._id}`}>
                <CardContent className="flex items-center gap-3 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt=""
                    className="size-14 shrink-0 rounded-md border object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/${image.projectId}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {image.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {image.projectName}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
