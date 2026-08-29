import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The dev server is reached at 127.0.0.1 rather than localhost, because
   * Schwab's OAuth callback has to be registered as an explicit https address
   * and `localhost` is not one Schwab will accept. Next blocks cross-origin
   * requests to dev-only assets by default, and since it is started on
   * `localhost`, that block catches the very origin the brokerage login sends
   * the browser back to -- leaving the dev overlay reconnecting in a loop.
   *
   * Development only; it has no effect on a production build.
   */
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
