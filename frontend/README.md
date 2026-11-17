# Plex Repairman Frontend

React/Vite operations console. During local development, Vite proxies `/api` to `http://localhost:3000`.

```sh
npm install
npm run dev
```

Production builds are emitted to the root project's `dist/web/public/` directory and expect the API to be available on the same origin under `/api`.

The primary navigation is Overview, Repairs, Agent tasks and Settings. Settings contains Connections, Discord, AI, Repair policy and Security. Form sign-in is optional and configured under Security; a session gate hides administration views until authenticated. Sign-out and expired sessions clear cached administration queries. The app uses session cookies independently of any reverse-proxy Basic credentials.
