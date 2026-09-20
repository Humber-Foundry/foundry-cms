import { mcpSupportedScopes } from "@humber-foundry/application";

type SupportedMcpScope = (typeof mcpSupportedScopes)[number];

/**
 * One plain sentence for each permission an Owner can grant, describing what
 * an agent may do once that permission is approved. Typed against
 * `mcpSupportedScopes`, so a scope added there without a sentence here fails
 * the typecheck instead of silently leaving the connect screen incomplete.
 *
 * Each sentence must stay inside what the real tool catalog
 * (`docs/mcp/catalog.md`, `apps/reference-site/src/mcp-tool-registry.ts`)
 * grants today. It must never promise a capability that ticket work has not
 * shipped yet, such as starting a blog post from nothing or uploading a
 * photo.
 */
export const mcpAgentCapabilityDescriptions: Readonly<
  Record<SupportedMcpScope, string>
> = {
  "site.read":
    "Read your site's pages, posts, schema and design. Every connection includes this.",
  "content.draft":
    "Prepare draft changes to your pages and posts — their words, which sections a page holds, and pages it adds or removes — as a new draft you review before it goes live.",
  "design.draft":
    "Prepare draft changes to your site's design tokens and layout variants, as a new draft you review before it goes live.",
  "publication.schedule":
    "Schedule a blog draft you already approved to go live at a future time, and check or cancel that schedule.",
  "publication.publish":
    "Publish a draft immediately, once you have approved that exact draft.",
  "campaign.draft":
    "Prepare newsletter campaign drafts for your review. It cannot send them.",
  "campaign.test":
    "Send a test copy of a newsletter campaign only to the test addresses you already set up.",
  "analytics.read":
    "Read summary traffic and engagement numbers, without visitor or subscriber detail.",
};

/**
 * Plain statements of what an agent can never do, regardless of which
 * permissions it holds. These match the real tool catalog as it stands
 * today: no tool writes a blog post from nothing, uploads a photo, or sends a
 * newsletter to more than the Owner's own test addresses.
 */
export const mcpAgentNeverDoes: ReadonlyArray<string> = Object.freeze([
  "It can never publish or schedule anything without you approving that exact draft.",
  "It can never send your newsletter to your subscriber list. No permission allows sending to more than your own test addresses.",
  "It never sees a subscriber's email address, even when it can draft or test a newsletter.",
  "It can never put a page change on your live site by itself. Every change it makes waits in a draft until you approve it.",
  "It cannot start a new blog post from nothing or upload a photo. Those are not built yet.",
  "It cannot see your dashboard sign-in, Cloudflare account, GitHub account or email provider credentials.",
  "It cannot change who can sign in to this dashboard or any other site setting.",
]);
