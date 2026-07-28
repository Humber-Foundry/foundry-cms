export function publicScriptPaths(html) {
  const scriptSources = Array.from(
    html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g),
    (match) => match[1],
  );
  const preloadSources = Array.from(
    html.matchAll(
      /<link\b(?=[^>]*\brel="(?:preload|modulepreload)")(?=[^>]*(?:\bas="script"|\brel="modulepreload"))[^>]*\bhref="([^"]+\.js)"[^>]*>/g,
    ),
    (match) => match[1],
  );

  return [...new Set([...scriptSources, ...preloadSources])];
}

export function publicStylePaths(html) {
  return [
    ...new Set(
      Array.from(
        html.matchAll(
          /<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+\.css)"[^>]*>/g,
        ),
        (match) => match[1],
      ),
    ),
  ];
}
