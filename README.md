# Orbit CRM — WooCommerce Customer Hub

A dark navy and cyan CRM prototype styled from the supplied reference. It demonstrates customer data management, order tracking, segmentation, and a review-before-send communication workflow.

## Run the demo

Open `index.html` directly in a browser to see sample data. Or run `npm start` with Node.js 22+ and visit `http://127.0.0.1:4173` for the app plus its local API server. The project has no npm dependencies.

## Connect a WooCommerce store

1. In WordPress, go to **WooCommerce → Settings → Advanced → REST API** and create a key with **Read** permission for a store user that can read customers and orders. The WooCommerce docs describe [REST API keys and HTTPS authentication](https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication) and [pagination](https://woocommerce.github.io/woocommerce-rest-api-docs/#pagination).
2. Run `npm start` and open `http://127.0.0.1:4173`.
3. On first launch, choose **Create account** and make a local Orbit account. After signing in, open **Settings** from the top right, enter the store URL and a new read-only key/secret, and select **Save connection & sync**. This writes the settings to an ignored `.env` file in the project folder. You can also copy `.env.example` to `.env` and fill the same values manually.
4. Public stores must use HTTPS. Local development hosts such as `beatz.local`, `*.test`, and `localhost` may use HTTP; the server signs those requests with WooCommerce OAuth 1.0a. Keep `.env` local. Never paste keys into `index.html`, GitHub, a screenshot, or chat. The server also accepts the earlier `WOOCOMMERCE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, and `WOOCOMMERCE_CONSUMER_SECRET` variable names.
5. Set `WC_CURRENCY` to the store's three-letter currency code if it isn't INR.
6. The server calls WooCommerce REST API v3 for customers and recent orders; credentials remain in Node and are never returned to the browser.

The server reads up to `WC_MAX_CUSTOMER_PAGES` pages of 100 customers each and the newest 100 orders. The UI reports the number loaded and whether customer pagination was capped. The customer segmentation uses order count, total spend, and the latest order found in the fetched orders. Guest checkouts may not have customer records in the WooCommerce Customers endpoint.

## Architecture and security

- `index.html` is the browser UI. It calls same-origin `/api/health` and `/api/overview` endpoints.
- `server.mjs` serves the UI and proxies read-only calls to `/wp-json/wc/v3/customers` and `/wp-json/wc/v3/orders`. It uses Basic authentication over HTTPS and signed OAuth 1.0a for local development over HTTP, following the [WooCommerce REST API authentication guidance](https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication).
- The API key and secret are read from environment variables and never included in API responses, URLs, logs, or frontend code.
- The server intentionally binds to localhost. Local sign-up/sign-in uses scrypt password hashes in the ignored `auth-users.json` file and an HttpOnly, SameSite session cookie; signing out clears the session. Sessions are held in memory and end when the server restarts. This is a local demo account flow, not a production identity system: there is no password reset, email verification, multi-tenant authorization, or public hosting support. Keep the server bound to localhost and do not expose it publicly.
- GitHub Pages hosts only the static demo. It cannot run this Node backend or safely hold WooCommerce secrets. A live hosted integration needs a protected server deployment with authentication, HTTPS, and environment secrets; never add the keys to GitHub Actions artifacts or client builds.
- The customer message workflow is a draft/log demo and does not send email. The account summary is a deterministic rule-based suggestion, not an LLM call.

## Demo walkthrough

1. Use the sidebar to open separate **Customers**, **Orders**, and **Campaigns** pages.
2. Search and segment customer records; open a profile to inspect spend, orders, and a next-best-action suggestion.
3. Search and filter recent WooCommerce orders.
4. Use Campaign Copilot to select an audience and generate a personalized message draft. It uses transparent customer-segment rules and does not send messages or call an external AI service.
5. Export customer records as CSV.

## What remains for a production-ready integration

- Store synced records in a database and incrementally update them with signed WooCommerce webhooks.
- Add authentication and authorization before any public deployment, along with rate limits, audit logging, retries, and idempotency.
- Add consent-aware email delivery and record delivery status; require user review before send.
- Expand pagination/background sync for large stores and make segmentation thresholds configurable.
- Replace the local backend deployment with an HTTPS hosted service and managed secret storage.

## Two-minute presentation outline

“I chose CRM System Integration to bring customer profiles, orders, and follow-up into one workflow. Orbit can run in sample-data mode, or connect through a small Node server using a read-only WooCommerce key. The browser never sees the key. I can sync customer and recent-order data, filter accounts by segment, inspect a customer’s history, and prepare a follow-up for human review. The project keeps message delivery out of scope and explains what a production release still needs, including webhooks, persistence, and consent-aware delivery.”


##video link : https://drive.google.com/file/d/19AZ2ryN02-l1mUwEiW0HXzfgtCr1gkCY/view?usp=share_link
## video link 2 : https://drive.google.com/file/d/1udbbyD8P9XzIQC-lW_MTnpDSvmX2WORB/view?usp=sharing
