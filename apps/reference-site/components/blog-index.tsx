import type { SiteDefinition } from "@humber-foundry/site-definition";

export function BlogIndex({ definition }: { definition: SiteDefinition }) {
  const posts = definition.blog.posts.filter(
    (post) => post.targetVisibility === "public",
  );
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
        <ul>
          {posts.map((post) => (
            <li key={post.id}>
              <a href={`/blog/${post.slug}`}><h2>{post.title}</h2></a>
              <p>{post.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
