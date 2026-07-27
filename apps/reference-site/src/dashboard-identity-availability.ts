import {
  authenticateCloudflareAccessIdentity,
  cloudflareAccessAssertionHeader,
} from "./access-authentication";
import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "./access-identity";
import {
  HumanAccessConfigurationError,
  type HumanAccessEnvironment,
} from "./human-access-configuration";
import {
  withVerifiedDashboardIdentity,
  withoutVerifiedDashboardIdentity,
} from "./verified-dashboard-identity";

const unavailableDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Dashboard temporarily unavailable</title>
  </head>
  <body>
    <main>
      <h1>Dashboard temporarily unavailable</h1>
      <p>We could not verify your identity because the access service is temporarily unavailable. Please try again shortly.</p>
    </main>
  </body>
</html>`;

function errorDocument(status: number, title: string, message: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${status}: ${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

function unavailableResponse() {
  return new Response(unavailableDocument, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "retry-after": "30",
    },
  });
}

function notFoundResponse() {
  return new Response(
    errorDocument(
      404,
      "Not Found",
      "The requested resource could not be found.",
    ),
    {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function withoutCloudflareAccessAssertion(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(cloudflareAccessAssertionHeader);
  return new Request(request, { headers });
}

export function createDashboardIdentityBoundary<Environment, Context>({
  next,
  authenticate = authenticateCloudflareAccessIdentity,
}: {
  next(
    request: Request,
    environment: Environment,
    context: Context,
  ): Promise<Response>;
  authenticate?: typeof authenticateCloudflareAccessIdentity;
}) {
  return async (
    request: Request,
    environment: Environment & HumanAccessEnvironment,
    context: Context,
  ): Promise<Response> => {
    const sanitizedRequest = withoutVerifiedDashboardIdentity(request);
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/dash" && pathname !== "/dash/") {
      return next(sanitizedRequest, environment, context);
    }

    let identity;
    try {
      identity = await authenticate({
        requestHeaders: sanitizedRequest.headers,
        environment,
      });
    } catch (error) {
      if (error instanceof AccessIdentityUnavailableError) {
        return unavailableResponse();
      }
      if (
        error instanceof AccessIdentityError ||
        error instanceof HumanAccessConfigurationError
      ) {
        return notFoundResponse();
      }
      throw error;
    }
    return next(
      withVerifiedDashboardIdentity(
        withoutCloudflareAccessAssertion(sanitizedRequest),
        identity,
      ),
      environment,
      context,
    );
  };
}
