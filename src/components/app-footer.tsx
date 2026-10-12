import { APP_VERSION } from "@/lib/project-info";

export function AppFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-[1536px] flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm text-muted-foreground sm:px-6 lg:px-8">
        <p>© {new Date().getFullYear()} Smart Beat. All rights reserved.</p>
        <p className="tabular-nums">Version {APP_VERSION}</p>
      </div>
    </footer>
  );
}
