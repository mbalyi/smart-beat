import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { SampleFolder } from "@/lib/samples/types";

/** Asks before a folder leaves the list. Only a copy kept by Smart Beat is ever deleted. */
export function RemoveFolderDialog({
  folder,
  onCancel,
  onConfirm,
}: {
  folder: SampleFolder | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const linked = folder?.kind === "linked";
  return (
    <AlertDialog open={folder !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {linked ? `Remove “${folder?.name}” from your samples?` : `Delete “${folder?.name}”?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {linked
              ? "Your files are not deleted. They stay where they are, and you can link the folder again any time."
              : "This deletes the copy Smart Beat made of these samples. The original files are not touched. Clips already in a song keep their audio."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant={linked ? "default" : "destructive"} onClick={onConfirm}>
            {linked ? "Remove" : "Delete copy"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
