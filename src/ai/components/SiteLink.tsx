import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAiWorkspace } from "@/ai/AiWorkspaceContext";

interface SiteLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
  children: ReactNode;
}

// A link out of the workspace to one of the site's pages. Normally a
// client-side link, so the move is instant. The server stops writing a
// reply the moment its connection closes, so while a reply is being written
// the page opens in a new tab instead and the reply carries on here.
// Forwards its ref so it can stand in for a menu item (asChild).
const SiteLink = forwardRef<HTMLAnchorElement, SiteLinkProps>(function SiteLink({ to, children, title, ...rest }, ref) {
  const { chat } = useAiWorkspace();
  const writing = chat.busyThreadIds.size > 0;
  if (writing) {
    return (
      <a ref={ref} href={to} target="_blank" rel="noopener" title="A reply is still being written here, so this opens in a new tab." {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link ref={ref} to={to} title={title} {...rest}>
      {children}
    </Link>
  );
});

export default SiteLink;
