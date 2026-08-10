import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

/**
 * A deliberately non-reference installation fixture. Its stable identities and
 * editorial copy make accidental fallback to the bundled reference site
 * observable at every site-scoped boundary.
 */
export const alternateSiteDefinition = {
  ...referenceSiteDefinition,
  site: {
    ...referenceSiteDefinition.site,
    id: createSiteId("site_alternate_installation"),
    name: "Alternate installation",
    description: "Content owned by a second Foundry installation.",
  },
  home: {
    ...referenceSiteDefinition.home,
    id: "alternate_home",
    seo: {
      title: "Alternate installation home",
      description: "A second installation acceptance fixture.",
    },
  },
  blog: {
    id: "blog",
    posts: [
      {
        id: createBlogPostId("10000000-0000-4000-8000-000000000102"),
        revision: 1,
        collectionState: "active",
        targetVisibility: "public",
        slug: "alternate-installation-post",
        title: "Alternate installation post",
        excerpt: "A post scoped to the alternate fixture.",
        seo: {
          title: "Alternate installation post",
          description: "A post scoped to the alternate fixture.",
        },
        body: createRichTextDocumentFromPlainText(
          "This post belongs only to the alternate installation.",
        ),
      },
    ],
  },
} satisfies SiteDefinition;
