# Google Identity enrollment configuration

1. Create an OAuth 2.0 Client ID of type **Web application** in Google Cloud Console.
2. Add the exact production JavaScript origin `https://flow.muidsoft.com` (and a separate staging origin only if used).
3. Set the public client ID as the GitHub repository Actions variable `GOOGLE_CLIENT_ID`; the Pages workflow exposes it as `VITE_GOOGLE_CLIENT_ID` at build time.
4. Set the same value as a non-secret Worker variable `GOOGLE_CLIENT_ID` in the Cloudflare Worker environment.
5. Apply D1 migration 0007 and deploy Worker + Pages.

Do not create or ship a Google client secret for GIS. The Web client ID is public.

From Android Chrome, select a slot, tap **Hubungkan akun Google**, then use Google's own sign-in button. The Worker validates RS256 signature using Google's JWKS, issuer, audience, expiry, issued-at, verified email and single-use nonce. Challenge TTL is five minutes.

D1 stores Google subject, verified email, verification time and hashed nonce only. Raw ID token is transient and not logged or persisted. No password, access/refresh token, cookie, or Chrome profile is collected.

Identity linking does not set `accounts.status=ready` and does not authenticate Google Flow. The owner can open Flow manually in Android Chrome. The PWA cannot inspect or transfer that Chrome session to Playwright.
