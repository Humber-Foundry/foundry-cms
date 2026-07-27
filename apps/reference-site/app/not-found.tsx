export default function NotFound() {
  return (
    <main className="not-found">
      <p className="eyebrow">Unavailable</p>
      <h1>This page is not available.</h1>
      <p>
        The requested route does not exist, or its required protection has not
        been configured.
      </p>
      <a className="button button-primary" href="/">
        Return to the public site
      </a>
    </main>
  );
}
