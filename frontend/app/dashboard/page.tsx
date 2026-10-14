"use client";

import ImageLibrary from "@/components/image-library";
import ProjectLibrary from "@/components/project-library";
import { Button } from "@/components/ui/button";
import { Film } from "lucide-react";
import Link from "next/link";
import VideoLibrary from "@/components/video-library";
import { useSession } from "@/providers/session-provider";

export default function Dashboard() {
  const session = useSession();

  return (
    <div className="h-full space-y-6 overflow-y-auto p-8">
      <ProjectLibrary />
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
      <ImageLibrary />
    </div>
  );
}
