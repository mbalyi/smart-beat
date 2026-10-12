import { ExternalLink } from "@/components/external-link";
import { PROJECT } from "@/lib/project-info";

/**
 * "© 2026 @mbalyi": Smart Beat is a personal project, not a company, so the copyright names the
 * GitHub account everything is published under, linked to its profile.
 */
export function CopyrightNotice() {
  return (
    <>
      © {new Date().getFullYear()}{" "}
      <ExternalLink href={PROJECT.ownerProfile} className="underline underline-offset-2">
        {PROJECT.ownerHandle}
      </ExternalLink>
    </>
  );
}
