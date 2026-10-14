"use client";

import AppDropzone from "@/components/app-dropzone";
import NewProjectDialog from "@/components/dashboard-sidebar/new-project-dialog";
import { Button } from "@/components/ui/button";
import { extractZipImages } from "@/lib/utils";
import { Film, ImagePlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import VideoLibrary from "@/components/video-library";
import { useSession } from "@/providers/session-provider";

export default function Dashboard() {
  const [files, setFiles] = useState<File[]>([]);
  const session = useSession();

  const handleDrop = async (acceptedFiles: File[]) => {
    const compatibleFileTypes = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "application/zip",
    ];

    // Extract images from zip files and filter out incompatible files
    const compatibleFiles: File[] = [];
    for (const file of acceptedFiles) {
      if (file.type === "application/zip") {
        const extractedFiles = await extractZipImages(file);
        compatibleFiles.push(...extractedFiles);
      } else if (compatibleFileTypes.includes(file.type)) {
        compatibleFiles.push(file);
      }
    }

    // Handle duplicate names
    const duplicateNames = new Set<string>();
    files.forEach((file) => duplicateNames.add(file.name));
    const uniqueFiles = compatibleFiles.map((file) => {
      if (duplicateNames.has(file.name)) {
        const newFile = new File(
          [file],
          `${file.name.split(".")[0]} (${duplicateNames.size}).${file.name.split(".")[1]}`,
        );
        duplicateNames.add(newFile.name);
        return newFile;
      }
      duplicateNames.add(file.name);
      return file;
    });

    setFiles(uniqueFiles);
  };

  return (
    <div className="h-full space-y-6 overflow-y-auto p-8">
      {session.user.type !== "anonymous" ? (
        <VideoLibrary />
      ) : (
        <section className="flex flex-col gap-4 rounded-xl border p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Film className="mt-1 size-6 shrink-0 text-primary" />
            <div>
              <h2 className="text-xl font-semibold">Upload videos</h2>
              <p className="text-sm text-muted-foreground">
                Sign in or create an account to upload MP4, MOV, and WebM files
                to your video library.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/register">Create account</Link>
            </Button>
          </div>
        </section>
      )}
      <div className="min-h-[22rem]">
        <NewProjectDialog files={files} setFiles={setFiles}>
          <AppDropzone onDrop={handleDrop}>
            <div className="flex flex-col gap-4 items-center justify-center max-w-[20rem]">
              <ImagePlus size={100} />
              <p className="text-2xl font-medium">
                Pick a project or drag and drop some images or a .zip to create
                a new one
              </p>
            </div>
          </AppDropzone>
        </NewProjectDialog>
      </div>
    </div>
  );
}
