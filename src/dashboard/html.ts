import { html } from 'hono/html';

export const message = async (status: number, text: string): Promise<Response> =>
  new Response(await html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SamePage</title></head>
<body><main><p>${text}</p></main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
