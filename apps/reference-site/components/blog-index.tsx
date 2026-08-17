import {
  blogPostThumbnail,
  resolveMediaImageSrc,
  type BlogPost,
  type MediaImageDelivery,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

export function publicBlogPosts(
  definition: SiteDefinition,
): ReadonlyArray<BlogPost> {
  return definition.blog.posts.filter(
    (post) => post.targetVisibility === "public",
  );
}

export function PublicBlogPostList({
  posts,
  postHref,
  headingTag: Heading,
  mediaDelivery = "published",
  mediaAccessToken,
}: {
  posts: ReadonlyArray<BlogPost>;
  postHref(post: BlogPost): string;
  headingTag: "h2" | "h3";
  mediaDelivery?: MediaImageDelivery;
  mediaAccessToken?: string;
}) {
  return (
    <ul>
      {posts.map((post) => {
        const thumbnail = blogPostThumbnail(post);
        return (
          <li key={post.id}>
            {thumbnail === null ? null : (
              <img
                className="post-card-thumbnail"
                src={resolveMediaImageSrc(
                  thumbnail.url,
                  mediaDelivery,
                  mediaAccessToken,
                )}
                alt={thumbnail.alt}
              />
            )}
            <Heading><a href={postHref(post)}>{post.title}</a></Heading>
            <p>{post.excerpt}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function BlogIndex({ definition }: { definition: SiteDefinition }) {
  const posts = publicBlogPosts(definition);
  return (
    <main id="main-content" className="lh-blog-index" tabIndex={-1}>
      <p className="lh-hand-label">{definition.site.name}</p>
      <h1>Blog</h1>
      {posts.length === 0 ? (
        <section className="lh-blog-empty" aria-labelledby="empty_blog_title">
          <h2 id="empty_blog_title">There’s nothing published here yet.</h2>
          <p>
            When the first piece is published, you’ll find it here. In the
            meantime, head back to the main site.
          </p>
          <a className="lh-button lh-button-green" href="/">
            Back to the main site
          </a>
        </section>
      ) : (
        <PublicBlogPostList
          posts={posts}
          postHref={(post) => `/blog/${post.slug}`}
          headingTag="h2"
        />
      )}
    </main>
  );
}
