This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Price feeds

Prices come from whichever feed can supply them, and the order differs by
what is being asked for:

- **Quotes** prefer Schwab when a brokerage is connected, and fall back to the
  public feed. Schwab reports the prior session's close outright, where the
  public feed leaves it to be recovered from a daily series.
- **History** prefers the public feed even when Schwab is connected. Schwab
  serves closes already adjusted for splits but never reports that a split
  happened, and the events themselves are what let a past close be put back
  into the shares actually held that day. Schwab still stands behind the public
  feed as a source of closes when it is unreachable.

Connecting a brokerage is entirely optional. With no Schwab app configured the
app uses the public feed for everything, the connection banner never appears,
and manual CSV/statement import works exactly as it always has.

### Connecting Schwab

1. Create an app at [developer.schwab.com](https://developer.schwab.com) with
   the **Accounts and Trading** and **Market Data** products.
2. Register `https://127.0.0.1:3001/api/schwab/callback` as its callback URL.
   Schwab only accepts `https`, so the dev server has to serve TLS:
   `npm run dev -- --port 3001 --experimental-https`.
3. Put the app key and secret in `.env.local` (see `.env.example`).
4. Open the portfolio and use **Connect Schwab** in the banner.

### Hosting it for more than one person

A Schwab connection belongs to a person, not to the deployment. Where Supabase
is configured, each user's token is stored in their own `schwab_connections`
row, encrypted, and reachable only by them -- row-level security enforces that
in the database, so a route that forgets to scope its query still cannot return
someone else's credential. Every Schwab route requires a signed-in user.

The single-user file under `data/` is only used when Supabase is not configured
at all, which is the same condition under which this app has no login. As soon
as there is a Supabase project, an unauthenticated request is refused rather
than falling back to that file -- otherwise it would be one shared brokerage
connection handed to every visitor.

To deploy:

1. Run `supabase/schwab_connections.sql` in the Supabase SQL editor.
2. Set `SCHWAB_ENCRYPTION_KEY` (`openssl rand -hex 32`). Connecting is refused
   without it rather than storing a brokerage token in plaintext.
3. Set `SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET`, and a `SCHWAB_CALLBACK_URL` on
   the production domain, and register that callback on the Schwab app.

Note that Schwab requires **commercial approval** before an app may connect
*other people's* accounts. Without it, each user must register their own
individual Schwab app and supply their own key and secret.

**Schwab connections expire after seven days.** The refresh token cannot be
renewed programmatically — Schwab requires a human to sign in again. The banner
starts asking two days out; if it lapses, prices fall back to the public feed
until the next sign-in and nothing else changes.
