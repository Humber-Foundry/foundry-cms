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
 * grants today, and must never promise less than it grants either. A
 * permission gains a tool, and this screen gains the sentence for it in the
 * same change.
 */
export const mcpAgentCapabilityDescriptions: Readonly<
  Record<SupportedMcpScope, string>
> = {
  "site.read":
    "Read your site's pages, posts, schema and design. Every connection includes this.",
  "content.draft":
    "Prepare draft changes to your pages and posts — their words, which sections a page holds, pages it adds or removes, and new blog posts it writes — as a new draft you review before it goes live. It can add photos to your photo library and put them on a page. It can also take a post out of your blog and put one back.",
  "design.draft":
    "Prepare draft changes to your site's design tokens and section styles, as a new draft you review before it goes live.",
  "publication.schedule":
    "Schedule a blog draft you already approved to go live at a future time, ask you to publish a post at a time it suggests, ask you to send a newsletter at a time it suggests, and check or cancel that schedule.",
  "publication.publish":
    "Publish a draft immediately, once you have approved that exact draft.",
  "campaign.draft":
    "Prepare newsletter campaign drafts for your review, and read where one has got to. It cannot send them.",
  "campaign.test":
    "Send a test copy of a newsletter campaign only to the test addresses you already set up.",
  "analytics.read":
    "Read summary traffic and engagement numbers, without visitor or subscriber detail.",
};

/**
 * Plain statements of what an agent can never do, regardless of which
 * permissions it holds. These match the real tool catalog as it stands
 * today: no tool takes a live post off your site on its own, or sends a
 * newsletter to more than the Owner's own test addresses. A photo an agent
 * adds is draft work, so this list says where that photo stops rather than
 * claiming no agent can add one.
 */
export const mcpAgentNeverDoes: ReadonlyArray<string> = Object.freeze([
  "It can never publish or schedule anything without you approving that exact draft.",
  "It can never send your newsletter to your subscriber list. No permission allows sending to more than your own test addresses.",
  "It never sees a subscriber's email address, even when it can draft or test a newsletter.",
  "A photo it adds goes into your photo library and onto a draft page only. It reaches your live site after you approve that draft, like every other change.",
  "It cannot take a post that is on your site off it. Archiving a live post only starts the removal, and you approve that removal like any other change.",
  "It cannot see your dashboard sign-in, Cloudflare account, GitHub account or email provider credentials.",
  "It cannot change who can sign in to this dashboard or any other site setting.",
]);
