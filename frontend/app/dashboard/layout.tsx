"use client";

import DashboardSidebar from "@/components/dashboard-sidebar/dashboard-sidebar";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { usePathname } from "next/navigation";
import { VideoUploadProvider } from "@/providers/video-upload-provider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const path = usePathname();
  return (
    <SidebarProvider defaultOpen>
      <div className="flex min-h-screen w-screen">
        <DashboardSidebar />
        <main className="w-full h-screen max-w-full overflow-hidden relative">
          {path === "/dashboard" && (
            <SidebarTrigger
              variant="outline"
              className="h-9 w-10 absolute top-4 left-4 lg:hidden"
            />
          )}
          <VideoUploadProvider>{children}</VideoUploadProvider>
        </main>
      </div>
    </SidebarProvider>
  );
}
