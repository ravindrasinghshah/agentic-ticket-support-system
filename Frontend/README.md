# Ticket support frontend

React, TypeScript, Tailwind CSS, and Vite frontend for the asynchronous ticket-support workflow.

## Pages

- `/` — create a support ticket, retain its tracking ID locally, poll the agent job, and look up an
  existing ticket by UUID.
- `/admin` — view the latest 100 tickets, agent/ticket statuses, headline metrics, category mix,
  filtering, and search. The list refreshes every 15 seconds.

The frontend contains no database or model credentials. It calls the public backend Lambda
Function URL configured through `VITE_API_BASE_URL`.

## Local setup

Node.js 22 or newer is required. From the repository root:

```powershell
cd Frontend
npm install
Copy-Item .env.example .env
```

Set the deployed CDK `JobApiUrl` output in the ignored `.env` file:

```dotenv
VITE_API_BASE_URL=https://your-function-id.lambda-url.us-east-1.on.aws
```

Then start Vite:

```powershell
npm run dev
```

Open `http://localhost:3000`. The backend deployment must use the exact same browser origin:

```dotenv
# Backend/infrastructure/.env
CORS_ALLOWED_ORIGIN=http://localhost:3000
```

Changing `CORS_ALLOWED_ORIGIN` requires a backend CDK deployment because Function URL CORS is AWS
infrastructure configuration.

## Verify

```powershell
npm test
npm run build
```

The production bundle is written to ignored `dist/`.

## Backend API used by the app

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/tickets` | Create a ticket, conversation, and queued agent job |
| `GET` | `/tickets/{ticketId}` | Retrieve a ticket and its latest job |
| `GET` | `/tickets` | Retrieve the admin ticket list |
| `GET` | `/jobs/{jobId}` | Poll an agent job through its terminal state |

The Function URL and admin endpoint are unauthenticated for the current demo. Before production,
put authentication and authorization in front of both APIs—especially `/tickets`, which contains
support-request content.

## Production hosting

This iteration builds a static single-page app but does not add frontend hosting infrastructure.
A later CDK stack can publish `dist/` to S3 behind CloudFront (or use Amplify Hosting). Configure
SPA route fallback to `index.html`, set `VITE_API_BASE_URL` at build time, and redeploy the backend
with the final HTTPS origin in `CORS_ALLOWED_ORIGIN`.
