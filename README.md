# Voice Agent Demo

A tiny browser-based voice agent demo built on the OpenAI Realtime API.

## What it does

- Captures microphone audio in the browser.
- Creates a WebRTC peer connection to the OpenAI Realtime API through a local Node server.
- Streams the assistant audio back into the page.
- Shows a live transcript and a raw event feed for debugging.

## Requirements

- Node.js 18.18 or newer
- An `OPENAI_API_KEY`
- Microphone access in a secure browser context such as `localhost`

## Setup

Set the environment variables you want to use:

- `OPENAI_API_KEY` - required
- `OPENAI_REALTIME_MODEL` - defaults to `gpt-realtime-2`
- `OPENAI_REALTIME_VOICE` - defaults to `alloy`
- `OPENAI_REALTIME_INSTRUCTIONS` - defaults to a Russian-only dental appointment booking assistant
- `OPENAI_SAFETY_IDENTIFIER` - optional stable user identifier for the OpenAI header
- `PORT` - defaults to `3000`
- `HOST` - defaults to `0.0.0.0`

Then start the server:

```bash
npm start
```

Open the local URL the server prints, allow microphone access, and click Connect.

## Docker

The repo includes a `Dockerfile` for Railway and other container platforms.

Build locally:

```bash
docker build -t demo_voice_agent .
```

Run locally:

```bash
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=your_key demo_voice_agent
```

Railway can deploy the repository directly from the `Dockerfile`. Set `OPENAI_API_KEY` in the service variables and let Railway assign `PORT`.

## Notes

- The browser sends its SDP offer to the local server.
- The server forwards that offer to `POST /v1/realtime/calls` with your server-side API key.
- The OpenAI API key never reaches the browser.
- The agent responds in Russian by default and stays within the dental appointment booking scenario.
- If you want to change the agent behavior, edit the instruction box in the UI before connecting.
