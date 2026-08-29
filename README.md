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

**Schwab connections expire after seven days.** The refresh token cannot be
renewed programmatically — Schwab requires a human to sign in again. The banner
starts asking two days out; if it lapses, prices fall back to the public feed
until the next sign-in and nothing else changes.
